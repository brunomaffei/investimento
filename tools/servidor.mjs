#!/usr/bin/env node
/**
 * Servidor local do app: entrega os arquivos estáticos e consulta a brapi do lado
 * do servidor. Resolve os dois motivos de "não atualiza" no navegador:
 *
 *   - CORS / sandbox: a chamada à brapi sai do Node, não do navegador;
 *   - token exposto: fica na variável de ambiente, nunca chega ao navegador.
 *
 *   BRAPI_TOKEN=seu_token node tools/servidor.mjs        # http://localhost:8787
 *   node tools/servidor.mjs --porta 3000 --token abc
 *
 * Fundamentos (LPA e proventos de 12 meses) vêm da bolsai quando BOLSAI_KEY
 * estiver definida — o plano gratuito dela cobre esses dados, o da brapi não.
 * Sem BOLSAI_KEY, cai nos módulos da brapi (que exigem plano pago).
 *
 * Sem token, funciona nos tickers liberados pela brapi (PETR4, MGLU3, VALE3, ITUB4).
 * Se o servidor subir sem token, ele aceita o token que o app manda em ?token= —
 * é a mesma máquina, e evita que o token digitado na tela seja ignorado. O token
 * nunca é registrado no log.
 * BRAPI_BASE troca a URL da API (usado pelos testes).
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buscarCotacoes, normalizar, ASSINATURA_SERVIDOR, BASE } = require('../assets/quotes.js');
const { buscarFundamentos, BASE: BASE_BOLSAI } = require('../assets/bolsai.js');
const { buscarCotacoes: buscarCotacoesV2, buscarProventos12m, BASE_V2 } = require('../assets/brapi-v2.js');

/**
 * Lê a versão do código servido direto do .git, sem depender do git instalado.
 * Serve para responder "estou rodando a versão nova?" sem adivinhação.
 */
async function versaoDoGit(raiz) {
  const ler = (...partes) => readFile(join(raiz, ...partes), 'utf8');
  try {
    const head = (await ler('.git', 'HEAD')).trim();
    if (!head.startsWith('ref:')) return { sha: head.slice(0, 7), branch: null };
    const ref = head.slice(4).trim();
    const branch = ref.replace('refs/heads/', '');
    try {
      return { sha: (await ler('.git', ref)).trim().slice(0, 7), branch };
    } catch {
      // Referência empacotada em .git/packed-refs
      const empacotadas = await ler('.git', 'packed-refs');
      const linha = empacotadas.split('\n').find((l) => l.endsWith(` ${ref}`));
      return { sha: linha ? linha.split(' ')[0].slice(0, 7) : null, branch };
    }
  } catch {
    return null;
  }
}

const RAIZ = resolve(new URL('..', import.meta.url).pathname);
const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function lerArgumentos(argv) {
  const args = argv.slice(2);
  const valor = (nome) => {
    const i = args.indexOf(nome);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return {
    porta: Number(valor('--porta') || process.env.PORT || 8787),
    token: valor('--token') || process.env.BRAPI_TOKEN || '',
    base: process.env.BRAPI_BASE || BASE,
    chaveBolsai: valor('--bolsai') || process.env.BOLSAI_KEY || '',
    baseBolsai: process.env.BOLSAI_BASE || BASE_BOLSAI,
    baseV2: process.env.BRAPI_V2_BASE || BASE_V2,
    // BRAPI_V2=0 desliga a v2 e usa apenas a v1.
    usarV2: process.env.BRAPI_V2 !== '0',
  };
}

const { porta, token, base, chaveBolsai, baseBolsai, baseV2, usarV2 } = lerArgumentos(process.argv);

/**
 * Cotações pela API v2 (rota /quote?symbols=…, token no header Bearer), caindo
 * para a v1 quando a v2 falha. O formato devolvido é o mesmo nos dois casos.
 * @param {string[]} tickers
 * @param {string} tokenEmUso
 * @param {boolean} fundamentosNaBrapi
 * @returns {Promise<{dados: Object, erros: Object, avisos: string[], fonte: string}>}
 */
/**
 * Tickers que a fonte principal não trouxe ganham uma tentativa na outra versão
 * da API: acontece de um papel existir numa e não na outra (404 na v1, ok na v2).
 * @returns {Promise<string[]>} os tickers recuperados.
 */
async function recuperarFaltantes(resultado, tokenEmUso) {
  const faltantes = Object.keys(resultado.erros || {});
  if (!faltantes.length) return [];
  const recuperados = [];

  const outra = resultado.fonte === 'v1' ? 'v2' : 'v1';

  for (const ticker of faltantes) {
    try {
      if (resultado.fonte === 'v1') {
        const { dados } = await buscarCotacoesV2([ticker], { token: tokenEmUso, base: baseV2 });
        const bruto = dados[ticker];
        if (!bruto) {
          resultado.erros[ticker] = `${resultado.erros[ticker]} A ${outra} também não retornou este ticker.`;
          continue;
        }
        resultado.dados[ticker] = normalizar({ ...bruto, symbol: ticker });
      } else {
        const alternativa = await buscarCotacoes([ticker], { token: tokenEmUso, fundamentos: false, base });
        const info = alternativa.dados[ticker];
        if (!info) {
          resultado.erros[ticker] = `${resultado.erros[ticker]} A ${outra} também não retornou este ticker.`;
          continue;
        }
        resultado.dados[ticker] = info;
      }
      delete resultado.erros[ticker];
      recuperados.push(ticker);
    } catch (erro) {
      // Dizer o que a outra versão respondeu evita a impressão de que nada foi tentado.
      resultado.erros[ticker] = `${resultado.erros[ticker]} Na ${outra}: ${erro.message}`;
    }
  }
  return recuperados;
}

async function consultarCotacoes(tickers, tokenEmUso, fundamentosNaBrapi) {
  // Quando se pede fundamentos pela brapi, vale a v1: a resposta comum dela traz
  // earningsPerShare na raiz (LPA sem plano pago). Trocar pela v2 aqui poderia
  // perder esse campo, então a v2 fica para a consulta de cotação pura.
  if (usarV2 && !fundamentosNaBrapi) {
    try {
      const { dados, faltando, erros: errosV2, avisos } = await buscarCotacoesV2(tickers, { token: tokenEmUso, base: baseV2 });
      const normalizados = {};
      for (const [ticker, bruto] of Object.entries(dados)) {
        normalizados[ticker] = normalizar({ ...bruto, symbol: ticker });
      }
      const erros = { ...errosV2 };
      for (const t of faltando) {
        if (!erros[t]) erros[t] = 'A brapi (v2) não retornou este ticker.';
      }
      return { dados: normalizados, erros, avisos: avisos || [], fonte: 'v2' };
    } catch (erro) {
      console.log(`[cotacoes] v2 indisponível (${erro.message}); usando a v1.`);
      const resultado = await buscarCotacoes(tickers, { token: tokenEmUso, fundamentos: fundamentosNaBrapi, base });
      return { ...resultado, avisos: [...(resultado.avisos || [])], fonte: 'v1' };
    }
  }
  const resultado = await buscarCotacoes(tickers, { token: tokenEmUso, fundamentos: fundamentosNaBrapi, base });
  return { ...resultado, avisos: [...(resultado.avisos || [])], fonte: 'v1' };
}
const versao = await versaoDoGit(RAIZ);

const json = (resposta, codigo, corpo) => {
  const texto = JSON.stringify(corpo);
  resposta.writeHead(codigo, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(texto),
    'Cache-Control': 'no-store',
  });
  resposta.end(texto);
};

/** Serve um arquivo do repositório, barrando qualquer caminho que escape da raiz. */
async function servirArquivo(caminhoPedido, resposta) {
  const relativo = normalize(decodeURIComponent(caminhoPedido)).replace(/^(\.\.[/\\])+/, '');
  const arquivo = join(RAIZ, relativo === '/' || relativo === '.' ? 'index.html' : relativo);
  if (!resolve(arquivo).startsWith(RAIZ)) {
    resposta.writeHead(403).end('Acesso negado');
    return;
  }
  try {
    const info = await stat(arquivo);
    if (info.isDirectory()) return servirArquivo(join(relativo, 'index.html'), resposta);
    const conteudo = await readFile(arquivo);
    resposta.writeHead(200, {
      'Content-Type': TIPOS[extname(arquivo)] || 'application/octet-stream',
      'Content-Length': conteudo.length,
      'Cache-Control': 'no-store',
    });
    resposta.end(conteudo);
  } catch {
    resposta.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Arquivo não encontrado');
  }
}

const servidor = createServer(async (pedido, resposta) => {
  const url = new URL(pedido.url, `http://${pedido.headers.host || 'localhost'}`);

  // Tudo aqui é leitura: nenhum endpoint aceita outro método.
  if (pedido.method !== 'GET' && pedido.method !== 'HEAD') {
    return resposta.writeHead(405, { Allow: 'GET, HEAD' }).end('Método não permitido');
  }

  if (url.pathname === '/api/health') {
    // O app usa esta assinatura para saber que pode consultar pelo servidor.
    return json(resposta, 200, {
      servico: ASSINATURA_SERVIDOR,
      comToken: !!token,
      comBolsai: !!chaveBolsai,
      apiBrapi: usarV2 ? 'v2 (com queda para v1)' : 'v1',
      versao,
    });
  }

  if (url.pathname === '/api/cotacoes') {
    const tickers = (url.searchParams.get('tickers') || '').split(',').map((t) => t.trim()).filter(Boolean);
    if (!tickers.length) return json(resposta, 400, { erro: 'Informe ?tickers=PETR4,VALE3' });
    const fundamentos = ['1', 'true', 'sim'].includes(url.searchParams.get('fundamentos') || '');
    // O token do servidor tem precedência; o do app é reserva para quem esqueceu o BRAPI_TOKEN.
    const tokenDoApp = (url.searchParams.get('token') || '').trim().slice(0, 200);
    const tokenEmUso = token || tokenDoApp;
    try {
      // A brapi só é consultada com módulos quando não há bolsai para os fundamentos.
      const fundamentosNaBrapi = fundamentos && !chaveBolsai;
      const resultado = await consultarCotacoes(tickers, tokenEmUso, fundamentosNaBrapi);
      const avisos = [...(resultado.avisos || [])];

      const recuperados = await recuperarFaltantes(resultado, tokenEmUso);
      if (recuperados.length) {
        const outra = resultado.fonte === 'v1' ? 'v2' : 'v1';
        avisos.push(`${recuperados.join(', ')} não veio na ${resultado.fonte} e foi buscado na ${outra}.`);
      }

      // Sem bolsai, os proventos vêm da própria brapi: /v2/stocks/dividends para
      // ações e /v2/fii/dividends para FII (a função cai de uma rota para a outra).
      if (fundamentos && !chaveBolsai && usarV2) {
        let comProventos = 0;
        let planoSemProventos = false;
        const falhas = [];
        for (const [ticker, info] of Object.entries(resultado.dados)) {
          // Plano que recusa /dividends recusa para todos: não insistir ticker a ticker.
          if (planoSemProventos) break;
          try {
            const proventos = await buscarProventos12m(ticker, { token: tokenEmUso, base: baseV2 });
            if (proventos.dpa12m !== null) {
              info.dpa12m = proventos.dpa12m;
              info.fonteProventos = `brapi ${proventos.rota}`;
              comProventos++;
            }
          } catch (erro) {
            if ([401, 402, 403].includes(erro.status)) {
              planoSemProventos = true;
              avisos.push('Proventos não vieram: seu plano na brapi não cobre a rota de dividendos. Com BOLSAI_KEY no servidor, eles vêm da bolsai.');
            } else {
              falhas.push(ticker);
            }
          }
        }
        if (falhas.length) avisos.push(`Proventos não vieram para ${falhas.length} ativo(s): ${falhas.join(', ')}.`);
        if (comProventos) console.log(`[dividendos] ${comProventos} ativo(s) com provento de 12 meses`);
      }

      if (fundamentos && chaveBolsai) {
        const extras = await buscarFundamentos(Object.keys(resultado.dados), {
          chave: chaveBolsai,
          base: baseBolsai,
        });
        for (const [ticker, info] of Object.entries(extras.dados)) {
          const alvo = resultado.dados[ticker];
          if (!alvo) continue;
          if (info.lpa !== null) alvo.lpa = info.lpa;
          if (info.dpa12m !== null) alvo.dpa12m = info.dpa12m;
          alvo.fonteFundamentos = 'bolsai';
          alvo.origemFundamentos = info.origem;
          if (info.chavesRecebidas) alvo.chavesRecebidas = info.chavesRecebidas;
        }
        avisos.push(...extras.avisos);
        const falhas = Object.entries(extras.erros);
        if (falhas.length) {
          const motivos = [...new Set(falhas.map(([, m]) => m))].join(' ');
          avisos.push(`Fundamentos da bolsai não vieram para ${falhas.length} ticker(s): ${motivos}`);
        }
        const comLpa = Object.values(extras.dados).filter((d) => d.lpa !== null).length;
        console.log(`[bolsai] ${Object.keys(extras.dados).length} consultados, ${comLpa} com LPA`);
      }
      if (!tokenEmUso) {
        avisos.push('Servidor sem BRAPI_TOKEN e sem token no app: só os tickers liberados pela brapi respondem.');
      } else if (!token) {
        avisos.push('Usando o token digitado no app (o servidor subiu sem BRAPI_TOKEN).');
      }
      console.log(`[cotacoes] (${resultado.fonte}) ${tickers.join(',')} -> ${Object.keys(resultado.dados).length} ok, ${Object.keys(resultado.erros).length} com erro`);
      return json(resposta, 200, { ...resultado, avisos });
    } catch (erro) {
      console.error('[cotacoes] falha:', erro.message);
      return json(resposta, 502, { erro: `Falha ao consultar a brapi: ${erro.message}` });
    }
  }

  return servirArquivo(url.pathname, resposta);
});

servidor.listen(porta, () => {
  // Porta real: com --porta 0 o sistema escolhe uma livre (usado pelos testes).
  const escolhida = servidor.address().port;
  console.log(`Preço-teto no ar: http://localhost:${escolhida}`);
  if (versao?.sha) console.log(`Versão servida: ${versao.sha}${versao.branch ? ` (${versao.branch})` : ''}`);
  console.log(chaveBolsai
    ? 'Fundamentos (LPA e proventos) pela bolsai: chave carregada.'
    : 'Sem BOLSAI_KEY: LPA e dividendos dependeriam de plano pago na brapi. Pegue uma chave grátis em usebolsai.com.');
  console.log(token ? 'Token da brapi carregado (fica no servidor, não vai ao navegador).' : 'Sem BRAPI_TOKEN: use --token ou a variável de ambiente para liberar todos os tickers.');
});
