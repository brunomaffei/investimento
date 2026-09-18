const assert = require('node:assert/strict');
const { lerTabela, mapearColunas, buscarUniverso, buscarTudo } = require('../assets/fundamentus.js');

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
async function testeAsync(nome, fn) {
  try {
    await fn();
    console.log(`  ok   ${nome}`);
  } catch (erro) {
    falhas++;
    console.log(`  FALHA ${nome}\n        ${erro.message}`);
  }
}
const perto = (a, b, tol = 0.001) =>
  assert.ok(Math.abs(a - b) <= tol, `esperado ~${b}, recebido ${a}`);

// Cabeçalhos iguais aos das páginas reais, inclusive a pegadinha "Liq. Corr."
const CABECALHO_ACOES = ['Papel', 'Cotação', 'P/L', 'P/VP', 'PSR', 'Div.Yield', 'P/Ativo',
  'EV/EBIT', 'Mrg. Líq.', 'Liq. Corr.', 'ROIC', 'ROE', 'Liq.2meses', 'Patrim. Líq'];
const CABECALHO_FIIS = ['Papel', 'Segmento', 'Cotação', 'FFO Yield', 'Dividend Yield', 'P/VP',
  'Valor de Mercado', 'Liquidez', 'Qtd de imóveis', 'Preço do m2'];

const pagina = (cabecalho, linhas) => `
<html><body><table id="resultado">
<thead><tr>${cabecalho.map((c) => `<th><a href="#">${c}</a></th>`).join('')}</tr></thead>
<tbody>
${linhas.map((cols) => `<tr>${cols.map((c, i) => (i === 0
    ? `<td><a href="detalhes.php?papel=${c}">${c}</a></td>`
    : `<td>${c}</td>`)).join('')}</tr>`).join('\n')}
</tbody></table></body></html>`;

const HTML_ACOES = pagina(CABECALHO_ACOES, [
  ['BBAS3', '23,10', '3,52', '0,78', '0,90', '9,45%', '0,10', '2,10', '15,20%', '1,25', '12,3%', '20,1%', '1.250.300.000', '160.000.000.000'],
  ['PETR4', '31,05', '7,10', '1,05', '1,20', '12,80%', '0,30', '3,40', '20,10%', '0,98', '18,0%', '15,5%', '2.100.000.000', '380.000.000.000'],
  ['ZZZZ3', '1,20', '0,00', '0,50', '0,10', '0,00%', '0,05', '0,00', '-5,00%', '0,80', '0,0%', '-2,0%', '15.000', '900.000.000'],
]);

const HTML_FIIS = pagina(CABECALHO_FIIS, [
  ['XPLG11', 'Logística', '95,50', '9,50%', '9,18%', '0,92', '3.500.000.000', '12.000.000', '60', '2.800'],
  ['MXRF11', 'Híbrido', '9,80', '11,20%', '12,40%', '1,02', '4.100.000.000', '25.000.000', '', ''],
]);

console.log('mapearColunas');
teste('acha as colunas da página de ações sem confundir Liq. Corr. com Liq.2meses', () => {
  const i = mapearColunas(CABECALHO_ACOES);
  assert.deepEqual(i, { ticker: 0, cotacao: 1, pvp: 3, dy: 5, liquidez: 12 });
});
teste('acha as colunas da página de FIIs, inclusive segmento', () => {
  const i = mapearColunas(CABECALHO_FIIS);
  assert.deepEqual(i, { ticker: 0, segmento: 1, cotacao: 2, dy: 4, pvp: 5, liquidez: 7 });
});
teste('ordem diferente das colunas não quebra o mapeamento', () => {
  const i = mapearColunas(['Div.Yield', 'Papel', 'Cotação']);
  assert.deepEqual(i, { dy: 0, ticker: 1, cotacao: 2 });
});

console.log('lerTabela — ações');
const acoes = lerTabela(HTML_ACOES, 'acao');
teste('lê todas as linhas com ticker válido', () => {
  assert.deepEqual(acoes.map((a) => a.ticker), ['BBAS3', 'PETR4', 'ZZZZ3']);
  assert.ok(acoes.every((a) => a.tipo === 'acao'));
});
teste('cotação, DY e liquidez no formato brasileiro', () => {
  const bb = acoes[0];
  perto(bb.cotacao, 23.10);
  perto(bb.dy, 9.45);
  assert.equal(bb.liquidez, 1250300000);
  perto(bb.pvp, 0.78);
});
teste('DPA de 12 meses é cotação x dividend yield', () => {
  perto(acoes[0].dpa12m, 23.10 * 0.0945);
  perto(acoes[1].dpa12m, 31.05 * 0.128);
});
teste('quem não paga provento fica com DPA nulo, não zero', () => {
  const zzz = acoes[2];
  assert.equal(zzz.dy, 0);
  assert.equal(zzz.dpa12m, null);
});
teste('ações não têm segmento', () => {
  assert.equal(acoes[0].segmento, null);
});

console.log('lerTabela — FIIs');
const fiis = lerTabela(HTML_FIIS, 'fii');
teste('lê os FIIs com segmento e liquidez', () => {
  assert.deepEqual(fiis.map((f) => f.ticker), ['XPLG11', 'MXRF11']);
  assert.equal(fiis[0].segmento, 'Logística');
  assert.equal(fiis[0].liquidez, 12000000);
  assert.ok(fiis.every((f) => f.tipo === 'fii'));
});
teste('usa o Dividend Yield, não o FFO Yield', () => {
  perto(fiis[0].dy, 9.18);
  perto(fiis[0].dpa12m, 95.5 * 0.0918);
});
teste('célula vazia vira null em vez de zero', () => {
  assert.equal(fiis[1].segmento, 'Híbrido');
  assert.equal(lerTabela(pagina(CABECALHO_FIIS, [['AAAA11', '', '', '', '', '', '', '', '', '']]), 'fii')[0].cotacao, null);
});

console.log('lerTabela — robustez');
teste('página sem cabeçalho devolve lista vazia em vez de explodir', () => {
  assert.deepEqual(lerTabela('<html><body><p>fora do ar</p></body></html>', 'acao'), []);
  assert.deepEqual(lerTabela('', 'acao'), []);
});
teste('cabeçalho sem as colunas essenciais devolve lista vazia', () => {
  assert.deepEqual(lerTabela(pagina(['Nome', 'Endereço'], [['a', 'b']]), 'acao'), []);
});
teste('linha que não é ticker da B3 é ignorada', () => {
  const html = pagina(CABECALHO_ACOES, [['Total', '—', '', '', '', '', '', '', '', '', '', '', '', '']]);
  assert.deepEqual(lerTabela(html, 'acao'), []);
});
teste('entidades HTML e marcação dentro da célula não atrapalham', () => {
  const html = pagina(CABECALHO_ACOES, [['TAEE11', '<b>35,40</b>', '', '', '', '8,10&nbsp;%', '', '', '', '', '', '', '4.000.000', '']]);
  const [taee] = lerTabela(html, 'acao');
  perto(taee.cotacao, 35.4);
  perto(taee.dy, 8.1);
});

console.log('buscarUniverso e buscarTudo');
(async () => {
  const respostaOk = (html) => ({ ok: true, status: 200, text: async () => html });

  await testeAsync('monta a URL de cada página e devolve os ativos', async () => {
    const chamadas = [];
    const ativos = await buscarUniverso('acao', {
      base: 'http://fonte-falsa',
      fetchImpl: async (url) => { chamadas.push(url); return respostaOk(HTML_ACOES); },
    });
    assert.deepEqual(chamadas, ['http://fonte-falsa/resultado.php']);
    assert.equal(ativos.length, 3);
  });

  await testeAsync('resposta não-2xx vira erro com o status', async () => {
    await assert.rejects(
      () => buscarUniverso('fii', { base: 'http://fonte-falsa', fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' }) }),
      /503/,
    );
  });

  await testeAsync('tipo desconhecido é recusado', async () => {
    await assert.rejects(() => buscarUniverso('cripto', { fetchImpl: async () => respostaOk('') }), /desconhecido/i);
  });

  // A página real vem em ISO-8859-1. Lida como UTF-8, "Cotação" viraria lixo, o
  // cabeçalho não seria reconhecido e a tabela sairia vazia sem nenhum erro.
  const emLatin1 = (html) => {
    const bytes = Buffer.from(html, 'latin1');
    return (contentType) => ({
      ok: true,
      status: 200,
      headers: { get: () => contentType },
      arrayBuffer: async () => bytes,
    });
  };

  await testeAsync('página em ISO-8859-1 é lida pelo charset do cabeçalho HTTP', async () => {
    const resposta = emLatin1(HTML_FIIS)('text/html; charset=ISO-8859-1');
    const [xp] = await buscarUniverso('fii', { base: 'http://fonte-falsa', fetchImpl: async () => resposta });
    assert.equal(xp.ticker, 'XPLG11');
    assert.equal(xp.segmento, 'Logística');
    perto(xp.cotacao, 95.5);
  });

  await testeAsync('sem charset no cabeçalho, ainda assim não sai acento quebrado', async () => {
    const [xp] = await buscarUniverso('fii', {
      base: 'http://fonte-falsa',
      fetchImpl: async () => emLatin1(HTML_FIIS)('text/html'),
    });
    assert.equal(xp.segmento, 'Logística');
    assert.ok(!JSON.stringify(xp).includes('\uFFFD'), 'não pode sobrar caractere inválido');
  });

  await testeAsync('página que é mesmo UTF-8 continua correta', async () => {
    const bytes = Buffer.from(HTML_FIIS, 'utf8');
    const [xp] = await buscarUniverso('fii', {
      base: 'http://fonte-falsa',
      fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => 'text/html; charset=utf-8' }, arrayBuffer: async () => bytes }),
    });
    assert.equal(xp.segmento, 'Logística');
  });

  await testeAsync('buscarTudo junta ações e FIIs numa lista só', async () => {
    const { ativos, erros } = await buscarTudo({
      base: 'http://fonte-falsa',
      fetchImpl: async (url) => respostaOk(url.includes('fii') ? HTML_FIIS : HTML_ACOES),
    });
    assert.deepEqual(erros, []);
    assert.equal(ativos.length, 5);
    assert.equal(ativos.filter((a) => a.tipo === 'fii').length, 2);
  });

  await testeAsync('uma página fora do ar não derruba a outra', async () => {
    const { ativos, erros } = await buscarTudo({
      base: 'http://fonte-falsa',
      fetchImpl: async (url) => (url.includes('fii')
        ? { ok: false, status: 500, text: async () => '' }
        : respostaOk(HTML_ACOES)),
    });
    assert.equal(ativos.length, 3);
    assert.equal(erros.length, 1);
    assert.match(erros[0], /FIIs/);
  });

  console.log(falhas ? `\n${falhas} teste(s) falharam` : '\nTodos os testes do Fundamentus passaram');
  process.exit(falhas ? 1 : 0);
})();
