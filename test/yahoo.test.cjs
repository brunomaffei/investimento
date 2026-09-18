const assert = require('node:assert/strict');
const { buscarResumo, paraSimboloYahoo, eventosDeProventos, ErroYahoo, BASE_YAHOO } = require('../assets/yahoo.js');
const { paraMilissegundos } = require('../assets/proventos.js');

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

function fetchFalso(responder) {
  const chamadas = [];
  const impl = async (url, opcoes = {}) => {
    chamadas.push({ url, headers: opcoes.headers || {} });
    return responder(url, opcoes);
  };
  impl.chamadas = chamadas;
  return impl;
}
const agora = Math.floor(Date.now() / 1000);
const resposta = (corpo) => ({ ok: true, status: 200, json: async () => corpo });
const grafico = (extras = {}) => resposta({ chart: { error: null, result: [{
  meta: { regularMarketPrice: 22.65, currency: 'BRL', longName: 'Banco do Brasil S.A.' },
  events: { dividends: {
    [agora]: { amount: 0.4, date: agora },
    [agora - 500]: { amount: 0.35, date: agora - 500 },
  } },
  ...extras,
}] } });
const perto = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `esperado ${b}, veio ${a}`);

(async () => {
  console.log('símbolo e URL');

  await teste('acrescenta o sufixo .SA dos papéis da B3', () => {
    assert.equal(paraSimboloYahoo('bbas3'), 'BBAS3.SA');
    assert.equal(paraSimboloYahoo('TAEE11'), 'TAEE11.SA');
    assert.equal(paraSimboloYahoo('PETR4.SA'), 'PETR4.SA', 'quem já tem sufixo é respeitado');
  });

  await teste('monta a URL com events=div e intervalo de 1 ano', async () => {
    const http = fetchFalso(() => grafico());
    await buscarResumo('BBAS3', { fetchImpl: http });
    assert.equal(http.chamadas[0].url, `${BASE_YAHOO}/BBAS3.SA?interval=1d&range=1y&events=div`);
    assert.match(http.chamadas[0].headers['User-Agent'], /Mozilla/, 'o endpoint recusa cliente sem User-Agent');
  });

  await teste('não exige token: nenhuma credencial é enviada', async () => {
    const http = fetchFalso(() => grafico());
    await buscarResumo('BBAS3', { fetchImpl: http });
    const cabecalhos = Object.keys(http.chamadas[0].headers).map((k) => k.toLowerCase());
    assert.ok(!cabecalhos.includes('authorization'), 'não há header de autorização');
    assert.ok(!http.chamadas[0].url.includes('token'), 'nem token na URL');
  });

  console.log('proventos');

  await teste('soma os proventos do período e devolve preço e nome', async () => {
    const r = await buscarResumo('BBAS3', { fetchImpl: fetchFalso(() => grafico()) });
    perto(r.dpa12m, 0.75);
    assert.equal(r.eventos, 2);
    assert.equal(r.preco, 22.65);
    assert.equal(r.moeda, 'BRL');
    assert.equal(r.nome, 'Banco do Brasil S.A.');
  });

  await teste('epoch em segundos é interpretado (provento antigo fica fora)', async () => {
    const http = fetchFalso(() => resposta({ chart: { error: null, result: [{
      meta: { regularMarketPrice: 10 },
      events: { dividends: { [agora]: { amount: 0.5, date: agora }, 1500000000: { amount: 9, date: 1500000000 } } },
    }] } }));
    const r = await buscarResumo('BBAS3', { fetchImpl: http });
    perto(r.dpa12m, 0.5);
    assert.equal(r.eventos, 1, 'o evento de 2017 não pode entrar');
  });

  await teste('paraMilissegundos entende segundos, milissegundos e ISO', () => {
    assert.equal(paraMilissegundos(1717027200), 1717027200000);
    assert.equal(paraMilissegundos(1717027200000), 1717027200000);
    assert.equal(paraMilissegundos('2026-03-10'), Date.parse('2026-03-10'));
    assert.ok(Number.isNaN(paraMilissegundos('sem data')));
    assert.ok(Number.isNaN(paraMilissegundos(0)));
  });

  await teste('ativo sem proventos devolve null, não zero', async () => {
    const http = fetchFalso(() => resposta({ chart: { error: null, result: [{ meta: { regularMarketPrice: 5 } }] } }));
    const r = await buscarResumo('XPTO3', { fetchImpl: http });
    assert.equal(r.dpa12m, null);
    assert.equal(r.preco, 5);
  });

  await teste('aceita a lista de proventos como array', () => {
    assert.equal(eventosDeProventos({ events: { dividends: [{ amount: 1 }] } }).length, 1);
    assert.equal(eventosDeProventos({}).length, 0);
  });

  console.log('erros');

  await teste('404 vira ErroYahoo com mensagem própria', async () => {
    const http = fetchFalso(() => ({ ok: false, status: 404 }));
    await assert.rejects(
      buscarResumo('NAOEXISTE3', { fetchImpl: http }),
      (e) => e instanceof ErroYahoo && e.status === 404 && /não encontrado no Yahoo/.test(e.message),
    );
  });

  await teste('erro descrito pela própria API é repassado', async () => {
    const http = fetchFalso(() => resposta({ chart: { error: { code: 'Not Found', description: 'No data found' } } }));
    await assert.rejects(buscarResumo('XPTO3', { fetchImpl: http }), (e) => /No data found/.test(e.message));
  });

  await teste('corpo inválido e queda de rede têm códigos próprios', async () => {
    const semJson = fetchFalso(() => ({ ok: true, status: 200, json: async () => { throw new Error('x'); } }));
    await assert.rejects(buscarResumo('BBAS3', { fetchImpl: semJson }), (e) => e.codigo === 'corpo-invalido');
    const offline = fetchFalso(() => { throw new Error('offline'); });
    await assert.rejects(buscarResumo('BBAS3', { fetchImpl: offline }), (e) => e.codigo === 'rede');
  });

  await teste('resposta sem resultado é reportada', async () => {
    const http = fetchFalso(() => resposta({ chart: { error: null, result: [] } }));
    await assert.rejects(buscarResumo('BBAS3', { fetchImpl: http }), (e) => e.codigo === 'sem-resultado');
  });

  await teste('ticker vazio não gasta requisição', async () => {
    const http = fetchFalso(() => grafico());
    await assert.rejects(buscarResumo('  ', { fetchImpl: http }), (e) => e.codigo === 'sem-ticker');
    assert.equal(http.chamadas.length, 0);
  });

  console.log(falhas ? `\n${falhas} teste(s) do Yahoo falharam` : '\nTodos os testes do Yahoo passaram');
  process.exit(falhas ? 1 : 0);
})();
