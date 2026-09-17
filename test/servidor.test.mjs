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
const LIVRES = ['PETR4', 'MGLU3', 'VALE3', 'ITUB4'];
const brapiFalso = createServer((pedido, resposta) => {
  const url = new URL(pedido.url, 'http://local');
  pedidosRecebidos.push({ url: pedido.url, autorizacao: pedido.headers.authorization || null });
  const tickers = url.pathname.split('/').pop().split(',');
  if (url.searchParams.has('modules')) {
    resposta.writeHead(403).end('{}');
    return;
  }
  // Como a brapi real: fora dos tickers livres, sem token é 401.
  const temToken = url.searchParams.has('token') || !!pedido.headers.authorization;
  if (!temToken && tickers.some((t) => !LIVRES.includes(t))) {
    resposta.writeHead(401).end('{}');
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

// Segundo servidor, sem token nenhum: reproduz o `npm start` sem BRAPI_TOKEN.
const portaSemToken = 8900;
const servidorSemToken = spawn(process.execPath, ['tools/servidor.mjs', '--porta', String(portaSemToken)], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, BRAPI_BASE: baseFalsa, BRAPI_TOKEN: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const logSemToken = [];
servidorSemToken.stdout.on('data', (d) => logSemToken.push(String(d)));
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://127.0.0.1:${portaSemToken}/api/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 100));
}

const url = (caminho) => `http://127.0.0.1:${porta}${caminho}`;
const urlSemToken = (caminho) => `http://127.0.0.1:${portaSemToken}${caminho}`;

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
  console.log('servidor local — servidor sem BRAPI_TOKEN (caso do usuário)');

  await teste('/api/health avisa que não tem token', async () => {
    const corpo = await (await fetch(urlSemToken('/api/health'))).json();
    assert.equal(corpo.servico, 'preco-teto');
    assert.equal(corpo.comToken, false);
  });

  await teste('sem token nenhum, ticker não-livre falha com aviso claro', async () => {
    const corpo = await (await fetch(urlSemToken('/api/cotacoes?tickers=BBAS3'))).json();
    assert.deepEqual(corpo.dados, {});
    assert.match(corpo.erros.BBAS3, /[Tt]oken/);
    assert.ok(corpo.avisos.some((a) => /sem BRAPI_TOKEN e sem token no app/.test(a)), JSON.stringify(corpo.avisos));
  });

  await teste('token vindo do app é usado e a cotação chega', async () => {
    const corpo = await (await fetch(urlSemToken('/api/cotacoes?tickers=BBAS3&token=TOKEN-DO-APP'))).json();
    assert.equal(corpo.dados.BBAS3.preco, 42.5, 'com o token do app a consulta precisa funcionar');
    assert.ok(corpo.avisos.some((a) => /token digitado no app/.test(a)), JSON.stringify(corpo.avisos));
  });

  await teste('ticker livre funciona mesmo sem token algum', async () => {
    const corpo = await (await fetch(urlSemToken('/api/cotacoes?tickers=PETR4'))).json();
    assert.equal(corpo.dados.PETR4.preco, 42.5);
  });

  await teste('o token do app não é registrado no log do servidor', async () => {
    await fetch(urlSemToken('/api/cotacoes?tickers=VIVT3&token=NAO-LOGAR-ISSO'));
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(!logSemToken.join('').includes('NAO-LOGAR-ISSO'), `log não deve conter o token: ${logSemToken.join('')}`);
  });

  await teste('token do servidor tem precedência sobre o do app', async () => {
    pedidosRecebidos.length = 0;
    await fetch(url('/api/cotacoes?tickers=CPLE6&token=TOKEN-DO-APP'));
    const usouDoServidor = pedidosRecebidos.some((p) => p.url.includes(TOKEN));
    const usouDoApp = pedidosRecebidos.some((p) => p.url.includes('TOKEN-DO-APP'));
    assert.ok(usouDoServidor && !usouDoApp, 'deve usar o BRAPI_TOKEN do servidor');
  });
} finally {
  servidor.kill();
  servidorSemToken.kill();
  brapiFalso.close();
}

console.log(falhas ? `\n${falhas} teste(s) do servidor falharam` : '\nTodos os testes do servidor passaram');
process.exit(falhas ? 1 : 0);
