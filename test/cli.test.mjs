/**
 * Testa os utilitários de linha de comando com servidores falsos.
 * Cobre em especial o parsing de argumentos: sem a flag de token/chave, o
 * primeiro argumento posicional era descartado por um erro de índice.
 */
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';

const executar = promisify(execFile);
const RAIZ = new URL('..', import.meta.url).pathname;

let falhas = 0;
async function teste(nome, fn) {
  try {
    await fn();
    console.log(`  ok   ${nome}`);
  } catch (erro) {
    falhas++;
    console.log(`  FALHA ${nome}\n        ${erro.message}`);
  }
}

// brapi falsa
const brapi = createServer((pedido, resposta) => {
  const tickers = new URL(pedido.url, 'http://l').pathname.split('/').pop().split(',');
  resposta.writeHead(200, { 'Content-Type': 'application/json' });
  resposta.end(JSON.stringify({ results: tickers.map((t) => ({ symbol: t, regularMarketPrice: 19.9 })) }));
});
brapi.listen(0);
await once(brapi, 'listening');
const BRAPI_BASE = `http://127.0.0.1:${brapi.address().port}/api/quote/`;

// brapi v2 falsa: quote responde, dividendos são de plano pago
const brapiV2 = createServer((pedido, resposta) => {
  const url = new URL(pedido.url, 'http://l');
  if (url.pathname.endsWith('/dividends')) return resposta.writeHead(403).end('{}');
  const symbols = (url.searchParams.get('symbols') || '').split(',');
  resposta.writeHead(200, { 'Content-Type': 'application/json' });
  resposta.end(JSON.stringify({ results: symbols.map((s) => ({ data: { symbol: s, regularMarketPrice: 31.5 } })) }));
});
brapiV2.listen(0);
await once(brapiV2, 'listening');
const BRAPI_V2_BASE = `http://127.0.0.1:${brapiV2.address().port}/api/v2/stocks`;

// bolsai falsa
const bolsai = createServer((pedido, resposta) => {
  if (pedido.headers['x-api-key'] !== 'CHAVE') return resposta.writeHead(401).end('{}');
  resposta.writeHead(200, { 'Content-Type': 'application/json' });
  if (pedido.url.includes('/fundamentals/')) return resposta.end(JSON.stringify({ lpa: 7.77, pl: 4.2 }));
  return resposta.end(JSON.stringify({ dividends: [{ ex_date: new Date().toISOString(), value: 1.5 }] }));
});
bolsai.listen(0);
await once(bolsai, 'listening');
const BOLSAI_BASE = `http://127.0.0.1:${bolsai.address().port}/api/v1`;

const pasta = await mkdtemp(join(tmpdir(), 'preco-teto-'));

try {
  console.log('atualizar-cotacoes.mjs');

  await teste('atualiza a carteira com o token vindo do ambiente (sem flag)', async () => {
    const arquivo = join(pasta, 'carteira.json');
    await writeFile(arquivo, JSON.stringify({
      config: {}, ativos: [{ id: 'x', ticker: 'TAEE11', modo: 'lpa' }, { id: 'y', ticker: 'EXEMPLO' }],
    }));
    const { stdout } = await executar(process.execPath, ['tools/atualizar-cotacoes.mjs', arquivo], {
      cwd: RAIZ, env: { ...process.env, BRAPI_BASE, BRAPI_TOKEN: 'do-ambiente' },
    });
    assert.match(stdout, /1 ativo\(s\) atualizados/);
    const salvo = JSON.parse(await readFile(arquivo, 'utf8'));
    assert.equal(salvo.ativos[0].cotacao, '19,90');
    assert.ok(salvo.ativos[0].cotacaoAtualizadaEm, 'carimba a data da atualização');
    assert.equal(salvo.ativos[1].cotacao, undefined, 'ticker fora do padrão da B3 é ignorado');
  });

  await teste('aceita o token por flag, com o arquivo depois', async () => {
    const arquivo = join(pasta, 'carteira2.json');
    await writeFile(arquivo, JSON.stringify({ config: {}, ativos: [{ id: 'x', ticker: 'BBAS3' }] }));
    const { stdout } = await executar(process.execPath, ['tools/atualizar-cotacoes.mjs', '--token', 'abc', arquivo], {
      cwd: RAIZ, env: { ...process.env, BRAPI_BASE, BRAPI_TOKEN: '' },
    });
    assert.match(stdout, /BBAS3/);
    assert.equal(JSON.parse(await readFile(arquivo, 'utf8')).ativos[0].cotacao, '19,90');
  });

  await teste('arquivo inválido falha com mensagem clara', async () => {
    const arquivo = join(pasta, 'ruim.json');
    await writeFile(arquivo, JSON.stringify({ nada: true }));
    await assert.rejects(
      executar(process.execPath, ['tools/atualizar-cotacoes.mjs', arquivo], { cwd: RAIZ, env: { ...process.env, BRAPI_BASE } }),
      (erro) => /falta a lista "ativos"/.test(erro.stderr),
    );
  });

  await teste('sem argumento, mostra o uso e sai com erro', async () => {
    await assert.rejects(
      executar(process.execPath, ['tools/atualizar-cotacoes.mjs'], { cwd: RAIZ }),
      (erro) => /Uso: node tools\/atualizar-cotacoes\.mjs/.test(erro.stderr),
    );
  });

  console.log('testar-ticker.mjs');

  await teste('mostra o que cada rota responde para um ticker', async () => {
    const { stdout } = await executar(process.execPath, ['tools/testar-ticker.mjs', 'CPLE6'], {
      cwd: RAIZ,
      env: { ...process.env, BRAPI_BASE, BRAPI_V2_BASE, BRAPI_TOKEN: 'TOKEN-DO-AMBIENTE' },
    });
    assert.match(stdout, /Investigando CPLE6 \(com token\)/);
    assert.match(stdout, /v1: cotação\s+preço 19\.9/, 'a v1 falsa responde com preço');
    assert.match(stdout, /v2: cotação\s+preço 31\.5/, 'a v2 falsa também');
    assert.match(stdout, /v2: dividendos \(ações\)\s+HTTP 403/, 'a rota paga é reportada como 403');
    assert.ok(!stdout.includes('TOKEN-DO-AMBIENTE'), 'o token não pode ser impresso');
  });

  await teste('401 em todas as rotas é diagnosticado como problema de token', async () => {
    // Servidor que recusa tudo, como a brapi faz com chave inválida.
    const recusaTudo = createServer((pedido, resposta) => {
      // O ticker livre sem token responde, para servir de controle.
      if (pedido.url.includes('PETR4') && !pedido.url.includes('token=')) {
        resposta.writeHead(200, { 'Content-Type': 'application/json' });
        return resposta.end(JSON.stringify({ results: [{ symbol: 'PETR4', regularMarketPrice: 48.5 }] }));
      }
      return resposta.writeHead(401).end('{}');
    });
    recusaTudo.listen(0);
    await once(recusaTudo, 'listening');
    const porta = recusaTudo.address().port;
    try {
      const { stdout } = await executar(process.execPath, ['tools/testar-ticker.mjs', 'CPLE6'], {
        cwd: RAIZ,
        env: {
          ...process.env,
          BRAPI_BASE: `http://127.0.0.1:${porta}/api/quote/`,
          BRAPI_V2_BASE: `http://127.0.0.1:${porta}/api/v2/stocks`,
          BRAPI_TOKEN: 'chave-invalida',
        },
      });
      assert.match(stdout, /Todas as rotas recusaram com 401/);
      assert.match(stdout, /PETR4 sem token \(controle\)\s+preço 48\.5/, 'o controle prova que a API responde');
      assert.match(stdout, /o problema é o token, não o ticker/);
    } finally {
      recusaTudo.close();
    }
  });

  await teste('token com cara de exemplo é apontado antes dos testes', async () => {
    const { stdout } = await executar(process.execPath, ['tools/testar-ticker.mjs', 'CPLE6'], {
      cwd: RAIZ,
      env: { ...process.env, BRAPI_BASE, BRAPI_V2_BASE, BRAPI_TOKEN: 'seu_token' },
    });
    assert.match(stdout, /parece o texto de exemplo/);
  });

  await teste('sem ticker, mostra o uso', async () => {
    await assert.rejects(
      executar(process.execPath, ['tools/testar-ticker.mjs'], { cwd: RAIZ }),
      (erro) => /Uso: BRAPI_TOKEN=/.test(erro.stderr),
    );
  });

  console.log('inspecionar-bolsai.mjs');

  await teste('inspeciona um ticker com a chave do ambiente (sem flag)', async () => {
    const { stdout } = await executar(process.execPath, ['tools/inspecionar-bolsai.mjs', 'BBAS3'], {
      cwd: RAIZ, env: { ...process.env, BOLSAI_BASE, BOLSAI_KEY: 'CHAVE' },
    });
    assert.match(stdout, /LPA reconhecido: 7\.77 \(campo "lpa"\)/);
    assert.match(stdout, /1 evento\(s\) nos últimos 12 meses somando R\$ 1\.5/);
    assert.ok(!stdout.includes('CHAVE'), 'a chave não é impressa');
  });

  await teste('chave errada devolve 401 legível', async () => {
    await assert.rejects(
      executar(process.execPath, ['tools/inspecionar-bolsai.mjs', 'BBAS3', '--chave', 'errada'], {
        cwd: RAIZ, env: { ...process.env, BOLSAI_BASE, BOLSAI_KEY: '' },
      }),
      (erro) => /HTTP 401/.test(erro.stdout),
    );
  });

  await teste('sem chave, orienta onde pegar uma', async () => {
    await assert.rejects(
      executar(process.execPath, ['tools/inspecionar-bolsai.mjs', 'BBAS3'], {
        cwd: RAIZ, env: { ...process.env, BOLSAI_BASE, BOLSAI_KEY: '' },
      }),
      (erro) => /usebolsai\.com/.test(erro.stderr),
    );
  });
} finally {
  brapi.close();
  brapiV2.close();
  bolsai.close();
}

console.log(falhas ? `\n${falhas} teste(s) de CLI falharam` : '\nTodos os testes de CLI passaram');
process.exit(falhas ? 1 : 0);
