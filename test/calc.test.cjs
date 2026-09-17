const assert = require('node:assert/strict');
const { parseNumero, avaliarAtivo, avaliarCarteira } = require('../assets/calc.js');

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
const perto = (a, b, tol = 0.01) =>
  assert.ok(Math.abs(a - b) <= tol, `esperado ~${b}, recebido ${a}`);

console.log('parseNumero');
teste('formato brasileiro com milhar e decimal', () => {
  assert.equal(parseNumero('R$ 5.102.000.000,00'), 5102000000);
  assert.equal(parseNumero('1,45'), 1.45);
  assert.equal(parseNumero('85%'), 85);
});
teste('decimal com ponto e milhar sem separador', () => {
  assert.equal(parseNumero('20.56'), 20.56);
  assert.equal(parseNumero('3000000000'), 3000000000);
  assert.equal(parseNumero('1.152.254.440'), 1152254440);
});
teste('atalhos de escala', () => {
  assert.equal(parseNumero('22 bi'), 22e9);
  assert.equal(parseNumero('5,102bi'), 5.102e9);
  assert.equal(parseNumero('340 mi'), 340e6);
});
teste('valores inválidos viram null', () => {
  for (const v of ['', null, undefined, 'abc', '-', 'R$']) assert.equal(parseNumero(v), null);
});
teste('negativos são preservados', () => {
  assert.equal(parseNumero('-1.500,50'), -1500.5);
});

console.log('avaliarAtivo — casos reais da planilha de referência');
const cfg = { yieldPadrao: 6, margemMinima: 0 };

teste('payout 85%, yield 6% -> LPA 1,70 e DPA 1,45', () => {
  const m = avaliarAtivo(
    { cotacao: 20.56, lucroProjetado: '5.102.000.000', quantidadeAcoes: '3.000.000.000', payout: 85 },
    cfg,
  );
  perto(m.lpa, 1.7, 0.005);
  perto(m.dpa, 1.45, 0.005);
  perto(m.precoTeto, 24.09, 0.01); // 1,44557 / 0,06
  assert.equal(m.veredito, 'sim'); // teto 24,09 > cotação 20,56
});

teste('margem negativa -> NÃO (linha utilities a R$ 45,14)', () => {
  const m = avaliarAtivo(
    { cotacao: 45.14, lucroProjetado: '4.233.000.000', quantidadeAcoes: '1.152.254.440', payout: 70 },
    cfg,
  );
  perto(m.lpa, 3.67, 0.005);
  perto(m.dpa, 2.57, 0.005);
  perto(m.precoTeto, 42.86, 0.01);
  perto(m.margem * 100, -5.05, 0.01);
  assert.equal(m.veredito, 'nao');
});

teste('margem positiva -> SIM (linha communications a R$ 30,71)', () => {
  const m = avaliarAtivo(
    { cotacao: 30.71, lucroProjetado: '8.179.000.000', quantidadeAcoes: '3.226.546.622', payout: 90 },
    cfg,
  );
  perto(m.precoTeto, 38.02, 0.01);
  perto(m.margem * 100, 23.82, 0.01);
  assert.equal(m.veredito, 'sim');
});

teste('yield 7% (linha finance a R$ 22,71)', () => {
  const m = avaliarAtivo(
    {
      cotacao: 22.71,
      lucroProjetado: '22.000.000.000',
      quantidadeAcoes: '5.730.834.040',
      payout: 45,
      yieldAceitavel: 7,
    },
    cfg,
  );
  perto(m.lpa, 3.84, 0.005);
  perto(m.dpa, 1.73, 0.005);
  perto(m.precoTeto, 24.68, 0.01);
  perto(m.margem * 100, 8.67, 0.02);
  assert.equal(m.veredito, 'sim');
});

console.log('avaliarAtivo — regras auxiliares');
teste('modo dividendo usa o DPA informado (FIIs)', () => {
  // DPA anual de um FII que paga R$ 0,09/mês = R$ 1,08; yield exigido de 10%.
  const m = avaliarAtivo({ modo: 'dividendo', cotacao: 9.5, dpaInformado: '1,08', yieldAceitavel: 10 }, cfg);
  perto(m.precoTeto, 10.8, 0.001);
  perto(m.yieldAtual * 100, 11.37, 0.01);
  assert.equal(m.veredito, 'sim');
});
teste('yield aceitável cai para o padrão quando não informado', () => {
  const m = avaliarAtivo({ cotacao: 10, modo: 'dividendo', dpaInformado: 1 }, { yieldPadrao: 8 });
  assert.equal(m.yieldAceitavel, 8);
  perto(m.precoTeto, 12.5);
});
teste('margem mínima exigida muda o veredito e o preço-alvo', () => {
  const ativo = { cotacao: 100, modo: 'dividendo', dpaInformado: 6.6, yieldAceitavel: 6 };
  assert.equal(avaliarAtivo(ativo, { margemMinima: 0 }).veredito, 'sim'); // teto 110 -> +10%
  const exigente = avaliarAtivo(ativo, { margemMinima: 20 });
  assert.equal(exigente.veredito, 'nao');
  perto(exigente.precoAlvo, 91.67, 0.01); // 110 / 1,20
});
teste('dados faltando -> incompleto, com a lista do que falta', () => {
  const m = avaliarAtivo({ cotacao: 10 }, cfg);
  assert.equal(m.veredito, 'incompleto');
  assert.equal(m.precoTeto, null);
  assert.ok(m.faltando.length >= 1);
});
teste('quantidade de ações zero não gera Infinity', () => {
  const m = avaliarAtivo({ cotacao: 10, lucroProjetado: 100, quantidadeAcoes: 0, payout: 50 }, cfg);
  assert.equal(m.lpa, null);
  assert.equal(m.veredito, 'incompleto');
});
teste('prejuízo projetado não vira preço-teto', () => {
  const m = avaliarAtivo(
    { cotacao: 10, lucroProjetado: '-500 mi', quantidadeAcoes: '100 mi', payout: 50 },
    cfg,
  );
  assert.equal(m.precoTeto, null);
  assert.equal(m.veredito, 'incompleto');
});

teste('modo lpa usa o LPA informado + payout', () => {
  const m = avaliarAtivo({ modo: 'lpa', cotacao: 30, lpaInformado: '3,67', payout: 70 }, cfg);
  perto(m.lpa, 3.67, 0.001);
  perto(m.dpa, 2.569, 0.001);
  perto(m.precoTeto, 42.82, 0.01);
  assert.equal(m.veredito, 'sim');
});
teste('modo lpa ignora lucro/quantidade preenchidos', () => {
  const m = avaliarAtivo(
    { modo: 'lpa', cotacao: 30, lpaInformado: 2, payout: 50, lucroProjetado: '999 bi', quantidadeAcoes: 10 },
    cfg,
  );
  perto(m.lpa, 2, 0.001);
});
teste('modo lucro continua sendo o padrão quando modo vem vazio', () => {
  const m = avaliarAtivo({ cotacao: 10, lucroProjetado: '100 mi', quantidadeAcoes: '50 mi', payout: 60 }, cfg);
  assert.equal(m.modo, 'lucro');
  perto(m.lpa, 2, 0.001);
});

console.log('avaliarCarteira');
teste('resumo conta SIM, NÃO e incompletos', () => {
  const { resumo } = avaliarCarteira(
    [
      { modo: 'dividendo', cotacao: 10, dpaInformado: 1 },      // teto 16,67 -> sim
      { modo: 'dividendo', cotacao: 100, dpaInformado: 1 },     // teto 16,67 -> nao
      { ticker: 'VAZIO' },                                       // incompleto
    ],
    cfg,
  );
  assert.deepEqual(
    { total: resumo.total, comprar: resumo.comprar, aguardar: resumo.aguardar, incompletos: resumo.incompletos },
    { total: 3, comprar: 1, aguardar: 1, incompletos: 1 },
  );
  perto(resumo.melhorMargem * 100, 66.67, 0.01);
});
teste('carteira vazia não quebra', () => {
  const { resumo } = avaliarCarteira([], cfg);
  assert.equal(resumo.total, 0);
  assert.equal(resumo.melhorMargem, null);
});

console.log(falhas ? `\n${falhas} teste(s) falharam` : '\nTodos os testes passaram');
process.exit(falhas ? 1 : 0);
