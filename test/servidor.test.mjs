/**
 * Testes do servidor local: entrega dos arquivos, proxy da brapi e sigilo do token.
 * Um "brapi falso" sobe em memória e o servidor é apontado para ele via BRAPI_BASE,
 * então nada aqui depende de internet.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';

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

// ---- brapi falso -----------------------------------------------------------
const pedidosRecebidos = [];
const brapiFalso = createServer((pedido, resposta) => {
  const url = new URL(pedido.url, 'http://local');
  pedidosRecebidos.push({ url: pedido.url, autorizacao: pedido.headers.authorization || null });
  const tickers = url.pathname.split('/').pop().split(',');
  if (url.searchParams.has('modules')) {
    resposta.writeHead(403).end('{}');
    return;
  }
  resposta.writeHead(200, { 'Content-Type': 'application/json' });
  resposta.end(JSON.stringify({
    results: tickers.map((t) => ({ symbol: t, regularMarketPrice: 42.5, longName: `${t} SA` })),
  }));
});
brapiFalso.listen(0);
await once(brapiFalso, 'listening');
const baseFalsa = `http://127.0.0.1:${brapiFalso.address().port}/api/quote/`;

// ---- servidor do app -------------------------------------------------------
const TOKEN = 'TOKEN-SUPER-SECRETO';
const porta = 8899;
const servidor = spawn(process.execPath, ['tools/servidor.mjs', '--porta', String(porta), '--token', TOKEN], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, BRAPI_BASE: baseFalsa },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const saida = [];
servidor.stdout.on('data', (d) => saida.push(String(d)));
servidor.stderr.on('data', (d) => saida.push(String(d)));

const esperarServidor = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${porta}/api/health`);
      if (r.ok) return;
    } catch { /* ainda subindo */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`servidor não subiu. Saída: ${saida.join('')}`);
};
await esperarServidor();

const url = (caminho) => `http://127.0.0.1:${porta}${caminho}`;

try {
  console.log('servidor local — arquivos');

  await teste('serve o index.html na raiz', async () => {
    const r = await fetch(url('/'));
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(await r.text(), /preço-teto e margem de segurança/i);
  });

  await teste('serve os assets com o tipo correto', async () => {
    const js = await fetch(url('/assets/calc.js'));
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    const css = await fetch(url('/assets/styles.css'));
    assert.match(css.headers.get('content-type'), /text\/css/);
  });

  await teste('arquivo inexistente devolve 404', async () => {
    assert.equal((await fetch(url('/nao-existe.js'))).status, 404);
  });

  await teste('não serve arquivo fora da raiz do projeto', async () => {
    const r = await fetch(url('/../../etc/passwd'), { redirect: 'manual' });
    assert.ok([403, 404].includes(r.status), `esperado 403/404, veio ${r.status}`);
  });

  console.log('servidor local — API');

  await teste('/api/health identifica o serviço', async () => {
    const corpo = await (await fetch(url('/api/health'))).json();
    assert.equal(corpo.servico, 'preco-teto');
    assert.equal(corpo.comToken, true);
  });

  await teste('/api/cotacoes devolve dados normalizados', async () => {
    const corpo = await (await fetch(url('/api/cotacoes?tickers=TAEE11,BBAS3'))).json();
    assert.equal(corpo.dados.TAEE11.preco, 42.5);
    assert.equal(corpo.dados.BBAS3.nome, 'BBAS3 SA');
    assert.deepEqual(corpo.erros, {});
  });

  await teste('o token vai para a brapi e NÃO volta ao navegador', async () => {
    pedidosRecebidos.length = 0;
    const resposta = await fetch(url('/api/cotacoes?tickers=VIVT3'));
    const texto = await resposta.text();
    assert.ok(!texto.includes(TOKEN), 'o token não pode aparecer na resposta ao navegador');
    const foiParaBrapi = pedidosRecebidos.some((p) => p.url.includes(encodeURIComponent(TOKEN)) || p.url.includes(TOKEN));
    assert.ok(foiParaBrapi, 'o servidor precisa enviar o token para a brapi');
  });

  await teste('fundamentos recusados pelo plano não derrubam a cotação', async () => {
    const corpo = await (await fetch(url('/api/cotacoes?tickers=CPLE6&fundamentos=1'))).json();
    assert.equal(corpo.dados.CPLE6.preco, 42.5, 'a cotação precisa chegar mesmo com 403 nos módulos');
    assert.ok(corpo.avisos.some((a) => /plano/i.test(a)), `esperado aviso de plano, veio ${JSON.stringify(corpo.avisos)}`);
  });

  await teste('sem tickers, responde 400', async () => {
    const r = await fetch(url('/api/cotacoes'));
    assert.equal(r.status, 400);
    assert.match((await r.json()).erro, /tickers/);
  });

  await teste('nenhum endpoint aceita POST', async () => {
    assert.equal((await fetch(url('/api/cotacoes?tickers=X'), { method: 'POST' })).status, 405);
    assert.equal((await fetch(url('/api/health'), { method: 'POST' })).status, 405);
    assert.equal((await fetch(url('/index.html'), { method: 'POST' })).status, 405);
  });

  await teste('respostas da API não são cacheadas', async () => {
    const r = await fetch(url('/api/cotacoes?tickers=ITSA4'));
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });
} finally {
  servidor.kill();
  brapiFalso.close();
}

console.log(falhas ? `\n${falhas} teste(s) do servidor falharam` : '\nTodos os testes do servidor passaram');
process.exit(falhas ? 1 : 0);
