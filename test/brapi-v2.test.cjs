const assert = require('node:assert/strict');
const { buscarCotacao, buscarCotacoes, conteudo, mensagemDeErro, ErroBrapi, BASE_V2 } = require('../assets/brapi-v2.js');

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
const ok200 = (corpo) => ({ ok: true, status: 200, json: async () => corpo });
const envelope = (dados) => ok200({ results: dados.map((d) => ({ data: d })) });

(async () => {
  console.log('buscarCotacao — contrato da v2');

  await teste('monta a URL da v2 com symbols e devolve results[0].data', async () => {
    const http = fetchFalso(() => envelope([{ symbol: 'B3SA3', regularMarketPrice: 12.34 }]));
    const dados = await buscarCotacao('b3sa3', { token: 'T', fetchImpl: http });
    assert.equal(http.chamadas[0].url, `${BASE_V2}/quote?symbols=B3SA3`);
    assert.deepEqual(dados, { symbol: 'B3SA3', regularMarketPrice: 12.34 });
  });

  await teste('autentica pelo header Authorization: Bearer', async () => {
    const http = fetchFalso(() => envelope([{ symbol: 'B3SA3' }]));
    await buscarCotacao('B3SA3', { token: 'TOKEN-SECRETO', fetchImpl: http });
    assert.equal(http.chamadas[0].headers.Authorization, 'Bearer TOKEN-SECRETO');
  });

  await teste('o token não vai na URL', async () => {
    const http = fetchFalso(() => envelope([{ symbol: 'B3SA3' }]));
    await buscarCotacao('B3SA3', { token: 'TOKEN-SECRETO', fetchImpl: http });
    assert.ok(!http.chamadas[0].url.includes('TOKEN-SECRETO'), http.chamadas[0].url);
    assert.ok(!http.chamadas[0].url.includes('token='), http.chamadas[0].url);
  });

  await teste('sem token explícito, usa BRAPI_TOKEN do ambiente', async () => {
    const anterior = process.env.BRAPI_TOKEN;
    process.env.BRAPI_TOKEN = 'DO-AMBIENTE';
    try {
      const http = fetchFalso(() => envelope([{ symbol: 'B3SA3' }]));
      await buscarCotacao('B3SA3', { fetchImpl: http });
      assert.equal(http.chamadas[0].headers.Authorization, 'Bearer DO-AMBIENTE');
    } finally {
      if (anterior === undefined) delete process.env.BRAPI_TOKEN;
      else process.env.BRAPI_TOKEN = anterior;
    }
  });

  await teste('sem token nenhum, não envia header de autorização', async () => {
    const anterior = process.env.BRAPI_TOKEN;
    delete process.env.BRAPI_TOKEN;
    try {
      const http = fetchFalso(() => envelope([{ symbol: 'PETR4' }]));
      await buscarCotacao('PETR4', { fetchImpl: http });
      assert.equal(http.chamadas[0].headers.Authorization, undefined);
    } finally {
      if (anterior !== undefined) process.env.BRAPI_TOKEN = anterior;
    }
  });

  await teste('aceita o item sem envelope "data"', async () => {
    const http = fetchFalso(() => ok200({ results: [{ symbol: 'B3SA3', regularMarketPrice: 9.9 }] }));
    const dados = await buscarCotacao('B3SA3', { token: 'T', fetchImpl: http });
    assert.equal(dados.regularMarketPrice, 9.9);
  });

  console.log('respostas não-2xx e corpos inválidos');

  const casos = [
    [401, /Token da brapi inválido/],
    [403, /plano/i],
    [429, /[Ll]imite/],
    [404, /não encontrado/],
    [500, /indisponível/],
    [418, /HTTP 418/],
  ];
  for (const [status, esperado] of casos) {
    await teste(`HTTP ${status} vira ErroBrapi com status preservado`, async () => {
      const http = fetchFalso(() => ({ ok: false, status }));
      await assert.rejects(
        buscarCotacao('B3SA3', { token: 'T', fetchImpl: http }),
        (erro) => erro instanceof ErroBrapi && erro.status === status && esperado.test(erro.message) && erro.codigo === 'http',
      );
    });
  }

  await teste('corpo que não é JSON é reportado como tal', async () => {
    const http = fetchFalso(() => ({ ok: true, status: 200, json: async () => { throw new Error('inválido'); } }));
    await assert.rejects(
      buscarCotacao('B3SA3', { token: 'T', fetchImpl: http }),
      (erro) => erro.codigo === 'corpo-invalido',
    );
  });

  await teste('resposta sem "results" e lista vazia têm códigos próprios', async () => {
    const semResults = fetchFalso(() => ok200({ erro: 'nada' }));
    await assert.rejects(buscarCotacao('B3SA3', { token: 'T', fetchImpl: semResults }), (e) => e.codigo === 'sem-results');
    const vazio = fetchFalso(() => ok200({ results: [] }));
    await assert.rejects(buscarCotacao('B3SA3', { token: 'T', fetchImpl: vazio }), (e) => e.codigo === 'lista-vazia');
  });

  await teste('item sem objeto de dados é erro, não undefined silencioso', async () => {
    const http = fetchFalso(() => ok200({ results: ['texto'] }));
    await assert.rejects(
      buscarCotacao('B3SA3', { token: 'T', fetchImpl: http }),
      (e) => e.codigo === 'sem-dados' && e.symbol === 'B3SA3',
    );
  });

  await teste('queda de rede vira ErroBrapi de rede', async () => {
    const http = fetchFalso(() => { throw new Error('offline'); });
    await assert.rejects(buscarCotacao('B3SA3', { token: 'T', fetchImpl: http }), (e) => e.codigo === 'rede');
  });

  await teste('ticker vazio é recusado antes de chamar a API', async () => {
    const http = fetchFalso(() => ok200({ results: [] }));
    await assert.rejects(buscarCotacao('   ', { token: 'T', fetchImpl: http }), (e) => e.codigo === 'sem-ticker');
    assert.equal(http.chamadas.length, 0, 'não deve gastar requisição');
  });

  console.log('buscarCotacoes — vários ativos numa chamada');

  await teste('indexa por symbol e aponta quem não voltou', async () => {
    const http = fetchFalso(() => envelope([
      { symbol: 'B3SA3', regularMarketPrice: 12.3 },
      { symbol: 'BBAS3', regularMarketPrice: 22.8 },
    ]));
    const { dados, faltando } = await buscarCotacoes(['b3sa3', 'BBAS3', 'XPTO9'], { token: 'T', fetchImpl: http });
    assert.equal(http.chamadas.length, 1, 'uma única chamada para todos');
    assert.equal(http.chamadas[0].url, `${BASE_V2}/quote?symbols=B3SA3%2CBBAS3%2CXPTO9`);
    assert.equal(dados.B3SA3.regularMarketPrice, 12.3);
    assert.equal(dados.BBAS3.regularMarketPrice, 22.8);
    assert.deepEqual(faltando, ['XPTO9']);
  });

  await teste('tickers repetidos não viram consulta duplicada', async () => {
    const http = fetchFalso(() => envelope([{ symbol: 'B3SA3' }]));
    await buscarCotacoes(['B3SA3', 'b3sa3', ' b3sa3 '], { token: 'T', fetchImpl: http });
    assert.equal(http.chamadas[0].url, `${BASE_V2}/quote?symbols=B3SA3`);
  });

  console.log('utilidades');

  await teste('conteudo() desembrulha data quando existe', () => {
    assert.deepEqual(conteudo({ data: { a: 1 } }), { a: 1 });
    assert.deepEqual(conteudo({ a: 1 }), { a: 1 });
    assert.deepEqual(conteudo({ data: null, a: 2 }), { data: null, a: 2 });
  });

  await teste('mensagemDeErro cobre os status conhecidos', () => {
    assert.match(mensagemDeErro(401), /[Tt]oken/);
    assert.match(mensagemDeErro(503), /indisponível/);
  });

  console.log(falhas ? `\n${falhas} teste(s) da v2 falharam` : '\nTodos os testes da API v2 passaram');
  process.exit(falhas ? 1 : 0);
})();
