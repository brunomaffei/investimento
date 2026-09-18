const assert = require('node:assert/strict');
const Calc = require('../assets/calc.js');
const { parseNumero, avaliarAtivo, avaliarCarteira } = Calc;

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

teste('decimal com ponto e zero à esquerda não vira milhar', () => {
  // "0.850" é LPA copiado de site em inglês. Virando 850, o preço-teto saía mil
  // vezes maior e a linha ganhava selo SIM com margem de quatro dígitos.
  assert.equal(parseNumero('0.850'), 0.85);
  assert.equal(parseNumero('0.123'), 0.123);
  assert.equal(parseNumero('12.500'), 12500);
  assert.equal(parseNumero('1234.567'), 1234.567);
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
teste('a lista aponta campo por campo, conforme o modo', () => {
  assert.deepEqual(
    avaliarAtivo({ modo: 'lucro', cotacao: 10 }, cfg).faltando,
    ['lucro', 'nº de ações', 'payout'],
  );
  assert.deepEqual(avaliarAtivo({ modo: 'lpa', cotacao: 10, payout: 70 }, cfg).faltando, ['LPA']);
  assert.deepEqual(avaliarAtivo({ modo: 'lpa', cotacao: 10, lpaInformado: 3 }, cfg).faltando, ['payout']);
  assert.deepEqual(avaliarAtivo({ modo: 'dividendo', cotacao: 10 }, cfg).faltando, ['DPA']);
  assert.deepEqual(avaliarAtivo({ modo: 'dividendo', dpaInformado: 1 }, cfg).faltando, ['cotação']);
  // Yield nunca entra em "faltando": sem informação, vale o padrão de 6% do Bazin.
  assert.deepEqual(
    avaliarAtivo({ modo: 'dividendo', cotacao: 10, dpaInformado: 1 }, { yieldPadrao: 0 }).faltando,
    [],
  );
});
teste('premissas completas com prejuízo apontam lucro positivo', () => {
  const m = avaliarAtivo(
    { modo: 'lucro', cotacao: 10, lucroProjetado: '-1 bi', quantidadeAcoes: '1 bi', payout: 50 },
    cfg,
  );
  assert.deepEqual(m.faltando, ['lucro positivo']);
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

teste('payout padrão preenche as linhas sem payout próprio', () => {
  const cfg2 = { yieldPadrao: 6, payoutPadrao: 50, margemMinima: 0 };
  const m = avaliarAtivo({ modo: 'lpa', cotacao: 20, lpaInformado: 4 }, cfg2);
  perto(m.dpa, 2, 0.001);
  perto(m.precoTeto, 33.33, 0.01);
  assert.equal(m.payoutDoPadrao, true);
  assert.equal(m.veredito, 'sim');
  assert.deepEqual(m.faltando, []);
});
teste('payout da linha vence o padrão', () => {
  const m = avaliarAtivo({ modo: 'lpa', cotacao: 20, lpaInformado: 4, payout: 80 }, { yieldPadrao: 6, payoutPadrao: 50 });
  perto(m.dpa, 3.2, 0.001);
  assert.equal(m.payoutDoPadrao, false);
});
teste('sem payout na linha e sem padrão, segue faltando', () => {
  const m = avaliarAtivo({ modo: 'lpa', cotacao: 20, lpaInformado: 4 }, { yieldPadrao: 6 });
  assert.deepEqual(m.faltando, ['payout']);
});
teste('payout zero na linha é respeitado (não cai no padrão)', () => {
  const m = avaliarAtivo({ modo: 'lpa', cotacao: 20, lpaInformado: 4, payout: 0 }, { yieldPadrao: 6, payoutPadrao: 50 });
  assert.equal(m.dpa, 0);
  assert.equal(m.precoTeto, null, 'payout 0 não gera preço-teto');
  assert.deepEqual(m.faltando, ['lucro positivo']);
});

teste('payout implícito: DPA pago de 12 meses dividido pelo LPA', () => {
  // Caso real: LPA 2,15 da brapi + DPA 0,65 do Yahoo.
  const m = avaliarAtivo(
    { modo: 'lpa', cotacao: '22,82', lpaInformado: '2,15', dpa12mMercado: '0,65' },
    { yieldPadrao: 7, margemMinima: 0 },
  );
  perto(m.payoutDeMercado, 30.23, 0.01);
  assert.equal(m.origemPayout, 'mercado');
  perto(m.dpa, 0.65, 0.001);
  perto(m.precoTeto, 9.29, 0.01);
  assert.deepEqual(m.faltando, [], 'com payout derivado, a linha deixa de estar incompleta');
});
teste('a premissa do usuário vence o payout de mercado', () => {
  const ativo = { modo: 'lpa', cotacao: 20, lpaInformado: 2, dpa12mMercado: 0.5 };
  assert.equal(avaliarAtivo(ativo, { yieldPadrao: 6 }).origemPayout, 'mercado');
  assert.equal(avaliarAtivo(ativo, { yieldPadrao: 6, payoutPadrao: 60 }).origemPayout, 'padrao');
  assert.equal(avaliarAtivo({ ...ativo, payout: 80 }, { yieldPadrao: 6, payoutPadrao: 60 }).origemPayout, 'linha');
});
teste('yield do provento pago serve de conferência', () => {
  const m = avaliarAtivo(
    { modo: 'lpa', cotacao: '22,82', lpaInformado: '2,15', dpa12mMercado: '0,65' },
    { yieldPadrao: 7 },
  );
  perto(m.yieldDeMercado * 100, 2.85, 0.01);
});
teste('sem LPA não há payout implícito: faltam os dois', () => {
  const m = avaliarAtivo({ modo: 'lpa', cotacao: 20, dpa12mMercado: 1 }, { yieldPadrao: 6 });
  assert.equal(m.payoutDeMercado, null, 'o provento sozinho não deriva payout');
  assert.deepEqual(m.faltando, ['LPA', 'payout']);
});
teste('provento zerado ou negativo não vira payout', () => {
  for (const dpa of [0, -1, 'abc']) {
    const m = avaliarAtivo({ modo: 'lpa', cotacao: 20, lpaInformado: 2, dpa12mMercado: dpa }, { yieldPadrao: 6 });
    assert.equal(m.payoutDeMercado, null);
    assert.deepEqual(m.faltando, ['payout']);
  }
});

teste('campo de yield vazio não trava a carteira: vale 6% do Bazin', () => {
  // Era o que o usuário via: config com o campo vazio e TODAS as linhas em "falta yield".
  const ativo = { modo: 'lpa', cotacao: '23,10', lpaInformado: '1,62', dpa12mMercado: '1,13' };
  const m = avaliarAtivo(ativo, { yieldPadrao: '', margemMinima: '' });
  assert.equal(m.yieldAceitavel, 6);
  assert.equal(m.yieldDoFallback, true, 'a linha precisa saber que caiu no padrão');
  assert.deepEqual(m.faltando, [], 'nada pode ficar faltando por causa disso');
  perto(m.precoTeto, 18.83, 0.01);
});
teste('yield informado vence o padrão e o fallback', () => {
  const ativo = { modo: 'lpa', cotacao: 20, lpaInformado: 2, payout: 50 };
  assert.equal(avaliarAtivo(ativo, {}).yieldAceitavel, 6, 'sem nada, 6%');
  assert.equal(avaliarAtivo(ativo, { yieldPadrao: 9 }).yieldAceitavel, 9);
  assert.equal(avaliarAtivo({ ...ativo, yieldAceitavel: 12 }, { yieldPadrao: 9 }).yieldAceitavel, 12);
  assert.equal(avaliarAtivo({ ...ativo, yieldAceitavel: 12 }, { yieldPadrao: 9 }).yieldDoFallback, false);
});
teste('yield inválido ou zero cai no padrão em vez de gerar Infinity', () => {
  for (const ruim of ['', '0', 'abc', -3]) {
    const m = avaliarAtivo({ modo: 'lpa', cotacao: 20, lpaInformado: 2, payout: 50, yieldAceitavel: ruim }, {});
    assert.equal(m.yieldAceitavel, 6, `yield ${JSON.stringify(ruim)} deveria cair no padrão`);
    assert.ok(Number.isFinite(m.precoTeto));
  }
});

console.log('proteções contra número que engana');
teste('empresa com prejuízo não ganha preço-teto positivo', () => {
  // Payout de mercado negativo (provento ÷ LPA negativo) multiplicado pelo LPA
  // também negativo devolvia DPA positivo: o vermelho virava SIM.
  const m = avaliarAtivo({ modo: 'lpa', cotacao: 10, lpaInformado: '-2,00', dpa12mMercado: 1 }, { yieldPadrao: 6 });
  assert.equal(m.payoutDeMercado, null);
  assert.equal(m.dpa, null);
  assert.equal(m.precoTeto, null);
  assert.equal(m.veredito, 'incompleto');
});
teste('lucro positivo continua derivando o payout de mercado', () => {
  const m = avaliarAtivo({ modo: 'lpa', cotacao: 10, lpaInformado: '2,00', dpa12mMercado: 1 }, { yieldPadrao: 6 });
  perto(m.payoutDeMercado, 50);
  perto(m.dpa, 1);
});
teste('yield fora da faixa razoável é marcado como suspeito', () => {
  const erroDeUnidade = avaliarAtivo({ modo: 'dividendo', cotacao: 20, dpaInformado: '1,00', yieldAceitavel: '0,06' }, {});
  assert.equal(erroDeUnidade.yieldSuspeito, true, '0,06 é quem quis digitar 6%');
  perto(erroDeUnidade.precoTeto, 1666.67, 0.1);
  const exagerado = avaliarAtivo({ modo: 'dividendo', cotacao: 20, dpaInformado: '1,00', yieldAceitavel: '90' }, {});
  assert.equal(exagerado.yieldSuspeito, true);
  const normal = avaliarAtivo({ modo: 'dividendo', cotacao: 20, dpaInformado: '1,00', yieldAceitavel: '6' }, {});
  assert.equal(normal.yieldSuspeito, false);
});

console.log('posição: quanto eu tenho, quanto rende');
const posicaoBase = {
  ticker: 'BBAS3', modo: 'dividendo', cotacao: '23,10', dpaInformado: '2,18',
  quantidade: '300', precoMedio: '20,00',
};
teste('valor investido, valor de hoje e resultado', () => {
  const m = avaliarAtivo(posicaoBase, { yieldPadrao: 6 });
  perto(m.valorInvestido, 6000);
  perto(m.valorAtual, 6930);
  perto(m.resultado, 930);
  perto(m.resultadoPct, 0.155, 0.001);
});
teste('renda anual e mensal saem do DPA da própria linha', () => {
  const m = avaliarAtivo(posicaoBase, {});
  perto(m.rendaAnual, 654);
  perto(m.rendaMensal, 54.5);
});
teste('yield on cost é sobre o preço pago, não sobre a cotação', () => {
  const m = avaliarAtivo(posicaoBase, {});
  perto(m.yieldOnCost, 2.18 / 20, 0.0001);
  perto(m.yieldAtual, 2.18 / 23.1, 0.0001);
});
teste('quantidade sem preço médio ainda dá valor de hoje e renda', () => {
  const m = avaliarAtivo({ ...posicaoBase, precoMedio: '' }, {});
  perto(m.valorAtual, 6930);
  perto(m.rendaAnual, 654);
  assert.equal(m.valorInvestido, null);
  assert.equal(m.resultado, null);
  assert.equal(m.yieldOnCost, null);
  assert.equal(m.posicaoIncompleta, true);
});
teste('sem quantidade, tudo da posição fica null — nunca R$ 0,00', () => {
  const m = avaliarAtivo({ ...posicaoBase, quantidade: '' }, {});
  for (const campo of ['posicao', 'valorInvestido', 'valorAtual', 'rendaAnual', 'rendaMensal', 'resultado', 'resultadoPct']) {
    assert.equal(m[campo], null, `${campo} deveria ser null`);
  }
  assert.equal(m.posicaoIncompleta, false, 'sem posição não é posição incompleta');
});
teste('quantidade zerada ou negativa não é posição', () => {
  assert.equal(avaliarAtivo({ ...posicaoBase, quantidade: '0' }, {}).posicao, null);
  assert.equal(avaliarAtivo({ ...posicaoBase, quantidade: '-300' }, {}).posicao, null);
});
teste('preço médio zero não gera yield infinito', () => {
  const m = avaliarAtivo({ ...posicaoBase, precoMedio: '0' }, {});
  assert.equal(m.yieldOnCost, null);
  assert.equal(m.resultadoPct, null);
});
teste('quantidade fracionada é aceita (sobra de subscrição, desdobramento)', () => {
  perto(avaliarAtivo({ ...posicaoBase, quantidade: '10,5' }, {}).valorAtual, 242.55);
});
teste('a posição não interfere no preço-teto nem no veredito', () => {
  const comPosicao = avaliarAtivo(posicaoBase, { yieldPadrao: 6 });
  const semPosicao = avaliarAtivo({ ...posicaoBase, quantidade: '', precoMedio: '' }, { yieldPadrao: 6 });
  perto(comPosicao.precoTeto, semPosicao.precoTeto);
  assert.equal(comPosicao.veredito, semPosicao.veredito);
  assert.deepEqual(comPosicao.faltando, semPosicao.faltando);
});
teste('ativo em prejuízo não gera renda negativa', () => {
  const m = avaliarAtivo({ modo: 'lpa', cotacao: '10', lpaInformado: '-1', payout: '50', quantidade: '100', precoMedio: '9' }, {});
  assert.equal(m.rendaAnual, null);
  assert.equal(m.yieldOnCost, null);
  perto(m.valorAtual, 1000);
});

console.log('totais da carteira');
const carteiraDeTeste = [
  { ticker: 'BBAS3', modo: 'dividendo', cotacao: '23,10', dpaInformado: '2,18', quantidade: '300', precoMedio: '20,00' },
  { ticker: 'XPLG11', modo: 'dividendo', cotacao: '95,50', dpaInformado: '8,77', quantidade: '50' },
  { ticker: 'VALE3', modo: 'lpa', cotacao: '60,00', lpaInformado: '8,00', payout: '40', quantidade: '100', precoMedio: '55,00' },
  { ticker: 'SEMPOSICAO3', modo: 'lpa', cotacao: '10,00', lpaInformado: '1', payout: '50' },
];
teste('soma valor de hoje de todas as posições', () => {
  const { resumo } = avaliarCarteira(carteiraDeTeste, { yieldPadrao: 6 });
  assert.equal(resumo.carteira.ativos, 3);
  perto(resumo.carteira.valorAtual, 6930 + 4775 + 6000);
});
teste('resultado e yield on cost usam só quem tem custo E cotação', () => {
  const { resumo } = avaliarCarteira(carteiraDeTeste, {});
  const c = resumo.carteira;
  perto(c.valorInvestido, 6000 + 5500);
  perto(c.resultado, (6930 + 6000) - (6000 + 5500));
  // XPLG11 não entra: sem preço médio, somar o valor dele inflaria o lucro.
  perto(c.resultadoPct, 1430 / 11500, 0.0001);
  perto(c.yieldOnCost, (654 + 320) / 11500, 0.0001);
  assert.equal(c.comparaveis, 2);
  assert.equal(c.semPrecoMedio, 1);
});
teste('renda mensal da carteira inclui quem não informou preço médio', () => {
  const { resumo } = avaliarCarteira(carteiraDeTeste, {});
  perto(resumo.carteira.rendaAnual, 654 + 438.5 + 320);
  perto(resumo.carteira.rendaMensal, (654 + 438.5 + 320) / 12);
});
teste('carteira sem nenhuma posição devolve null, não zero', () => {
  const { resumo } = avaliarCarteira([{ ticker: 'A', modo: 'lpa', cotacao: '10' }], {});
  assert.equal(resumo.carteira.ativos, 0);
  assert.equal(resumo.carteira.valorAtual, null);
  assert.equal(resumo.carteira.rendaMensal, null);
  assert.equal(resumo.carteira.yieldOnCost, null);
});
teste('carteira vazia não quebra os totais', () => {
  const { resumo } = avaliarCarteira([], {});
  assert.equal(resumo.carteira.valorAtual, null);
  assert.equal(resumo.carteira.semCotacao, 0);
});
teste('conta quem está sem cotação e sem provento, para a tela explicar', () => {
  const { resumo } = avaliarCarteira([
    { ticker: 'A', modo: 'lpa', quantidade: '10', precoMedio: '5' },
    { ticker: 'B', modo: 'dividendo', cotacao: '10', quantidade: '10', precoMedio: '5' },
  ], {});
  assert.equal(resumo.carteira.semCotacao, 1);
  assert.equal(resumo.carteira.semProvento, 2);
});

console.log('simulação de compra');
teste('a compra é somada à posição e o preço médio vira média ponderada', () => {
  const { ativos, custo, compras } = Calc.simularCompras([
    { ticker: 'BBAS3', modo: 'dividendo', cotacao: '23,10', dpaInformado: '2,18', quantidade: '300', precoMedio: '20,00', simulacaoQtd: '200' },
  ]);
  assert.equal(compras, 1);
  perto(custo, 4620);
  assert.equal(ativos[0].quantidade, 500);
  perto(ativos[0].precoMedio, (300 * 20 + 200 * 23.1) / 500);
});
teste('sem cotação não dá para simular: a linha fica de fora e é reportada', () => {
  const r = Calc.simularCompras([{ ticker: 'SEMCOT', modo: 'dividendo', dpaInformado: '2', quantidade: '100', simulacaoQtd: '100' }]);
  assert.equal(r.compras, 0);
  assert.equal(r.custo, null);
  assert.deepEqual(r.semCotacao, ['SEMCOT']);
  assert.equal(r.ativos[0].quantidade, '100', 'a posição não é alterada');
});
teste('sem preço médio informado, o preço médio da soma continua desconhecido', () => {
  // Fingir que as ações antigas saíram ao preço de hoje mudaria o yield sobre o
  // custo da carteira inteira, inventando um custo que a pessoa nunca informou.
  const { ativos } = Calc.simularCompras([
    { ticker: 'X', modo: 'dividendo', cotacao: '10', dpaInformado: '1', quantidade: '100', simulacaoQtd: '50' },
  ]);
  assert.equal(ativos[0].precoMedio, '');
  assert.equal(Calc.avaliarAtivo(ativos[0], {}).yieldOnCost, null);
});
teste('posição nova estreia com o preço de hoje como preço médio', () => {
  const { ativos } = Calc.simularCompras([{ ticker: 'NOVO', modo: 'dividendo', cotacao: '20', dpaInformado: '2', simulacaoQtd: '10' }]);
  assert.equal(ativos[0].quantidade, 10);
  assert.equal(ativos[0].precoMedio, 20);
});
teste('venda reduz a posição, devolve caixa e mantém o preço médio', () => {
  const { ativos, caixa } = Calc.simularCompras([
    { ticker: 'X', modo: 'dividendo', cotacao: '10', dpaInformado: '1', quantidade: '100', precoMedio: '8', simulacaoQtd: '-40' },
  ]);
  assert.equal(ativos[0].quantidade, 60);
  assert.equal(ativos[0].precoMedio, 8);
  perto(caixa, 400);
});
teste('venda maior que a posição zera sem virar posição negativa', () => {
  const { ativos, caixa } = Calc.simularCompras([
    { ticker: 'X', modo: 'dividendo', cotacao: '10', dpaInformado: '1', quantidade: '100', precoMedio: '8', simulacaoQtd: '-400' },
  ]);
  assert.equal(ativos[0].quantidade, 0);
  perto(caixa, 1000, 0.01);
});

console.log('base da projeção');
teste('yield da carteira só conta quem tem valor E renda', () => {
  // Um ativo que paga provento mas está sem cotação entrava na renda e não no
  // valor: o yield saía inflado e a projeção multiplicava a renda futura.
  const { resumo } = avaliarCarteira([
    { ticker: 'A', modo: 'dividendo', cotacao: '10', dpaInformado: '1', quantidade: '100', precoMedio: '9' },
    { ticker: 'B', modo: 'dividendo', dpaInformado: '2', quantidade: '100' },
  ], {});
  const c = resumo.carteira;
  perto(c.valorAtual, 1000);
  perto(c.rendaAnual, 300);
  perto(c.valorQueRende, 1000);
  perto(c.rendaDeQuemTemCotacao, 100);
  perto(c.rendaDeQuemTemCotacao / c.valorQueRende, 0.10, 0.0001);
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
