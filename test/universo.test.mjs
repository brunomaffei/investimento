/**
 * Testes do /api/universo: o endpoint que entrega o mercado inteiro ao rastreador.
 * Um "Fundamentus falso" sobe em memória e o servidor é apontado para ele via
 * FUNDAMENTUS_BASE — nada aqui depende de internet.
 */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { subirServidor } from './ajuda.mjs';

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

const pagina = (cabecalho, linhas) => `<table>
<tr>${cabecalho.map((c) => `<th>${c}</th>`).join('')}</tr>
${linhas.map((l) => `<tr>${l.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}
</table>`;

const HTML_ACOES = pagina(['Papel', 'Cotação', 'P/VP', 'Div.Yield', 'Liq. Corr.', 'Liq.2meses'], [
  ['BBAS3', '23,10', '0,78', '9,45%', '1,25', '1.250.300.000'],
  ['PETR4', '31,05', '1,05', '12,80%', '0,98', '2.100.000.000'],
]);
const HTML_FIIS = pagina(['Papel', 'Segmento', 'Cotação', 'FFO Yield', 'Dividend Yield', 'P/VP', 'Liquidez'], [
  ['XPLG11', 'Logística', '95,50', '9,50%', '9,18%', '0,92', '12.000.000'],
]);

// ---- Fundamentus falso -----------------------------------------------------
let respostaDaFonte = 'ok';
const pedidos = [];
const fonte = createServer((pedido, resposta) => {
  pedidos.push(pedido.url);
  if (respostaDaFonte === 'fora-do-ar') return resposta.writeHead(503).end('indisponível');
  // Como a página real: bytes em ISO-8859-1, não em UTF-8.
  resposta.writeHead(200, { 'Content-Type': 'text/html; charset=iso-8859-1' });
  resposta.end(Buffer.from(pedido.url.includes('fii') ? HTML_FIIS : HTML_ACOES, 'latin1'));
});
fonte.listen(0);
await once(fonte, 'listening');

const pastaDoCache = await mkdtemp(join(tmpdir(), 'universo-teste-'));
const { porta, processo: servidor } = await subirServidor([], {
  FUNDAMENTUS_BASE: `http://127.0.0.1:${fonte.address().port}`,
  UNIVERSO_CACHE_DIR: pastaDoCache,
  UNIVERSO_HORAS: '6',
});
const url = (caminho) => `http://127.0.0.1:${porta}${caminho}`;
const pegar = async (caminho) => {
  const resposta = await fetch(url(caminho));
  return { status: resposta.status, corpo: await resposta.json() };
};

try {
  await teste('/api/health avisa que o rastreador existe', async () => {
    const { corpo } = await pegar('/api/health');
    assert.equal(corpo.comUniverso, true);
  });

  await teste('traz ações e FIIs numa lista só, com o preço-teto já calculável', async () => {
    const { status, corpo } = await pegar('/api/universo');
    assert.equal(status, 200);
    assert.equal(corpo.ativos.length, 3);
    const bb = corpo.ativos.find((a) => a.ticker === 'BBAS3');
    assert.equal(bb.tipo, 'acao');
    assert.ok(Math.abs(bb.dpa12m - 23.10 * 0.0945) < 0.001, `DPA inesperado: ${bb.dpa12m}`);
    assert.equal(bb.liquidez, 1250300000, 'liquidez deve ser a de 2 meses, não a corrente');
    const fii = corpo.ativos.find((a) => a.ticker === 'XPLG11');
    assert.equal(fii.tipo, 'fii');
    assert.equal(fii.segmento, 'Logística');
  });

  await teste('busca as duas páginas da fonte', async () => {
    assert.ok(pedidos.some((p) => p.includes('/resultado.php')), 'faltou a página de ações');
    assert.ok(pedidos.some((p) => p.includes('/fii_resultado.php')), 'faltou a página de FIIs');
  });

  await teste('segunda chamada usa o cache, sem bater na fonte de novo', async () => {
    const antes = pedidos.length;
    const { corpo } = await pegar('/api/universo');
    assert.equal(pedidos.length, antes, 'não deveria ter consultado a fonte');
    assert.equal(corpo.doCache, true);
    assert.equal(corpo.ativos.length, 3);
    assert.ok(typeof corpo.idadeMinutos === 'number');
  });

  await teste('forcar=1 ignora o cache e consulta a fonte', async () => {
    const antes = pedidos.length;
    const { corpo } = await pegar('/api/universo?forcar=1');
    assert.equal(pedidos.length, antes + 2, 'deveria consultar as duas páginas');
    assert.equal(corpo.doCache, false);
  });

  await teste('fonte fora do ar devolve o cache antigo avisando, em vez de tela vazia', async () => {
    respostaDaFonte = 'fora-do-ar';
    const { status, corpo } = await pegar('/api/universo?forcar=1');
    assert.equal(status, 200);
    assert.equal(corpo.doCache, true);
    assert.equal(corpo.ativos.length, 3);
    assert.ok(corpo.erros.length, 'o motivo da falha precisa chegar na tela');
    assert.match(corpo.erros.join(' '), /503/);
  });

  await teste('sem cache nenhum, a falha vira erro claro com HTTP 502', async () => {
    const pastaVazia = await mkdtemp(join(tmpdir(), 'universo-vazio-'));
    const outro = await subirServidor([], {
      FUNDAMENTUS_BASE: `http://127.0.0.1:${fonte.address().port}`,
      UNIVERSO_CACHE_DIR: pastaVazia,
    });
    try {
      const resposta = await fetch(`http://127.0.0.1:${outro.porta}/api/universo`);
      assert.equal(resposta.status, 502);
      const corpo = await resposta.json();
      assert.match(corpo.erro, /universo/i);
      assert.match(corpo.erro, /503/);
    } finally {
      outro.processo.kill();
      await rm(pastaVazia, { recursive: true, force: true });
    }
  });

  await teste('o cache sobrevive ao reinício do servidor', async () => {
    respostaDaFonte = 'fora-do-ar';
    const reiniciado = await subirServidor([], {
      FUNDAMENTUS_BASE: `http://127.0.0.1:${fonte.address().port}`,
      UNIVERSO_CACHE_DIR: pastaDoCache,
    });
    try {
      const resposta = await fetch(`http://127.0.0.1:${reiniciado.porta}/api/universo`);
      const corpo = await resposta.json();
      assert.equal(resposta.status, 200);
      assert.equal(corpo.ativos.length, 3, 'deveria ler o arquivo gravado pelo servidor anterior');
      assert.equal(corpo.doCache, true);
    } finally {
      reiniciado.processo.kill();
    }
  });
} finally {
  servidor.kill();
  fonte.close();
  await rm(pastaDoCache, { recursive: true, force: true });
}

console.log(falhas ? `\n${falhas} teste(s) do universo falharam` : '\nTodos os testes do universo passaram');
process.exit(falhas ? 1 : 0);
