const assert = require('node:assert/strict');
const { buscarFundamentos, somarProventos12m, extrair, achatar, mensagemDeErro, CANDIDATOS_LPA } = require('../assets/bolsai.js');

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

function fetchFalso(regras) {
  const chamadas = [];
  const impl = async (url, opcoes = {}) => {
    chamadas.push({ url, chave: opcoes.headers?.['X-API-Key'] || null });
    for (const regra of regras) if (regra.quando(url)) return regra.responde(url);
    return { ok: true, json: async () => ({}) };
  };
  impl.chamadas = chamadas;
  return impl;
}
const resposta = (corpo) => ({ ok: true, json: async () => corpo });
const perto = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `esperado ${b}, veio ${a}`);

(async () => {
  console.log('extração tolerante de campos');

  await teste('acha o LPA em português na raiz', () => {
    assert.deepEqual(extrair(achatar({ lpa: 8.55, pl: 5 }), CANDIDATOS_LPA), { valor: 8.55, chave: 'lpa' });
  });
  await teste('acha o LPA em inglês aninhado em data', () => {
    assert.deepEqual(extrair(achatar({ data: { eps: 3.21 } }), CANDIDATOS_LPA), { valor: 3.21, chave: 'eps' });
  });
  await teste('acha o LPA em camelCase dentro de indicadores', () => {
    assert.deepEqual(extrair(achatar({ indicadores: { lucroPorAcao: 1.7 } }), CANDIDATOS_LPA), { valor: 1.7, chave: 'lucroPorAcao' });
  });
  await teste('número em texto com vírgula é convertido', () => {
    assert.deepEqual(extrair(achatar({ lpa: '2,45' }), CANDIDATOS_LPA), { valor: 2.45, chave: 'lpa' });
  });
  await teste('campo ausente ou não numérico devolve null', () => {
    assert.equal(extrair(achatar({ pl: 5 }), CANDIDATOS_LPA).valor, null);
    assert.equal(extrair(achatar({ lpa: 'indisponível' }), CANDIDATOS_LPA).valor, null);
    assert.equal(extrair(achatar(null), CANDIDATOS_LPA).valor, null);
  });

  console.log('soma de proventos');
  const hoje = new Date().toISOString();

  await teste('soma eventos de 12 meses e ignora os antigos', () => {
    const r = somarProventos12m({ dividends: [
      { ex_date: hoje, value: 1.2 },
      { ex_date: hoje, valor: 0.8 },
      { ex_date: '2015-01-01', value: 99 },
    ] });
    perto(r.valor, 2);
    assert.equal(r.eventos, 2);
  });
  await teste('aceita lista crua e outras chaves de coleção', () => {
    perto(somarProventos12m([{ date: hoje, amount: 0.5 }]).valor, 0.5);
    perto(somarProventos12m({ dividendos: [{ data: hoje, provento: 0.25 }] }).valor, 0.25);
  });
  await teste('evento sem data legível entra na soma', () => {
    perto(somarProventos12m({ dividends: [{ value: 0.4 }] }).valor, 0.4);
  });
  await teste('sem eventos devolve null, não zero', () => {
    assert.equal(somarProventos12m({}).valor, null);
    assert.equal(somarProventos12m({ dividends: [] }).valor, null);
    assert.equal(somarProventos12m({ dividends: [{ ex_date: '2010-01-01', value: 5 }] }).valor, null);
  });
  await teste('valores negativos ou zero são descartados', () => {
    assert.equal(somarProventos12m({ dividends: [{ ex_date: hoje, value: 0 }, { ex_date: hoje, value: -1 }] }).valor, null);
  });

  console.log('buscarFundamentos');

  await teste('envia a chave no header X-API-Key e monta as duas rotas', async () => {
    const http = fetchFalso([
      { quando: (u) => u.includes('/fundamentals/'), responde: () => resposta({ ticker: 'BBAS3', lpa: 8.55 }) },
      { quando: (u) => u.includes('/dividends/'), responde: () => resposta({ dividends: [{ ex_date: hoje, value: 2.1 }] }) },
    ]);
    const { dados, erros } = await buscarFundamentos(['bbas3'], { chave: 'CHAVE-SECRETA', fetchImpl: http });
    assert.deepEqual(erros, {});
    perto(dados.BBAS3.lpa, 8.55);
    perto(dados.BBAS3.dpa12m, 2.1);
    assert.equal(dados.BBAS3.origem.lpa, 'lpa');
    assert.ok(http.chamadas.every((c) => c.chave === 'CHAVE-SECRETA'), 'toda chamada leva a chave no header');
    assert.ok(http.chamadas.some((c) => c.url.endsWith('/fundamentals/BBAS3')), http.chamadas[0].url);
    assert.ok(http.chamadas.some((c) => c.url.endsWith('/dividends/BBAS3')));
  });

  await teste('a chave não vai na URL (não fica em log de proxy)', async () => {
    const http = fetchFalso([{ quando: () => true, responde: () => resposta({ lpa: 1 }) }]);
    await buscarFundamentos(['VIVT3'], { chave: 'CHAVE-SECRETA', fetchImpl: http });
    assert.ok(http.chamadas.every((c) => !c.url.includes('CHAVE-SECRETA')));
  });

  await teste('LPA não reconhecido devolve as chaves recebidas e um aviso acionável', async () => {
    const http = fetchFalso([
      { quando: (u) => u.includes('/fundamentals/'), responde: () => resposta({ pl: 5.3, pvp: 1.4, roe: 26.6 }) },
      { quando: () => true, responde: () => resposta({ dividends: [] }) },
    ]);
    const { dados, avisos } = await buscarFundamentos(['TAEE11'], { chave: 'k', fetchImpl: http });
    assert.equal(dados.TAEE11.lpa, null);
    assert.deepEqual(dados.TAEE11.chavesRecebidas, ['pl', 'pvp', 'roe']);
    assert.match(avisos[0], /inspecionar-bolsai/);
  });

  await teste('erro de chave é reportado por ticker', async () => {
    const http = fetchFalso([{ quando: () => true, responde: () => ({ ok: false, status: 401 }) }]);
    const { dados, erros } = await buscarFundamentos(['CPLE6'], { chave: 'errada', fetchImpl: http });
    assert.deepEqual(dados, {});
    assert.match(erros.CPLE6, /X-API-Key|inválida/);
  });

  await teste('limite diário (429) tem mensagem própria', () => {
    assert.match(mensagemDeErro(429), /200 requisições\/dia/);
  });

  await teste('falha nos proventos não derruba o LPA', async () => {
    const http = fetchFalso([
      { quando: (u) => u.includes('/dividends/'), responde: () => ({ ok: false, status: 429 }) },
      { quando: () => true, responde: () => resposta({ lpa: 4.2 }) },
    ]);
    const { dados, avisos } = await buscarFundamentos(['ITSA4'], { chave: 'k', fetchImpl: http });
    perto(dados.ITSA4.lpa, 4.2);
    assert.equal(dados.ITSA4.dpa12m, null);
    assert.ok(avisos.some((a) => /Proventos/.test(a)));
  });

  await teste('uma consulta por ticker, sem repetir tickers duplicados', async () => {
    const http = fetchFalso([{ quando: () => true, responde: () => resposta({ lpa: 1, dividends: [] }) }]);
    await buscarFundamentos(['BBAS3', 'bbas3', 'ITSA4'], { chave: 'k', fetchImpl: http });
    // 2 tickers x (fundamentals + dividends)
    assert.equal(http.chamadas.length, 4);
  });

  await teste('dividendos podem ser desligados para economizar requisições', async () => {
    const http = fetchFalso([{ quando: () => true, responde: () => resposta({ lpa: 1 }) }]);
    await buscarFundamentos(['BBAS3'], { chave: 'k', dividendos: false, fetchImpl: http });
    assert.equal(http.chamadas.length, 1);
  });

  await teste('queda de rede não lança exceção', async () => {
    const http = fetchFalso([{ quando: () => true, responde: () => { throw new Error('offline'); } }]);
    const { erros } = await buscarFundamentos(['BBSE3'], { chave: 'k', fetchImpl: http });
    assert.match(erros.BBSE3, /Sem conexão com a bolsai/);
  });

  console.log(falhas ? `\n${falhas} teste(s) da bolsai falharam` : '\nTodos os testes da bolsai passaram');
  process.exit(falhas ? 1 : 0);
})();
