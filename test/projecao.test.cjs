const assert = require('node:assert/strict');
const { projetar, porAno } = require('../assets/projecao.js');

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

console.log('projetar');
teste('o yield vem da própria carteira: renda anual ÷ valor de hoje', () => {
  const { yieldAnual } = projetar({ patrimonio: 100000, rendaAnual: 8000, meses: 12 });
  perto(yieldAnual, 0.08, 0.0001);
});
teste('sem aporte e sem reinvestir, o patrimônio fica parado e a renda é constante', () => {
  const { serie, resumo } = projetar({ patrimonio: 100000, rendaAnual: 12000, aporteMensal: 0, reinvestir: false, meses: 12 });
  assert.equal(serie.length, 12);
  perto(resumo.patrimonioFinal, 100000);
  perto(resumo.recebido, 12000, 0.5);
  perto(serie[0].rendaMensal, 1000, 0.5);
  perto(serie[11].rendaMensal, 1000, 0.5);
});
teste('reinvestir faz a renda crescer sozinha, sem nenhum aporte', () => {
  const { serie } = projetar({ patrimonio: 100000, rendaAnual: 12000, aporteMensal: 0, reinvestir: true, meses: 12 });
  assert.ok(serie[11].rendaMensal > serie[0].rendaMensal, 'a renda do mês 12 supera a do mês 1');
  // 1% ao mês capitalizado por 12 meses: 100.000 x 1,01^12 = 112.682,50
  perto(serie[11].patrimonio, 100000 * 1.01 ** 12, 1);
});
teste('o aporte entra no patrimônio e é contado como dinheiro do bolso', () => {
  const { serie } = projetar({ patrimonio: 10000, rendaAnual: 0, aporteMensal: 500, meses: 10, reinvestir: false });
  perto(serie[9].aportado, 15000);
  perto(serie[9].patrimonio, 15000);
});
teste('crescimento faz dividendo e preço subirem juntos, mantendo o yield', () => {
  const sem = projetar({ patrimonio: 100000, rendaAnual: 6000, meses: 120, reinvestir: false });
  const com = projetar({ patrimonio: 100000, rendaAnual: 6000, meses: 120, reinvestir: false, crescimentoAnual: 5 });
  assert.ok(com.resumo.rendaMensalFinal > sem.resumo.rendaMensalFinal * 1.5);
  // 100.000 x 1,05^10 = 162.889 — o preço acompanha o dividendo.
  perto(com.resumo.patrimonioFinal, 100000 * 1.05 ** 10, 200);
  // E o yield continua o mesmo: renda do último mês sobre o patrimônio daquele mês.
  const ultimo = com.serie[com.serie.length - 1];
  perto((ultimo.rendaMensal * 12) / ultimo.patrimonio, 0.06, 0.0005);
});
teste('sem crescimento, o preço fica parado — o patrimônio só cresce com aporte e reinvestimento', () => {
  const { resumo } = projetar({ patrimonio: 100000, rendaAnual: 6000, meses: 120, reinvestir: false, aporteMensal: 0 });
  perto(resumo.patrimonioFinal, 100000, 0.01);
});
teste('sem patrimônio não há taxa para projetar: série vazia, não zero disfarçado', () => {
  const vazia = projetar({ patrimonio: 0, rendaAnual: 0, aporteMensal: 300 });
  assert.deepEqual(vazia.serie, []);
  assert.equal(vazia.yieldAnual, null);
  assert.equal(vazia.resumo.patrimonioFinal, null);
});
teste('entrada inválida não gera NaN nem laço infinito', () => {
  const r = projetar({ patrimonio: Number.NaN, rendaAnual: 'muito', aporteMensal: Infinity, meses: -5 });
  assert.deepEqual(r.serie, []);
  const s = projetar({ patrimonio: 1000, rendaAnual: 100, meses: 99999 });
  assert.ok(s.serie.length <= 600, 'o horizonte é limitado');
  assert.ok(s.serie.every((p) => Number.isFinite(p.patrimonio) && Number.isFinite(p.rendaMensal)));
});
teste('valores negativos são tratados como zero, não invertem a conta', () => {
  const r = projetar({ patrimonio: 1000, rendaAnual: -500, aporteMensal: -100, meses: 6 });
  assert.equal(r.yieldAnual, 0);
  assert.ok(r.serie.every((p) => p.rendaMensal === 0 && p.patrimonio === 1000));
});

console.log('porAno');
teste('devolve um ponto por ano fechado', () => {
  const { serie } = projetar({ patrimonio: 1000, rendaAnual: 60, meses: 42 });
  const anos = porAno(serie);
  assert.deepEqual(anos.map((p) => p.ano), [1, 2, 3]);
});
teste('série curta demais não inventa ano nenhum', () => {
  assert.deepEqual(porAno(projetar({ patrimonio: 1000, rendaAnual: 60, meses: 6 }).serie), []);
  assert.deepEqual(porAno([]), []);
  assert.deepEqual(porAno(null), []);
});

console.log(falhas ? `\n${falhas} teste(s) de projeção falharam` : '\nTodos os testes de projeção passaram');
process.exit(falhas ? 1 : 0);
