/**
 * Prova o rastreador de ponta a ponta: Fundamentus falso + servidor real +
 * Chromium real. A tela precisa abrir já mostrando o mercado inteiro calculado,
 * filtrar, ordenar e levar um papel para a carteira.
 *
 *   npm i -D playwright-core && node test/rastreador.e2e.mjs
 */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { subirServidor } from './ajuda.mjs';
import { existsSync, globSync } from 'node:fs';

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.log('playwright-core não instalado — pule com: npm i -D playwright-core');
  process.exit(0);
}
const acharChromium = () => process.env.CHROMIUM_PATH
  || globSync('/opt/pw-browsers/chromium-*/chrome-linux/chrome').find((c) => existsSync(c));

let falhas = 0;
const ok = (c, m) => { console.log(`${c ? '  ok   ' : '  FALHA'} ${m}`); if (!c) falhas++; };

// ---- Fundamentus falso, em ISO-8859-1 como o real --------------------------
const tabela = (cabecalho, linhas) => `<html><body><table id="resultado">
<thead><tr>${cabecalho.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
<tbody>${linhas.map((l) => `<tr>${l.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
</table></body></html>`;

const ACOES = tabela(['Papel', 'Cotação', 'P/VP', 'Div.Yield', 'Liq. Corr.', 'Liq.2meses'], [
  // teto = 2,18 / 6% = 36,38 -> margem de +57% sobre 23,10
  ['BBAS3', '23,10', '0,78', '9,45%', '1,25', '1.250.300.000'],
  ['PETR4', '31,05', '1,05', '12,80%', '0,98', '2.100.000.000'],
  // teto = 2,00 / 6% = 33,33 -> bem abaixo da cotação: NÃO
  ['CARO3', '100,00', '3,00', '2,00%', '1,10', '80.000.000'],
  // liquidez irrisória: some quando o corte é ligado
  ['NANO3', '2,00', '0,40', '8,00%', '0,90', '15.000'],
  // não paga provento: fica fora por padrão
  ['ZZZZ3', '1,20', '0,50', '0,00%', '0,80', '900.000'],
]);
const FIIS = tabela(['Papel', 'Segmento', 'Cotação', 'FFO Yield', 'Dividend Yield', 'P/VP', 'Liquidez'], [
  ['XPLG11', 'Logística', '95,50', '9,50%', '9,18%', '0,92', '12.000.000'],
  ['MXRF11', 'Híbrido', '9,80', '11,00%', '12,40%', '1,02', '25.000.000'],
]);

let consultas = 0;
const fonte = createServer((pedido, resposta) => {
  consultas++;
  resposta.writeHead(200, { 'Content-Type': 'text/html; charset=ISO-8859-1' });
  resposta.end(Buffer.from(pedido.url.includes('fii') ? FIIS : ACOES, 'latin1'));
});
fonte.listen(0);
await once(fonte, 'listening');

// brapi falso só para a carteira não gritar na abertura
const brapi = createServer((pedido, resposta) => {
  const tickers = decodeURIComponent(new URL(pedido.url, 'http://x').pathname).split('/').pop().split(',');
  resposta.writeHead(200, { 'Content-Type': 'application/json' });
  resposta.end(JSON.stringify({ results: tickers.map((t) => ({ symbol: t, regularMarketPrice: 27.31 })) }));
});
brapi.listen(0);
await once(brapi, 'listening');

const pastaDoCache = await mkdtemp(join(tmpdir(), 'rastreador-e2e-'));
const { porta, processo: servidor } = await subirServidor([], {
  FUNDAMENTUS_BASE: `http://127.0.0.1:${fonte.address().port}`,
  BRAPI_BASE: `http://127.0.0.1:${brapi.address().port}/api/quote/`,
  UNIVERSO_CACHE_DIR: pastaDoCache,
  YAHOO: '0',
  BRAPI_V2: '0',
});

const browser = await chromium.launch({ executablePath: acharChromium() });
const page = await browser.newPage({ viewport: { width: 1480, height: 1000 } });
const erros = [];
page.on('pageerror', (e) => erros.push(String(e)));

const linhas = () => page.locator('#tabela-rastreador tbody tr:not(.vazia)');
const tickersNaTela = async () => linhas().evaluateAll((trs) => trs.map((tr) => tr.dataset.ticker));
const celula = async (ticker, rotulo) => (await page.locator(`#tabela-rastreador tr[data-ticker="${ticker}"] td[data-rotulo="${rotulo}"]`).innerText()).trim();

try {
  await page.goto(`http://127.0.0.1:${porta}/`);

  // 1. Abre sozinho e já traz o mercado inteiro: é o ponto do rastreador.
  await page.waitForSelector('#tabela-rastreador tbody tr', { timeout: 20000 });
  ok(!(await page.locator('#rastreador').isHidden()), 'o rastreador aparece sem ninguém pedir');
  const presentes = await tickersNaTela();
  ok(presentes.includes('BBAS3') && presentes.includes('XPLG11'), `ações e FIIs na mesma lista: ${presentes.join(', ')}`);
  ok(!presentes.includes('ZZZZ3'), 'quem não pagou provento fica fora por padrão');

  // 2. A conta do Bazin, com o número que dá para conferir na mão.
  ok((await celula('BBAS3', 'Preço-teto')).startsWith('R$ 36,38'), `preço-teto de BBAS3: ${await celula('BBAS3', 'Preço-teto')}`);
  ok((await celula('BBAS3', 'Margem de segurança')).startsWith('+57'), `margem de BBAS3: ${await celula('BBAS3', 'Margem de segurança')}`);
  ok((await celula('BBAS3', 'Comprar?')) === 'SIM', 'BBAS3 marcado como SIM');
  ok((await celula('CARO3', 'Comprar?')) === 'NÃO', 'CARO3, acima do teto, marcado como NÃO');
  ok((await celula('XPLG11', 'Provento 12m')).startsWith('R$ 8,77'), `provento do FII: ${await celula('XPLG11', 'Provento 12m')}`);
  ok((await celula('BBAS3', 'Liquidez por dia')).includes('bi'), `liquidez de 2 meses, não a corrente: ${await celula('BBAS3', 'Liquidez por dia')}`);

  // 3. Vem ordenado pela maior margem, que é a pergunta "o que comprar primeiro".
  const margens = await linhas().evaluateAll((trs) => trs.map((tr) => tr.querySelector('td[data-rotulo="Margem de segurança"]').innerText));
  const numeros = margens.map((m) => Number(m.replace('%', '').replace(',', '.')));
  ok(numeros.every((n, i) => i === 0 || numeros[i - 1] >= n), `ordenado por margem: ${margens.join(' ')}`);

  // 4. Filtros
  await page.selectOption('#r-tipo', 'fii');
  await page.waitForFunction(() => document.querySelectorAll('#tabela-rastreador tbody tr').length === 2);
  ok((await tickersNaTela()).every((t) => t.endsWith('11')), 'filtro de FIIs deixa só FII');
  await page.selectOption('#r-tipo', 'todos');

  await page.fill('#r-liquidez', '1 mi');
  await page.waitForTimeout(150);
  ok(!(await tickersNaTela()).includes('NANO3'), 'corte de liquidez tira o papel que quase não negocia');
  await page.fill('#r-liquidez', '');

  await page.check('#r-so-sim');
  await page.waitForTimeout(150);
  ok(!(await tickersNaTela()).includes('CARO3'), '“só os abaixo do teto” esconde quem está caro');
  await page.uncheck('#r-so-sim');

  await page.fill('#r-busca', 'logistica');
  await page.waitForTimeout(150);
  ok((await tickersNaTela()).join() === 'XPLG11', 'busca por segmento, sem acento');
  await page.fill('#r-busca', '');
  await page.waitForTimeout(150);

  await page.check('#r-sem-provento');
  await page.waitForTimeout(150);
  ok((await tickersNaTela()).includes('ZZZZ3'), 'dá para incluir quem não pagou provento');
  const semTeto = await celula('ZZZZ3', 'Preço-teto');
  ok(semTeto === '—', `sem provento não vira teto zero: "${semTeto}"`);
  await page.uncheck('#r-sem-provento');
  await page.waitForTimeout(150);

  // 5. Ordenar por outra coluna
  await page.click('#tabela-rastreador th[data-ordenar="dy"]');
  await page.waitForTimeout(150);
  ok((await tickersNaTela())[0] === 'PETR4', 'ordena por DY quando clicam no cabeçalho');
  await page.click('#tabela-rastreador th[data-ordenar="margem"]');
  await page.waitForTimeout(150);

  // 6. Levar para a carteira
  const antes = await page.locator('#tabela tbody tr').count();
  await page.click('#tabela-rastreador tr[data-ticker="XPLG11"] button[data-adicionar]');
  await page.waitForTimeout(200);
  const depois = await page.locator('#tabela tbody tr').count();
  ok(depois === antes + 1, 'o papel entra na carteira');
  const naCarteira = page.locator('#tabela tbody tr:has(input.ticker[value="XPLG11"])');
  ok((await naCarteira.locator('select[data-campo="modo"]').inputValue()) === 'dividendo', 'entra no modo dividendo');
  ok((await naCarteira.locator('input[data-campo="dpaInformado"]').inputValue()) === '8,77', 'com o provento de 12 meses preenchido');
  ok((await naCarteira.locator('input[data-campo="cotacao"]').inputValue()) === '95,50', 'com a cotação preenchida');
  ok((await page.locator('#tabela-rastreador tr[data-ticker="XPLG11"] button[data-adicionar]').isDisabled()), 'o botão vira "na carteira" e não duplica');

  // 7. Cache: recarregar a página não bate na fonte de novo
  const consultasAntes = consultas;
  await page.reload();
  await page.waitForSelector('#tabela-rastreador tbody tr', { timeout: 20000 });
  ok(consultas === consultasAntes, 'a segunda abertura usa o cache do servidor');
  await page.click('#btn-rastrear-recarregar');
  await page.waitForFunction((n) => !document.querySelector('#btn-rastrear-recarregar').disabled, null, { timeout: 20000 });
  ok(consultas === consultasAntes + 2, '“Recarregar” busca as duas páginas de novo');

  // 8. Fechar e reabrir, com a escolha guardada
  await page.click('#btn-rastrear-fechar');
  ok(await page.locator('#rastreador').isHidden(), 'fecha quando pedem');
  await page.reload();
  await page.waitForSelector('#tabela tbody tr');
  await page.waitForTimeout(400);
  ok(await page.locator('#rastreador').isHidden(), 'continua fechado depois de recarregar');
  await page.click('#btn-rastrear');
  await page.waitForSelector('#tabela-rastreador tbody tr', { timeout: 20000 });
  ok(!(await page.locator('#rastreador').isHidden()), 'o botão do topo reabre');

  const contagem = await page.locator('#r-contagem').innerText();
  ok(/universo de 7/.test(contagem), `a contagem mostra o tamanho do universo: "${contagem}"`);
  ok(erros.length === 0, `sem erros de JS (${erros.join(' | ') || 'nenhum'})`);
  await page.screenshot({ path: process.env.SCREENSHOT_DIR ? `${process.env.SCREENSHOT_DIR}/rastreador.png` : '/tmp/rastreador.png', fullPage: false });
} finally {
  await browser.close();
  servidor.kill();
  fonte.close();
  brapi.close();
  await rm(pastaDoCache, { recursive: true, force: true });
}

console.log(falhas ? `\n${falhas} verificação(ões) falharam` : '\nO rastreador funciona de ponta a ponta');
process.exit(falhas ? 1 : 0);
