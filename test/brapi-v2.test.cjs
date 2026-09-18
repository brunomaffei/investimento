const assert = require('node:assert/strict');
const { buscarCotacao, buscarCotacoes, buscarProventos12m, conteudo, mensagemDeErro, ErroBrapi, BASE_V2 } = require('../assets/brapi-v2.js');

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
    // Vírgula literal entre os símbolos, como na documentação.
    assert.equal(http.chamadas[0].url, `${BASE_V2}/quote?symbols=B3SA3,BBAS3,XPTO9`);
    assert.equal(dados.B3SA3.regularMarketPrice, 12.3);
    assert.equal(dados.BBAS3.regularMarketPrice, 22.8);
    assert.deepEqual(faltando, ['XPTO9']);
  });

  await teste('tickers repetidos não viram consulta duplicada', async () => {
    const http = fetchFalso(() => envelope([{ symbol: 'B3SA3' }]));
    await buscarCotacoes(['B3SA3', 'b3sa3', ' b3sa3 '], { token: 'T', fetchImpl: http });
    assert.equal(http.chamadas[0].url, `${BASE_V2}/quote?symbols=B3SA3`);
  });

  console.log('lote recusado pelo plano (um ticker por consulta)');

  await teste('HTTP 400 no lote faz o app consultar um a um', async () => {
    const http = fetchFalso((url) => {
      const lista = url.split('symbols=')[1].split(',');
      if (lista.length > 1) return { ok: false, status: 400 };
      return ok200({ results: lista.map((s) => ({ data: { symbol: s, regularMarketPrice: 10 } })) });
    });
    const { dados, avisos, faltando } = await buscarCotacoes(['BBAS3', 'ITSA4', 'TAEE11'], { token: 'T', fetchImpl: http });
    assert.deepEqual(Object.keys(dados).sort(), ['BBAS3', 'ITSA4', 'TAEE11']);
    assert.deepEqual(faltando, []);
    assert.equal(http.chamadas.length, 4, '1 lote recusado + 3 individuais');
    assert.match(avisos[0], /um ticker por consulta/);
  });

  await teste('ticker individual que falha entra em erros, sem derrubar os outros', async () => {
    const http = fetchFalso((url) => {
      const lista = url.split('symbols=')[1].split(',');
      if (lista.length > 1) return { ok: false, status: 400 };
      if (lista[0] === 'ITSA4') return { ok: false, status: 404 };
      return ok200({ results: [{ data: { symbol: lista[0], regularMarketPrice: 10 } }] });
    });
    const { dados, erros } = await buscarCotacoes(['BBAS3', 'ITSA4'], { token: 'T', fetchImpl: http });
    assert.ok(dados.BBAS3, 'o que funcionou precisa ser preservado');
    assert.match(erros.ITSA4, /não encontrado/);
  });

  await teste('400 que não é de lote (um ticker só) sobe como erro', async () => {
    const http = fetchFalso(() => ({ ok: false, status: 400 }));
    await assert.rejects(
      buscarCotacoes(['BBAS3'], { token: 'T', fetchImpl: http }),
      (e) => e.status === 400,
    );
    assert.equal(http.chamadas.length, 1, 'sem lote, não há o que dividir');
  });

  await teste('se nem individualmente funcionar, o erro original sobe', async () => {
    const http = fetchFalso(() => ({ ok: false, status: 400 }));
    await assert.rejects(
      buscarCotacoes(['BBAS3', 'ITSA4'], { token: 'T', fetchImpl: http }),
      (e) => e.status === 400,
    );
  });

  await teste('401 no lote não vira consulta um a um', async () => {
    const http = fetchFalso(() => ({ ok: false, status: 401 }));
    await assert.rejects(buscarCotacoes(['BBAS3', 'ITSA4'], { token: 'x', fetchImpl: http }), (e) => e.status === 401);
    assert.equal(http.chamadas.length, 1, 'token inválido não melhora dividindo o lote');
  });

  console.log('buscarProventos12m — dividendos e JCP');

  await teste('ação: usa /stocks/dividends e soma 12 meses', async () => {
    const hoje = new Date().toISOString();
    const http = fetchFalso(() => ok200({ results: [{ data: { dividends: [
      { paymentDate: hoje, rate: 1.5 }, { paymentDate: hoje, rate: 1.0 }, { paymentDate: '2015-01-01', rate: 80 },
    ] } }] }));
    const r = await buscarProventos12m('bbas3', { token: 'T', fetchImpl: http });
    assert.equal(http.chamadas[0].url, `${BASE_V2}/dividends?symbols=BBAS3`);
    assert.equal(http.chamadas[0].headers.Authorization, 'Bearer T');
    assert.ok(Math.abs(r.dpa12m - 2.5) < 1e-9, `esperado 2,5 e veio ${r.dpa12m}`);
    assert.equal(r.rota, 'stocks');
    assert.equal(r.eventos, 2);
  });

  await teste('FII: 404 na rota de ações cai para /fii/dividends', async () => {
    const hoje = new Date().toISOString();
    const http = fetchFalso((url) => (url.includes('/fii/')
      ? ok200({ results: [{ data: { dividends: [{ paymentDate: hoje, rate: 0.09 }] } }] })
      : { ok: false, status: 404 }));
    const r = await buscarProventos12m('XPLG11', { token: 'T', fetchImpl: http });
    assert.equal(r.rota, 'fii');
    assert.ok(Math.abs(r.dpa12m - 0.09) < 1e-9);
    assert.ok(http.chamadas[1].url.includes('/fii/dividends'), http.chamadas[1].url);
  });

  await teste('rota de ações sem evento também tenta a de FII', async () => {
    const hoje = new Date().toISOString();
    const http = fetchFalso((url) => (url.includes('/fii/')
      ? ok200({ results: [{ data: { dividends: [{ paymentDate: hoje, rate: 0.12 }] } }] })
      : ok200({ results: [{ data: { dividends: [] } }] })));
    const r = await buscarProventos12m('XPML11', { token: 'T', fetchImpl: http });
    assert.equal(r.rota, 'fii');
    assert.ok(Math.abs(r.dpa12m - 0.12) < 1e-9);
  });

  await teste('quando nenhuma rota tem evento, devolve null sem erro', async () => {
    const http = fetchFalso(() => ok200({ results: [{ data: { dividends: [] } }] }));
    const r = await buscarProventos12m('BBAS3', { token: 'T', fetchImpl: http });
    assert.equal(r.dpa12m, null);
    assert.equal(r.eventos, 0);
  });

  await teste('erro que não é 404 sobe (não vira FII silenciosamente)', async () => {
    const http = fetchFalso(() => ({ ok: false, status: 401 }));
    await assert.rejects(
      buscarProventos12m('BBAS3', { token: 'errado', fetchImpl: http }),
      (e) => e.status === 401,
    );
    assert.equal(http.chamadas.length, 1, 'não deve tentar a rota de FII com token inválido');
  });

  await teste('a chave nunca vai na URL das rotas de dividendos', async () => {
    const http = fetchFalso(() => ok200({ results: [{ data: { dividends: [] } }] }));
    await buscarProventos12m('BBAS3', { token: 'TOKEN-SECRETO', fetchImpl: http });
    assert.ok(http.chamadas.every((c) => !c.url.includes('TOKEN-SECRETO')));
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
