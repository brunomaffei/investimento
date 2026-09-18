const assert = require('node:assert/strict');
const { somar12m, listaDeEventos, CANDIDATOS_VALOR } = require('../assets/proventos.js');

let falhas = 0;
function teste(nome, fn) {
  try {
    fn();
    console.log(`  ok   ${nome}`);
  } catch (erro) {
    falhas++;
    console.log(`  FALHA ${nome}\n        ${erro.message}`);
  }
}
const perto = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `esperado ${b}, veio ${a}`);
const hoje = new Date().toISOString();
const antigo = '2015-03-01';

console.log('formatos das fontes');

teste('brapi v2: results[].data.dividends', () => {
  const r = somar12m({ results: [{ data: { dividends: [
    { paymentDate: hoje, rate: 0.6 }, { paymentDate: hoje, rate: 0.5 }, { paymentDate: antigo, rate: 9 },
  ] } }] });
  perto(r.valor, 1.1);
  assert.equal(r.eventos, 2);
  assert.equal(r.chaveValor, 'rate');
});

teste('brapi v1: dividendsData.cashDividends', () => {
  perto(somar12m({ dividendsData: { cashDividends: [{ paymentDate: hoje, rate: 1.2 }] } }).valor, 1.2);
});

teste('bolsai: dividends com ex_date/value', () => {
  perto(somar12m({ dividends: [{ ex_date: hoje, value: 1.08 }] }).valor, 1.08);
});

teste('array cru, com valor em texto brasileiro', () => {
  perto(somar12m([{ date: hoje, valor: '0,45' }]).valor, 0.45);
});

console.log('robustez');

teste('array de envelopes não é confundido com lista de eventos', () => {
  // results[] tem objetos SEM campo de valor: precisa descer, não somar zero.
  const r = somar12m({ results: [{ data: { dividends: [{ paymentDate: hoje, rate: 3 }] } }] });
  perto(r.valor, 3);
});

teste('sem eventos no período devolve null, não zero', () => {
  assert.equal(somar12m({ dividends: [{ ex_date: antigo, value: 5 }] }).valor, null);
  assert.equal(somar12m({ results: [{ data: { dividends: [] } }] }).valor, null);
});

teste('corpo inesperado não quebra nem inventa número', () => {
  for (const corpo of [null, undefined, 'texto', 42, {}, { mensagem: 'erro' }, []]) {
    const r = somar12m(corpo);
    assert.equal(r.valor, null);
    assert.equal(r.eventos, 0);
  }
});

teste('valores zero, negativos e não numéricos são descartados', () => {
  const r = somar12m({ dividends: [
    { ex_date: hoje, value: 0 }, { ex_date: hoje, value: -2 }, { ex_date: hoje, value: 'n/d' }, { ex_date: hoje, value: 1.5 },
  ] });
  perto(r.valor, 1.5);
  assert.equal(r.eventos, 1);
});

teste('quando NENHUM evento tem data, soma tudo e avisa', () => {
  // Sem data em lugar nenhum não há como cortar: soma, mas marca semDatas para
  // quem chama poder desconfiar do número.
  const soma = somar12m({ dividends: [{ value: 0.4 }] });
  perto(soma.valor, 0.4);
  assert.equal(soma.semDatas, true);
});

teste('se a fonte tem datas, o evento sem data legível fica FORA', () => {
  // Deixar entrar somava a MAIS: inflava o DPA, o preço-teto e virava SIM falso.
  const hoje = new Date().toISOString();
  const soma = somar12m({ dividends: [
    { ex_date: hoje, value: 1 },
    { ex_date: 'data inválida', value: 9 },
    { value: 50 },
  ] });
  perto(soma.valor, 1);
  assert.equal(soma.eventos, 1);
  assert.equal(soma.ignorados, 2);
});

teste('data de pagamento em português também é reconhecida', () => {
  // A bolsai usa data_pagamento; fora da lista de candidatos, um provento de 2015
  // era tratado como "sem data" e entrava na soma.
  const soma = somar12m({ dividends: [{ data_pagamento: '2015-01-01', value: 50 }, { ex_date: new Date().toISOString(), value: 2 }] });
  perto(soma.valor, 2);
  assert.equal(soma.ignorados, 1);
});

teste('provento com data muito à frente não entra nos 12 meses', () => {
  const daquiAUmAno = new Date(Date.now() + 400 * 24 * 3600 * 1000).toISOString();
  const soma = somar12m({ dividends: [
    { ex_date: new Date().toISOString(), value: 1 },
    { ex_date: daquiAUmAno, value: 5 },
  ] });
  perto(soma.valor, 1);
  assert.equal(soma.ignorados, 1);
});

teste('provento já declarado para as próximas semanas continua contando', () => {
  const emDuasSemanas = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
  perto(somar12m({ dividends: [{ payment_date: emDuasSemanas, value: 0.7 }] }).valor, 0.7);
});

teste('o corte de 12 meses respeita a referência informada', () => {
  const eventos = { dividends: [{ ex_date: '2026-01-10', value: 1 }, { ex_date: '2024-01-10', value: 1 }] };
  perto(somar12m(eventos, Date.parse('2026-06-01')).valor, 1);
  assert.equal(somar12m(eventos, Date.parse('2027-06-01')).valor, null);
});

teste('aninhamento fundo demais não trava a busca', () => {
  let corpo = { dividends: [{ ex_date: hoje, value: 1 }] };
  for (let i = 0; i < 8; i++) corpo = { data: corpo };
  assert.equal(somar12m(corpo).valor, null, 'busca é limitada em profundidade, sem estourar a pilha');
});

teste('listaDeEventos reconhece evento por qualquer campo de valor', () => {
  for (const campo of CANDIDATOS_VALOR) {
    const encontrados = listaDeEventos({ dividends: [{ [campo]: 1 }] });
    assert.equal(encontrados.length, 1, `campo ${campo} deveria ser reconhecido`);
  }
});

console.log(falhas ? `\n${falhas} teste(s) de proventos falharam` : '\nTodos os testes de proventos passaram');
process.exit(falhas ? 1 : 0);
