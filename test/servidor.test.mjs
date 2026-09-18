/**
 * Testes do servidor local: entrega dos arquivos, proxy da brapi e sigilo do token.
 * Um "brapi falso" sobe em memória e o servidor é apontado para ele via BRAPI_BASE,
 * então nada aqui depende de internet.
 */
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { subirServidor } from './ajuda.mjs';

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
  // Ticker que só existe na outra versão da API (caso real do CPLE6).
  if (tickers.includes('CPLE6')) {
    resposta.writeHead(404).end('{}');
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
const { porta, processo: servidor } = await subirServidor(['--token', TOKEN], { BRAPI_BASE: baseFalsa });

// Segundo servidor, sem token nenhum: reproduz o `npm start` sem BRAPI_TOKEN.
const { porta: portaSemToken, processo: servidorSemToken, log: logSemToken } =
  await subirServidor([], { BRAPI_BASE: baseFalsa, BRAPI_TOKEN: '' });

// API v2 falsa: envelope results[0].data e exige Authorization: Bearer
const pedidosV2 = [];
let v2Quebrada = false;
const hojeISO = new Date().toISOString();
let dividendosNegados = false;
const brapiV2Falsa = createServer((pedido, resposta) => {
  pedidosV2.push({ url: pedido.url, autorizacao: pedido.headers.authorization || null });
  if (v2Quebrada) return resposta.writeHead(500).end('{}');
  const url = new URL(pedido.url, 'http://local');
  const symbols = (url.searchParams.get('symbols') || '').split(',');
  // Recusa antes de escrever o cabeçalho de sucesso.
  if (dividendosNegados && url.pathname.endsWith('/dividends')) {
    return resposta.writeHead(403).end('{}');
  }
  resposta.writeHead(200, { 'Content-Type': 'application/json' });

  if (url.pathname.endsWith('/dividends')) {
    // FII responde pela rota /fii; ação, pela /stocks.
    const ehRotaFii = url.pathname.includes('/fii/');
    const eventos = symbols.flatMap((s) => {
      const ehFii = s.endsWith('11') && s.startsWith('X');
      if (ehFii !== ehRotaFii) return [];
      return ehFii
        ? [{ paymentDate: hojeISO, rate: 0.09 }, { paymentDate: hojeISO, rate: 0.09 }]
        : [{ paymentDate: hojeISO, rate: 2.5 }, { paymentDate: '2015-01-01', rate: 90 }];
    });
    return resposta.end(JSON.stringify({ results: [{ data: { dividends: eventos } }] }));
  }

  return resposta.end(JSON.stringify({
    results: symbols.map((s) => ({ data: { symbol: s, regularMarketPrice: 77.7, longName: `${s} v2` } })),
  }));
});
brapiV2Falsa.listen(0);
await once(brapiV2Falsa, 'listening');
const baseV2Falsa = `http://127.0.0.1:${brapiV2Falsa.address().port}/api/v2/stocks`;

const { porta: portaV2, processo: servidorV2 } = await subirServidor(['--token', TOKEN], {
  BRAPI_BASE: baseFalsa,
  BRAPI_V2_BASE: baseV2Falsa,
});

const url = (caminho) => `http://127.0.0.1:${porta}${caminho}`;
const urlV2 = (caminho) => `http://127.0.0.1:${portaV2}${caminho}`;
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
    const corpo = await (await fetch(url('/api/cotacoes?tickers=SAPR11&fundamentos=1'))).json();
    assert.equal(corpo.dados.SAPR11.preco, 42.5, 'a cotação precisa chegar mesmo com 403 nos módulos');
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
  console.log('servidor local — API v2 da brapi');

  await teste('/api/health informa qual API está em uso', async () => {
    const corpo = await (await fetch(urlV2('/api/health'))).json();
    assert.match(corpo.apiBrapi, /^v2/);
  });

  await teste('cotação vem da v2 e o token vai no header Bearer', async () => {
    pedidosV2.length = 0;
    const corpo = await (await fetch(urlV2('/api/cotacoes?tickers=B3SA3,BBAS3'))).json();
    assert.equal(corpo.fonte, 'v2');
    assert.equal(corpo.dados.B3SA3.preco, 77.7, 'preço vem de results[].data');
    assert.equal(corpo.dados.BBAS3.nome, 'BBAS3 v2');
    assert.equal(pedidosV2.length, 1, 'uma chamada para os dois tickers');
    assert.equal(pedidosV2[0].autorizacao, `Bearer ${TOKEN}`);
    assert.ok(!pedidosV2[0].url.includes(TOKEN), 'token não vai na URL');
    assert.ok(pedidosV2[0].url.includes('symbols=B3SA3%2CBBAS3') || pedidosV2[0].url.includes('symbols=B3SA3,BBAS3'), pedidosV2[0].url);
  });

  await teste('o token da v2 não volta para o navegador', async () => {
    const texto = await (await fetch(urlV2('/api/cotacoes?tickers=B3SA3'))).text();
    assert.ok(!texto.includes(TOKEN));
  });

  await teste('v2 fora do ar cai para a v1 sem perder a cotação', async () => {
    v2Quebrada = true;
    try {
      const corpo = await (await fetch(urlV2('/api/cotacoes?tickers=TAEE11'))).json();
      assert.equal(corpo.fonte, 'v1', 'a fonte precisa ser reportada como v1');
      assert.equal(corpo.dados.TAEE11.preco, 42.5, 'preço vem da v1 falsa');
    } finally {
      v2Quebrada = false;
    }
  });

  await teste('pedido de fundamentos: cotação pela v1 (LPA na raiz), dividendos pela v2', async () => {
    pedidosV2.length = 0;
    const corpo = await (await fetch(urlV2('/api/cotacoes?tickers=SAPR11&fundamentos=1'))).json();
    assert.equal(corpo.fonte, 'v1', 'a cotação precisa vir da v1 para não perder o earningsPerShare da raiz');
    assert.equal(corpo.dados.SAPR11.preco, 42.5);
    assert.ok(!pedidosV2.some((p) => p.url.includes('/quote')), 'a v2 não é usada para cotação neste caso');
    assert.ok(pedidosV2.every((p) => p.url.includes('/dividends')), 'as chamadas à v2 aqui são só de dividendos');
  });

  console.log('servidor local — dividendos pela v2');

  await teste('ação: DPA de 12 meses vem de /v2/stocks/dividends', async () => {
    pedidosV2.length = 0;
    const corpo = await (await fetch(urlV2('/api/cotacoes?tickers=BBAS3&fundamentos=1'))).json();
    assert.equal(corpo.dados.BBAS3.dpa12m, 2.5, 'evento de 2015 não pode entrar na soma');
    assert.equal(corpo.dados.BBAS3.fonteProventos, 'brapi stocks');
    assert.ok(pedidosV2.some((p) => p.url.includes('/stocks/dividends?symbols=BBAS3')), JSON.stringify(pedidosV2));
    assert.ok(pedidosV2.every((p) => p.autorizacao === `Bearer ${TOKEN}`), 'dividendos também autenticam por header');
  });

  await teste('FII: cai para /v2/fii/dividends quando a rota de ações não tem evento', async () => {
    pedidosV2.length = 0;
    const corpo = await (await fetch(urlV2('/api/cotacoes?tickers=XPLG11&fundamentos=1'))).json();
    assert.ok(Math.abs(corpo.dados.XPLG11.dpa12m - 0.18) < 1e-9, `esperado 0,18 e veio ${corpo.dados.XPLG11.dpa12m}`);
    assert.equal(corpo.dados.XPLG11.fonteProventos, 'brapi fii');
    assert.ok(pedidosV2.some((p) => p.url.includes('/fii/dividends')), JSON.stringify(pedidosV2));
  });

  await teste('sem pedir fundamentos, nenhuma consulta de dividendos é feita', async () => {
    pedidosV2.length = 0;
    await fetch(urlV2('/api/cotacoes?tickers=BBAS3'));
    assert.ok(!pedidosV2.some((p) => p.url.includes('/dividends')), 'dividendos só quando pedidos');
  });

  console.log('servidor local — recuperação entre versões da API');

  await teste('ticker com 404 na v1 é buscado na v2 e entra na lista', async () => {
    const corpo = await (await fetch(urlV2('/api/cotacoes?tickers=BBAS3,CPLE6&fundamentos=1'))).json();
    assert.equal(corpo.fonte, 'v1', 'a consulta principal é a v1 quando se pede fundamentos');
    assert.equal(corpo.dados.CPLE6.preco, 77.7, 'CPLE6 precisa vir pela v2');
    assert.equal(corpo.erros.CPLE6, undefined, 'e sair da lista de erros');
    assert.ok(corpo.avisos.some((a) => /CPLE6 não veio na v1 e foi buscado na v2/.test(a)), JSON.stringify(corpo.avisos));
  });

  await teste('quando as duas versões falham, o erro cita as duas', async () => {
    // A v2 falsa responde tudo; para simular a falha nas duas, derrubamos a v2.
    v2Quebrada = true;
    try {
      const corpo = await (await fetch(urlV2('/api/cotacoes?tickers=CPLE6&fundamentos=1'))).json();
      assert.equal(corpo.dados.CPLE6, undefined);
      assert.match(corpo.erros.CPLE6, /não encontrado/i, 'mantém o motivo da fonte principal');
      assert.match(corpo.erros.CPLE6, /Na v2:/, 'e acrescenta o que a outra versão respondeu');
    } finally {
      v2Quebrada = false;
    }
  });

  await teste('sem a outra versão configurada, o erro do ticker é preservado', async () => {
    // Este servidor não tem BRAPI_V2_BASE: a tentativa de recuperação falha e o
    // ticker precisa continuar reportado, em vez de sumir da lista de erros.
    const corpo = await (await fetch(url('/api/cotacoes?tickers=CPLE6&fundamentos=1'))).json();
    assert.equal(corpo.dados.CPLE6, undefined);
    assert.match(corpo.erros.CPLE6, /não encontrado/i, 'o 404 do ticker é mais informativo que o 403 do módulo pago');
  });

  console.log('servidor local — plano sem direito a dividendos');

  await teste('403 em /dividends gera um aviso só e para de tentar', async () => {
    dividendosNegados = true;
    pedidosV2.length = 0;
    try {
      const corpo = await (await fetch(urlV2('/api/cotacoes?tickers=BBAS3,ITSA4,TAEE11,VIVT3&fundamentos=1'))).json();
      const sobrePlano = corpo.avisos.filter((a) => /não cobre a rota de dividendos/.test(a));
      assert.equal(sobrePlano.length, 1, `esperava um aviso, veio ${JSON.stringify(corpo.avisos)}`);
      const consultasDeDividendos = pedidosV2.filter((p) => p.url.includes('/dividends'));
      assert.equal(consultasDeDividendos.length, 1, 'após o primeiro 403, não se insiste nos demais');
      assert.equal(Object.keys(corpo.dados).length, 4, 'as cotações continuam chegando');
    } finally {
      dividendosNegados = false;
    }
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
  servidorV2.kill();
  brapiFalso.close();
  brapiV2Falsa.close();
}

console.log(falhas ? `\n${falhas} teste(s) do servidor falharam` : '\nTodos os testes do servidor passaram');
process.exit(falhas ? 1 : 0);
