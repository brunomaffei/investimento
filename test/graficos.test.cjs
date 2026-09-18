const assert = require('node:assert/strict');
const { rosca, barras, areaEmpilhada, linha } = require('../assets/graficos.js');

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
const perto = (a, b, tol = 0.02) =>
  assert.ok(Math.abs(a - b) <= tol, `esperado ~${b}, recebido ${a}`);

/** Geometria é o que prova que o desenho representa o dado, não que ele existe. */
const larguras = (svg) => [...svg.matchAll(/<rect[^>]*?width="([\d.]+)"[^>]*?data-valor="([\d.]+)"/g)]
  .map((m) => ({ largura: Number(m[1]), valor: Number(m[2]) }));

console.log('barras');
teste('a largura é proporcional ao valor', () => {
  const svg = barras([
    { rotulo: 'BBAS3', valor: 100 },
    { rotulo: 'ITSA4', valor: 50 },
    { rotulo: 'TAEE11', valor: 25 },
  ], { largura: 600 });
  const barrasDesenhadas = larguras(svg);
  assert.equal(barrasDesenhadas.length, 3);
  perto(barrasDesenhadas[0].largura / barrasDesenhadas[1].largura, 2, 0.01);
  perto(barrasDesenhadas[1].largura / barrasDesenhadas[2].largura, 2, 0.01);
});
teste('ordena do maior para o menor', () => {
  const svg = barras([{ rotulo: 'A', valor: 10 }, { rotulo: 'B', valor: 90 }], { largura: 600 });
  assert.ok(svg.indexOf('>B<') < svg.indexOf('>A<'), 'o maior vem primeiro');
});
teste('a parte simulada entra empilhada, em outra cor', () => {
  const svg = barras([{ rotulo: 'BBAS3', valor: 60, extra: 40 }], { largura: 600 });
  const base = Number(svg.match(/width="([\d.]+)"[^>]*data-valor="60"/)[1]);
  const extra = Number(svg.match(/width="([\d.]+)"[^>]*data-extra="40"/)[1]);
  perto(base / extra, 1.5, 0.01);
  assert.ok(svg.includes('simulação'), 'a parte simulada se identifica no tooltip');
});
teste('valor zero ou negativo não vira barra', () => {
  const svg = barras([{ rotulo: 'A', valor: 0 }, { rotulo: 'B', valor: -5 }, { rotulo: 'C', valor: 3 }], { largura: 600 });
  assert.equal(larguras(svg).length, 1);
});
teste('lista vazia devolve string vazia, não um eixo solitário', () => {
  assert.equal(barras([], { largura: 600 }), '');
  assert.equal(barras(null), '');
});
teste('valor inválido não vira atributo NaN', () => {
  const svg = barras([{ rotulo: 'A', valor: Number.NaN }, { rotulo: 'B', valor: Infinity }, { rotulo: 'C', valor: 5 }], { largura: 600 });
  assert.ok(!/NaN|Infinity/.test(svg), `saiu: ${svg.slice(0, 200)}`);
});
teste('um ativo só desenha a barra cheia sem dividir por zero', () => {
  const svg = barras([{ rotulo: 'UNICO3', valor: 42 }], { largura: 600 });
  assert.equal(larguras(svg).length, 1);
  assert.ok(!/NaN/.test(svg));
});
teste('ticker digitado pelo usuário não injeta HTML', () => {
  const svg = barras([{ rotulo: '<img src=x onerror=alert(1)>', valor: 5 }]);
  assert.ok(!svg.includes('<img'), 'a marcação precisa sair escapada');
  assert.ok(svg.includes('&lt;img'));
});

console.log('rosca');
teste('cada fatia recebe a fração do total', () => {
  const svg = rosca([{ rotulo: 'A', valor: 60 }, { rotulo: 'B', valor: 30 }, { rotulo: 'C', valor: 10 }], { largura: 600 });
  const fracoes = [...svg.matchAll(/data-fracao="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(fracoes, [0.6, 0.3, 0.1]);
});
teste('os arcos fecham o círculo', () => {
  const svg = rosca([{ rotulo: 'A', valor: 1 }, { rotulo: 'B', valor: 1 }, { rotulo: 'C', valor: 1 }], { largura: 600 });
  const arcos = [...svg.matchAll(/stroke-dasharray="([\d.]+) /g)].map((m) => Number(m[1]));
  const raio = Number(svg.match(/r="([\d.]+)"/)[1]);
  perto(arcos.reduce((s, a) => s + a, 0), 2 * Math.PI * raio, 0.5);
});
teste('a cauda vira uma fatia "Outros" em vez de 40 fatias ilegíveis', () => {
  const muitos = Array.from({ length: 12 }, (_, i) => ({ rotulo: `A${i}`, valor: 12 - i }));
  const svg = rosca(muitos, { largura: 600, maximoFatias: 8 });
  assert.equal([...svg.matchAll(/data-fracao=/g)].length, 9, '8 fatias + Outros');
  assert.ok(svg.includes('Outros (4)'));
});
teste('sem valor positivo não desenha nada', () => {
  assert.equal(rosca([{ rotulo: 'A', valor: 0 }], { largura: 600 }), '');
});

console.log('área empilhada e linha');
teste('a área precisa de pelo menos dois pontos', () => {
  assert.equal(areaEmpilhada([{ x: 1, base: 10, topo: 1 }], { largura: 600 }), '');
  assert.ok(areaEmpilhada([{ x: 1, base: 10, topo: 1 }, { x: 2, base: 20, topo: 4 }], { largura: 600 }).includes('<path'));
});
teste('as duas camadas saem identificadas', () => {
  const svg = areaEmpilhada([{ x: 1, base: 10, topo: 1 }, { x: 2, base: 20, topo: 6 }], { largura: 600 });
  assert.ok(svg.includes('data-camada="aportado"'));
  assert.ok(svg.includes('data-camada="reinvestido"'));
  assert.ok(!/NaN/.test(svg));
});
teste('a linha respeita a escala: o dobro do valor fica mais alto', () => {
  const svg = linha([{ x: 1, y: 100 }, { x: 2, y: 200 }], { largura: 600, altura: 200 });
  const ys = [...svg.matchAll(/<circle[^>]*cy="([\d.]+)"[^>]*data-y="([\d.]+)"/g)]
    .map((m) => ({ cy: Number(m[1]), y: Number(m[2]) }));
  assert.equal(ys.length, 2);
  assert.ok(ys[1].cy < ys[0].cy, 'valor maior fica mais acima no SVG');
});
teste('a linha de referência aparece quando informada', () => {
  const svg = linha([{ x: 1, y: 100 }, { x: 2, y: 200 }], { largura: 600, referencia: 100 });
  assert.ok(svg.includes('class="referencia"'));
});
teste('série toda zerada não quebra a escala', () => {
  const svg = linha([{ x: 1, y: 0 }, { x: 2, y: 0 }], { largura: 600 });
  assert.ok(!/NaN|Infinity/.test(svg));
});

console.log(falhas ? `\n${falhas} teste(s) de gráficos falharam` : '\nTodos os testes de gráficos passaram');
process.exit(falhas ? 1 : 0);
