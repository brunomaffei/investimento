const assert = require('node:assert/strict');
const { rastrear, filtrar, ordenar, paraAtivo, alertasDe } = require('../assets/rastreador.js');
const { avaliarAtivo } = require('../assets/calc.js');

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

const papel = (extra) => ({
  ticker: 'AAAA3', tipo: 'acao', cotacao: 10, dy: 6, dpa12m: 0.6,
  liquidez: 1e7, pvp: 1, segmento: null, ...extra,
});

const UNIVERSO = [
  papel({ ticker: 'BBAS3', cotacao: 23.10, dy: 9.45, dpa12m: 2.18295, liquidez: 1.25e9, pvp: 0.78 }),
  papel({ ticker: 'PETR4', cotacao: 31.05, dy: 12.8, dpa12m: 3.9744, liquidez: 2.1e9, pvp: 1.05 }),
  papel({ ticker: 'CARO3', cotacao: 100, dy: 2, dpa12m: 2, liquidez: 5e7, pvp: 3 }),
  papel({ ticker: 'ZZZZ3', cotacao: 1.2, dy: 0, dpa12m: null, liquidez: 15000, pvp: 0.5 }),
  papel({ ticker: 'XPLG11', tipo: 'fii', cotacao: 95.5, dy: 9.18, dpa12m: 8.7665, liquidez: 1.2e7, segmento: 'Logística', pvp: 0.92 }),
  papel({ ticker: 'MXRF11', tipo: 'fii', cotacao: 9.8, dy: 12.4, dpa12m: 1.2152, liquidez: 2.5e7, segmento: 'Híbrido', pvp: 1.02 }),
];
const CONFIG = { yieldPadrao: 6, margemMinima: 0 };

console.log('a conta é a mesma da carteira');
teste('preço-teto = provento de 12 meses / yield aceitável', () => {
  const { visiveis } = rastrear([UNIVERSO[0]], CONFIG);
  const [bb] = visiveis;
  perto(bb.metricas.precoTeto, 2.18295 / 0.06); // R$ 36,38
  perto(bb.metricas.margem, (2.18295 / 0.06) / 23.10 - 1); // +57,5%
  assert.equal(bb.metricas.veredito, 'sim');
});
teste('cada papel passa por Calc.avaliarAtivo, sem conta paralela', () => {
  const { visiveis } = rastrear(UNIVERSO, CONFIG, { limite: null });
  visiveis.forEach(({ item, metricas }) => {
    assert.deepEqual(metricas, avaliarAtivo(paraAtivo(item), CONFIG));
  });
});
teste('yield aceitável maior derruba o teto', () => {
  const { visiveis } = rastrear([UNIVERSO[0]], { yieldPadrao: 9 });
  perto(visiveis[0].metricas.precoTeto, 2.18295 / 0.09); // R$ 24,26
});
teste('margem mínima exigida muda o veredito, não o teto', () => {
  const [semExigencia] = rastrear([UNIVERSO[2]], { yieldPadrao: 6, margemMinima: 0 }).visiveis;
  const [comExigencia] = rastrear([UNIVERSO[2]], { yieldPadrao: 6, margemMinima: 30 }).visiveis;
  // CARO3: teto 33,33 contra cotação 100 -> margem negativa, não passa em nenhum caso.
  assert.equal(semExigencia.metricas.veredito, 'nao');
  assert.equal(comExigencia.metricas.veredito, 'nao');
  const folgado = rastrear([papel({ cotacao: 10, dy: 6, dpa12m: 0.7 })], { yieldPadrao: 6, margemMinima: 30 }).visiveis[0];
  perto(folgado.metricas.margem, 0.1667);
  assert.equal(folgado.metricas.veredito, 'nao', 'margem de 16,7% não cumpre exigência de 30%');
});
teste('papel sem provento fica incompleto em vez de virar teto zero', () => {
  const [zzz] = rastrear([UNIVERSO[3]], CONFIG, { ocultarSemProvento: false }).visiveis;
  assert.equal(zzz.metricas.precoTeto, null);
  assert.equal(zzz.metricas.veredito, 'incompleto');
});

console.log('paraAtivo');
teste('vira linha de carteira no modo dividendo', () => {
  const a = paraAtivo(UNIVERSO[4]);
  assert.equal(a.modo, 'dividendo');
  assert.equal(a.dpaInformado, 8.7665);
  assert.equal(a.setor, 'Logística');
  assert.equal(a.fonteProventos, 'fundamentus');
});
teste('FII sem segmento ainda é identificado como FII', () => {
  assert.equal(paraAtivo(papel({ tipo: 'fii', segmento: null })).setor, 'FII');
});

console.log('alertas');
teste('avisa sobre DY extraordinário, DY irrisório e liquidez baixa', () => {
  assert.match(alertasDe(papel({ dy: 45, dpa12m: 4.5 }))[0], /extraordinário/);
  assert.match(alertasDe(papel({ dy: 0.4, dpa12m: 0.04 }))[0], /muito baixo/);
  assert.match(alertasDe(papel({ liquidez: 5000 })).join(' '), /liquidez baixa/i);
  assert.match(alertasDe(papel({ dpa12m: null }))[0], /sem provento/);
});
teste('papel comum não gera alerta', () => {
  assert.deepEqual(alertasDe(UNIVERSO[0]), []);
});

console.log('filtros');
const linhas = UNIVERSO.map((item) => ({ item, metricas: avaliarAtivo(paraAtivo(item), CONFIG), alertas: alertasDe(item) }));
teste('por tipo', () => {
  assert.deepEqual(filtrar(linhas, { tipo: 'fii' }).map((l) => l.item.ticker), ['XPLG11', 'MXRF11']);
  assert.equal(filtrar(linhas, { tipo: 'acao' }).length, 3); // ZZZZ3 sai por não pagar provento
  assert.equal(filtrar(linhas, { tipo: 'todos' }).length, 5);
});
teste('quem não paga provento sai por padrão e volta se pedirem', () => {
  assert.ok(!filtrar(linhas, {}).some((l) => l.item.ticker === 'ZZZZ3'));
  assert.ok(filtrar(linhas, { ocultarSemProvento: false }).some((l) => l.item.ticker === 'ZZZZ3'));
});
teste('só os que estão abaixo do teto', () => {
  const so = filtrar(linhas, { somenteSim: true }).map((l) => l.item.ticker);
  assert.ok(so.includes('BBAS3') && so.includes('PETR4'));
  assert.ok(!so.includes('CARO3'), 'CARO3 está acima do teto');
});
teste('liquidez mínima aceita atalho de escala e não some com liquidez desconhecida', () => {
  const comCorte = filtrar(linhas, { liquidezMinima: '1 bi' }).map((l) => l.item.ticker);
  assert.deepEqual(comCorte, ['BBAS3', 'PETR4']);
  const semDado = [{ item: papel({ ticker: 'SEMD3', liquidez: null }), metricas: avaliarAtivo(paraAtivo(papel({ liquidez: null })), CONFIG), alertas: [] }];
  assert.equal(filtrar(semDado, { liquidezMinima: '1 bi' }).length, 1);
});
teste('busca por ticker e por segmento, sem acento e sem caixa', () => {
  assert.deepEqual(filtrar(linhas, { busca: 'bbas' }).map((l) => l.item.ticker), ['BBAS3']);
  assert.deepEqual(filtrar(linhas, { busca: 'LOGISTICA' }).map((l) => l.item.ticker), ['XPLG11']);
  assert.deepEqual(filtrar(linhas, { busca: 'híbrido' }).map((l) => l.item.ticker), ['MXRF11']);
});

console.log('ordenação');
teste('por margem, do maior desconto para o menor', () => {
  const ordem = ordenar(linhas, { ordenarPor: 'margem', decrescente: true }).map((l) => l.item.ticker);
  assert.equal(ordem[ordem.length - 1], 'ZZZZ3', 'sem margem calculada vai para o fim');
  const margens = ordenar(linhas, { ordenarPor: 'margem', decrescente: true })
    .map((l) => l.metricas.margem).filter((m) => m !== null);
  assert.deepEqual(margens, [...margens].sort((a, b) => b - a));
});
teste('linha sem dado fica no fim nas duas direções', () => {
  const crescente = ordenar(linhas, { ordenarPor: 'margem', decrescente: false }).map((l) => l.item.ticker);
  assert.equal(crescente[crescente.length - 1], 'ZZZZ3');
});
teste('por ticker usa ordem alfabética brasileira', () => {
  const ordem = ordenar(linhas, { ordenarPor: 'ticker', decrescente: false }).map((l) => l.item.ticker);
  assert.deepEqual(ordem, ['BBAS3', 'CARO3', 'MXRF11', 'PETR4', 'XPLG11', 'ZZZZ3']);
});
teste('campo desconhecido cai na margem em vez de embaralhar', () => {
  assert.deepEqual(
    ordenar(linhas, { ordenarPor: 'inventado' }).map((l) => l.item.ticker),
    ordenar(linhas, { ordenarPor: 'margem' }).map((l) => l.item.ticker),
  );
});

console.log('resumo e limite');
teste('resumo conta universo, filtrados e quem está abaixo do teto', () => {
  const { resumo } = rastrear(UNIVERSO, CONFIG, { limite: null });
  assert.equal(resumo.universo, 6);
  assert.equal(resumo.acoes, 4);
  assert.equal(resumo.fiis, 2);
  assert.equal(resumo.filtrados, 5); // ZZZZ3 fora
  assert.equal(resumo.mostrados, 5);
  assert.equal(resumo.comprar, 4);
  perto(resumo.melhorMargem, Math.max(...linhas.map((l) => l.metricas.margem).filter(Boolean)));
});
teste('limite corta a lista mas o resumo continua contando tudo', () => {
  const { visiveis, resumo } = rastrear(UNIVERSO, CONFIG, { limite: 2 });
  assert.equal(visiveis.length, 2);
  assert.equal(resumo.mostrados, 2);
  assert.equal(resumo.filtrados, 5);
});
teste('universo vazio não quebra', () => {
  const { visiveis, resumo } = rastrear([], CONFIG);
  assert.deepEqual(visiveis, []);
  assert.equal(resumo.universo, 0);
  assert.equal(resumo.melhorMargem, null);
});
teste('sem configuração nenhuma, vale o corte de 6% do Bazin', () => {
  const [linha] = rastrear([UNIVERSO[0]], {}).visiveis;
  perto(linha.metricas.precoTeto, 2.18295 / 0.06);
});

console.log(falhas ? `\n${falhas} teste(s) falharam` : '\nTodos os testes do rastreador passaram');
process.exit(falhas ? 1 : 0);
