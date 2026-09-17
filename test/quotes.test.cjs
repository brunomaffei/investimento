const assert = require('node:assert/strict');
const { buscarCotacoes, normalizar, somarProventos12m, mensagemDeErro } = require('../assets/quotes.js');

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

/** fetch falso que registra as URLs chamadas e responde conforme as regras passadas. */
function fetchFalso(regras) {
  const chamadas = [];
  const impl = async (url, opcoes = {}) => {
    chamadas.push(url);
    for (const regra of regras) {
      if (regra.quando(url, opcoes)) return regra.responde(url, opcoes);
    }
    return { ok: true, json: async () => ({ results: [] }) };
  };
  impl.chamadas = chamadas;
  return impl;
}

const temBearer = (_url, opcoes) => !!opcoes?.headers?.Authorization;

const resposta = (results) => ({ ok: true, json: async () => ({ results }) });

(async () => {
  console.log('buscarCotacoes — montagem da requisição');

  await teste('sem fundamentos, não pede módulos pagos', async () => {
    const http = fetchFalso([{ quando: () => true, responde: () => resposta([{ symbol: 'TAEE11', regularMarketPrice: 34.2 }]) }]);
    const { dados } = await buscarCotacoes(['taee11'], { token: 'abc', fetchImpl: http });
    assert.equal(http.chamadas.length, 1);
    assert.ok(!http.chamadas[0].includes('modules='), `URL não deveria pedir módulos: ${http.chamadas[0]}`);
    assert.ok(http.chamadas[0].includes('token=abc'));
    assert.equal(dados.TAEE11.preco, 34.2);
  });

  await teste('sem token, a URL não leva o parâmetro vazio', async () => {
    const http = fetchFalso([{ quando: () => true, responde: () => resposta([{ symbol: 'PETR4', regularMarketPrice: 30 }]) }]);
    await buscarCotacoes(['PETR4'], { fetchImpl: http });
    assert.ok(!http.chamadas[0].includes('token='), http.chamadas[0]);
    assert.ok(!http.chamadas[0].includes('?'), `sem parâmetros a URL fica limpa: ${http.chamadas[0]}`);
  });

  await teste('com fundamentos, pede módulos e dividendos', async () => {
    const http = fetchFalso([{ quando: () => true, responde: () => resposta([{ symbol: 'PETR4', regularMarketPrice: 30 }]) }]);
    await buscarCotacoes(['PETR4'], { fundamentos: true, fetchImpl: http });
    assert.ok(http.chamadas[0].includes('modules=defaultKeyStatistics'), http.chamadas[0]);
    assert.ok(http.chamadas[0].includes('dividends=true'), http.chamadas[0]);
  });

  await teste('tickers repetidos e em minúsculas são normalizados', async () => {
    const http = fetchFalso([{ quando: () => true, responde: () => resposta([{ symbol: 'VALE3', regularMarketPrice: 60 }]) }]);
    await buscarCotacoes(['vale3', 'VALE3', ' vale3 '], { fetchImpl: http });
    assert.equal(http.chamadas.length, 1);
    assert.ok(http.chamadas[0].endsWith('VALE3'), http.chamadas[0]);
  });

  await teste('mais de 10 tickers são divididos em lotes', async () => {
    const tickers = Array.from({ length: 23 }, (_, i) => `AAAA${i}`);
    const http = fetchFalso([{ quando: (u) => true, responde: (u) => resposta(
      decodeURIComponent(u).split('/').pop().split('?')[0].split(',').map((s) => ({ symbol: s, regularMarketPrice: 1 })),
    ) }]);
    const { dados, erros } = await buscarCotacoes(tickers, { fetchImpl: http });
    assert.equal(http.chamadas.length, 3); // 10 + 10 + 3
    assert.equal(Object.keys(dados).length, 23);
    assert.deepEqual(erros, {});
  });

  await teste('token recusado na URL é reenviado no header Authorization', async () => {
    const http = fetchFalso([
      { quando: (u, o) => temBearer(u, o), responde: () => resposta([{ symbol: 'BBSE3', regularMarketPrice: 38.5 }]) },
      { quando: (u) => u.includes('token='), responde: () => ({ ok: false, status: 401 }) },
    ]);
    const { dados, erros, avisos } = await buscarCotacoes(['BBSE3'], { token: 'abc', fetchImpl: http });
    assert.equal(http.chamadas.length, 2, 'primeiro pela URL, depois pelo header');
    assert.equal(dados.BBSE3.preco, 38.5);
    assert.deepEqual(erros, {});
    assert.match(avisos[0], /header Authorization/);
  });

  await teste('sem token, um 401 não gera segunda tentativa', async () => {
    const http = fetchFalso([{ quando: () => true, responde: () => ({ ok: false, status: 401 }) }]);
    const { erros } = await buscarCotacoes(['BBSE3'], { fetchImpl: http });
    assert.equal(http.chamadas.length, 1);
    assert.match(erros.BBSE3, /[Tt]oken/);
  });

  console.log('buscarCotacoes — planos e falhas');

  await teste('403 nos módulos refaz a chamada só com o preço e avisa', async () => {
    const http = fetchFalso([
      { quando: (u) => u.includes('modules='), responde: () => ({ ok: false, status: 403 }) },
      { quando: () => true, responde: () => resposta([{ symbol: 'TAEE11', regularMarketPrice: 34.2 }]) },
    ]);
    const { dados, erros, avisos } = await buscarCotacoes(['TAEE11'], { fundamentos: true, fetchImpl: http });
    assert.equal(http.chamadas.length, 2);
    assert.equal(dados.TAEE11.preco, 34.2, 'a cotação precisa sobreviver à recusa dos fundamentos');
    assert.deepEqual(erros, {});
    assert.match(avisos[0], /plano/i);
  });

  await teste('402 (limite) também cai para a consulta de preço', async () => {
    const http = fetchFalso([
      { quando: (u) => u.includes('modules='), responde: () => ({ ok: false, status: 402 }) },
      { quando: () => true, responde: () => resposta([{ symbol: 'ITUB4', regularMarketPrice: 33 }]) },
    ]);
    const { dados, avisos } = await buscarCotacoes(['ITUB4'], { fundamentos: true, fetchImpl: http });
    assert.equal(dados.ITUB4.preco, 33);
    assert.equal(avisos.length, 1);
  });

  await teste('quando o preço também é recusado, reporta o erro do ticker', async () => {
    const http = fetchFalso([{ quando: () => true, responde: () => ({ ok: false, status: 401 }) }]);
    const { dados, erros } = await buscarCotacoes(['BBAS3'], { fundamentos: true, fetchImpl: http });
    assert.deepEqual(dados, {});
    assert.match(erros.BBAS3, /[Tt]oken/);
  });

  await teste('aviso não se repete quando vários lotes falham igual', async () => {
    const tickers = Array.from({ length: 15 }, (_, i) => `BBBB${i}`);
    const http = fetchFalso([
      { quando: (u) => u.includes('modules='), responde: () => ({ ok: false, status: 403 }) },
      { quando: (u) => true, responde: (u) => resposta(
        decodeURIComponent(u).split('/').pop().split('?')[0].split(',').map((s) => ({ symbol: s, regularMarketPrice: 2 })),
      ) },
    ]);
    const { avisos } = await buscarCotacoes(tickers, { fundamentos: true, fetchImpl: http });
    assert.equal(avisos.length, 1, 'o mesmo aviso não deve aparecer uma vez por lote');
  });

  await teste('falha de rede não derruba a função', async () => {
    const http = fetchFalso([{ quando: () => true, responde: () => { throw new Error('offline'); } }]);
    const { erros } = await buscarCotacoes(['CPLE6'], { fetchImpl: http });
    assert.match(erros.CPLE6, /à mão/);
  });

  await teste('ticker sem retorno é reportado, sem contaminar os outros', async () => {
    const http = fetchFalso([{ quando: () => true, responde: () => resposta([{ symbol: 'VIVT3', regularMarketPrice: 25 }]) }]);
    const { dados, erros } = await buscarCotacoes(['VIVT3', 'XXXX9'], { fetchImpl: http });
    assert.equal(dados.VIVT3.preco, 25);
    assert.match(erros.XXXX9, /[Ss]em retorno/);
  });

  console.log('diagnóstico');

  const { diagnosticar, interpretar } = require('../assets/quotes.js');

  await teste('sem token, roda só o teste de rede', async () => {
    const http = fetchFalso([{ quando: () => true, responde: () => resposta([{ symbol: 'PETR4', regularMarketPrice: 31 }]) }]);
    const etapas = await diagnosticar({ fetchImpl: http });
    assert.equal(etapas.length, 1);
    assert.equal(etapas[0].chave, 'rede');
    assert.equal(etapas[0].preco, 31);
    assert.match(interpretar(etapas), /rede está ok/i);
  });

  await teste('com token, testa URL, header e fundamentos', async () => {
    const http = fetchFalso([{ quando: () => true, responde: () => resposta([{ symbol: 'BBAS3', regularMarketPrice: 31, defaultKeyStatistics: { trailingEps: 4.2 } }]) }]);
    const etapas = await diagnosticar({ token: 'segredo', tickers: ['BBAS3'], fetchImpl: http });
    assert.deepEqual(etapas.map((e) => e.chave), ['rede', 'url', 'header', 'fundamentos']);
    assert.match(interpretar(etapas), /[Tt]udo ok/);
  });

  await teste('fundamentos são testados num ticker da carteira, não em PETR4', async () => {
    const http = fetchFalso([{ quando: () => true, responde: (u) => resposta([{ symbol: 'X', regularMarketPrice: 10 }]) }]);
    const etapas = await diagnosticar({ token: 't', tickers: ['EXEMPLO', 'PETR4', 'TAEE11'], fetchImpl: http });
    const chamada = http.chamadas.find((u) => u.includes('modules='));
    assert.ok(chamada.includes('TAEE11'), `deveria testar TAEE11, chamou ${chamada}`);
    assert.equal(etapas.find((e) => e.chave === 'fundamentos').tickerLivre, false);
  });

  await teste('sem ticker próprio, avisa que PETR4 não prova cobertura de plano', async () => {
    const http = fetchFalso([{ quando: () => true, responde: () => resposta([{ symbol: 'PETR4', regularMarketPrice: 31, defaultKeyStatistics: { trailingEps: 4.2 } }]) }]);
    const etapas = await diagnosticar({ token: 'segredo', tickers: ['PETR4'], fetchImpl: http });
    assert.equal(etapas.find((e) => e.chave === 'fundamentos').tickerLivre, true);
    assert.match(interpretar(etapas), /NÃO prova/);
  });

  await teste('o token nunca aparece em texto no resultado', async () => {
    const http = fetchFalso([{ quando: () => true, responde: () => resposta([{ symbol: 'PETR4', regularMarketPrice: 31 }]) }]);
    const etapas = await diagnosticar({ token: 'SEGREDO123', fetchImpl: http });
    assert.ok(!JSON.stringify(etapas).includes('SEGREDO123'), 'o token não deve vazar no relatório');
    assert.ok(!interpretar(etapas).includes('SEGREDO123'));
  });

  await teste('bloqueio do navegador é identificado como tal', async () => {
    const http = fetchFalso([{ quando: () => true, responde: () => { throw new TypeError('Failed to fetch'); } }]);
    const etapas = await diagnosticar({ token: 'x', fetchImpl: http });
    assert.equal(etapas[0].bloqueado, true);
    assert.match(interpretar(etapas), /bloqueou a chamada|permissão de rede/i);
  });

  await teste('token recusado na URL e no header é apontado', async () => {
    const http = fetchFalso([
      { quando: (u, o) => u.includes('token=') || temBearer(u, o), responde: () => ({ ok: false, status: 401 }) },
      { quando: () => true, responde: () => resposta([{ symbol: 'PETR4', regularMarketPrice: 31 }]) },
    ]);
    const etapas = await diagnosticar({ token: 'errado', fetchImpl: http });
    assert.equal(etapas.find((e) => e.chave === 'rede').ok, true, 'a rede em si funciona');
    assert.equal(etapas.find((e) => e.chave === 'url').status, 401);
    assert.equal(etapas.find((e) => e.chave === 'header').status, 401);
    assert.match(interpretar(etapas), /recusado nas duas formas/);
  });

  await teste('plano sem fundamentos é diagnosticado', async () => {
    const http = fetchFalso([
      { quando: (u) => u.includes('modules='), responde: () => ({ ok: false, status: 403 }) },
      { quando: () => true, responde: () => resposta([{ symbol: 'PETR4', regularMarketPrice: 31 }]) },
    ]);
    const etapas = await diagnosticar({ token: 'bom', fetchImpl: http });
    assert.match(interpretar(etapas), /não cobre fundamentos/);
  });

  console.log('normalizar e proventos');

  await teste('preço inválido ou zerado vira null', async () => {
    assert.equal(normalizar({ symbol: 'X', regularMarketPrice: 0 }).preco, null);
    assert.equal(normalizar({ symbol: 'X', regularMarketPrice: null }).preco, null);
    assert.equal(normalizar({ symbol: 'X' }).preco, null);
  });

  await teste('LPA vem de trailingEps ou de earningsPerShare', async () => {
    assert.equal(normalizar({ symbol: 'X', defaultKeyStatistics: { trailingEps: 3.5 } }).lpa, 3.5);
    assert.equal(normalizar({ symbol: 'X', earningsPerShare: 2.1 }).lpa, 2.1);
    assert.equal(normalizar({ symbol: 'X' }).lpa, null);
  });

  await teste('soma de proventos ignora eventos com mais de 12 meses', async () => {
    const agora = new Date().toISOString();
    const antigo = '2015-03-01';
    const soma = somarProventos12m({ dividendsData: { cashDividends: [
      { paymentDate: agora, rate: 0.5 },
      { paymentDate: agora, rate: 0.58 },
      { paymentDate: antigo, rate: 99 },
      { paymentDate: agora, rate: 'não é número' },
    ] } });
    assert.ok(Math.abs(soma - 1.08) < 1e-9, `esperado 1,08 e veio ${soma}`);
  });

  await teste('sem histórico de dividendos devolve null', async () => {
    assert.equal(somarProventos12m({}), null);
    assert.equal(somarProventos12m({ dividendsData: { cashDividends: [] } }), null);
  });

  await teste('mensagens de erro distinguem token de plano', async () => {
    assert.match(mensagemDeErro(401), /[Tt]oken/);
    assert.match(mensagemDeErro(403), /plano/i);
    assert.match(mensagemDeErro(404), /não encontrado/);
    assert.match(mensagemDeErro(500), /HTTP 500/);
  });

  console.log(falhas ? `\n${falhas} teste(s) falharam` : '\nTodos os testes de cotação passaram');
  process.exit(falhas ? 1 : 0);
})();
