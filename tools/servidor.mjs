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
 * Sem token, funciona nos tickers liberados pela brapi (PETR4, MGLU3, VALE3, ITUB4).
 * BRAPI_BASE troca a URL da API (usado pelos testes).
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buscarCotacoes, ASSINATURA_SERVIDOR, BASE } = require('../assets/quotes.js');

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
  };
}

const { porta, token, base } = lerArgumentos(process.argv);

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
    return json(resposta, 200, { servico: ASSINATURA_SERVIDOR, comToken: !!token });
  }

  if (url.pathname === '/api/cotacoes') {
    const tickers = (url.searchParams.get('tickers') || '').split(',').map((t) => t.trim()).filter(Boolean);
    if (!tickers.length) return json(resposta, 400, { erro: 'Informe ?tickers=PETR4,VALE3' });
    const fundamentos = ['1', 'true', 'sim'].includes(url.searchParams.get('fundamentos') || '');
    try {
      const resultado = await buscarCotacoes(tickers, { token, fundamentos, base });
      const avisos = [...(resultado.avisos || [])];
      if (!token) avisos.push('Servidor sem BRAPI_TOKEN: só os tickers liberados pela brapi respondem.');
      console.log(`[cotacoes] ${tickers.join(',')} -> ${Object.keys(resultado.dados).length} ok, ${Object.keys(resultado.erros).length} com erro`);
      return json(resposta, 200, { ...resultado, avisos });
    } catch (erro) {
      console.error('[cotacoes] falha:', erro.message);
      return json(resposta, 502, { erro: `Falha ao consultar a brapi: ${erro.message}` });
    }
  }

  return servirArquivo(url.pathname, resposta);
});

servidor.listen(porta, () => {
  console.log(`Preço-teto no ar: http://localhost:${porta}`);
  console.log(token ? 'Token da brapi carregado (fica no servidor, não vai ao navegador).' : 'Sem BRAPI_TOKEN: use --token ou a variável de ambiente para liberar todos os tickers.');
});
