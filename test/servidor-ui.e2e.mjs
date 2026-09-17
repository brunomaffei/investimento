/**
 * Prova o cenário que o navegador bloqueava: com o app servido por
 * tools/servidor.mjs, o botão "Atualizar cotações" funciona, porque a consulta
 * sai do servidor. Sobe um brapi falso, o servidor real e um Chromium real.
 *
 *   npm i -D playwright-core && node test/servidor-ui.e2e.mjs
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
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

// brapi falso: 403 em módulos (plano gratuito) e 401 sem token fora dos tickers livres
const LIVRES = ['PETR4', 'MGLU3', 'VALE3', 'ITUB4'];
const brapiFalso = createServer((pedido, resposta) => {
  const url = new URL(pedido.url, 'http://local');
  if (url.searchParams.has('modules')) return resposta.writeHead(403).end('{}');
  const tickers = url.pathname.split('/').pop().split(',');
  const temToken = url.searchParams.has('token') || !!pedido.headers.authorization;
  if (!temToken && tickers.some((t) => !LIVRES.includes(t))) return resposta.writeHead(401).end('{}');
  resposta.writeHead(200, { 'Content-Type': 'application/json' });
  resposta.end(JSON.stringify({ results: tickers.map((t) => ({
    symbol: t, regularMarketPrice: 27.31, longName: `${t} Participações`,
    summaryProfile: { sector: 'Finance' },
  })) }));
});
brapiFalso.listen(0);
await once(brapiFalso, 'listening');
const baseFalsa = `http://127.0.0.1:${brapiFalso.address().port}/api/quote/`;

const porta = 8901;
const servidor = spawn(process.execPath, ['tools/servidor.mjs', '--porta', String(porta), '--token', 'TOKEN-SECRETO'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, BRAPI_BASE: baseFalsa },
  stdio: ['ignore', 'pipe', 'pipe'],
});
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://127.0.0.1:${porta}/api/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 100));
}

let servidorSemToken = null;
const browser = await chromium.launch({ executablePath: acharChromium() });
const page = await browser.newPage({ viewport: { width: 1480, height: 900 } });
const erros = [];
page.on('pageerror', (e) => erros.push(String(e)));

try {
  await page.goto(`http://127.0.0.1:${porta}/`);
  await page.waitForSelector('#tabela tbody tr');
  const linha = (t) => page.locator(`#tabela tbody tr:has(input.ticker[value="${t}"])`);

  // Nenhum token digitado no navegador: quem tem o token é o servidor.
  ok((await page.inputValue('#token')) === '', 'navegador não precisa do token');

  await page.click('#btn-cotacoes');
  await page.waitForFunction(() => /atualizados/.test(document.querySelector('#status').textContent), null, { timeout: 20000 });
  const st = await page.locator('#status').innerText();
  ok(/via servidor local/.test(st), `status informa o caminho usado: "${st}"`);
  ok((await linha('BBAS3').locator('input[data-campo="cotacao"]').inputValue()) === '27,31', 'cotação chegou pelo servidor');
  ok((await linha('ITSA4').locator('.sub').innerText()).includes('Finance'), 'setor preenchido');

  // Com fundamentos marcados, o brapi falso recusa (403) e a cotação precisa sobreviver
  await page.check('#fundamentos');
  await page.fill('#busca', '');
  await page.click('#btn-cotacoes');
  await page.waitForFunction(() => /plano/i.test(document.querySelector('#status').textContent), null, { timeout: 20000 });
  ok((await linha('BBAS3').locator('input[data-campo="cotacao"]').inputValue()) === '27,31', 'preço mantido mesmo com fundamentos recusados');

  // Diagnóstico deve reconhecer o servidor
  await page.click('#btn-diagnostico');
  await page.waitForSelector('#diagnostico .conclusao');
  const conclusao = await page.locator('#diagnostico .conclusao').innerText();
  ok(/servidor local/i.test(conclusao), `diagnóstico reconhece o servidor: "${conclusao.slice(0, 60)}…"`);
  ok(!(await page.content()).includes('TOKEN-SECRETO'), 'o token do servidor não aparece na página');

  ok(erros.length === 0, `sem erros de JS (${erros.join(' | ') || 'nenhum'})`);
  await page.screenshot({ path: process.env.SCREENSHOT_DIR ? `${process.env.SCREENSHOT_DIR}/servidor.png` : '/tmp/servidor.png' });

  // ---- Fase 2: servidor SEM BRAPI_TOKEN e token digitado na tela ----------
  console.log('  -- servidor sem BRAPI_TOKEN, token digitado no app');
  const portaSemToken = 8903;
  servidorSemToken = spawn(process.execPath, ['tools/servidor.mjs', '--porta', String(portaSemToken)], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, BRAPI_BASE: baseFalsa, BRAPI_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${portaSemToken}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }

  const p2 = await browser.newPage({ viewport: { width: 1480, height: 900 } });
  const erros2 = [];
  p2.on('pageerror', (e) => erros2.push(String(e)));
  await p2.goto(`http://127.0.0.1:${portaSemToken}/`);
  await p2.waitForSelector('#tabela tbody tr');
  const linha2 = (t) => p2.locator(`#tabela tbody tr:has(input.ticker[value="${t}"])`);

  // Sem token em lugar nenhum: os tickers não-livres falham, e o app explica
  await p2.click('#btn-cotacoes');
  await p2.waitForFunction(() => /problema|atualizados/.test(document.querySelector('#status').textContent), null, { timeout: 20000 });
  const semNada = await p2.locator('#status').innerText();
  ok(/token/i.test(semNada), `sem token algum, o app explica: "${semNada.slice(0, 90)}…"`);

  // Agora o token vai no campo da tela — era o caso que falhava antes
  await p2.fill('#token', 'TOKEN-DIGITADO-NA-TELA');
  await p2.click('#btn-cotacoes');
  await p2.waitForFunction(() => /atualizados/.test(document.querySelector('#status').textContent), null, { timeout: 20000 });
  const comTokenNaTela = await p2.locator('#status').innerText();
  ok(/via servidor local/.test(comTokenNaTela), `usou o servidor: "${comTokenNaTela.slice(0, 90)}…"`);
  ok((await linha2('BBAS3').locator('input[data-campo="cotacao"]').inputValue()) === '27,31',
    'token digitado na tela é repassado ao servidor e a cotação chega');

  // Resposta estranha do servidor não pode escrever "0,00"/"NaN" na cotação
  await p2.route('**/api/cotacoes**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    dados: {
      BBAS3: { ticker: 'BBAS3', preco: 0, lpa: null, dpa12m: null },
      ITSA4: { ticker: 'ITSA4', preco: 'quarenta', nome: 12345 },
      TAEE11: { ticker: 'TAEE11' },
    }, erros: {}, avisos: [] }) }));
  await p2.click('#btn-cotacoes');
  await p2.waitForFunction(() => /atualizados/.test(document.querySelector('#status').textContent), null, { timeout: 20000 });
  ok((await linha2('BBAS3').locator('input[data-campo="cotacao"]').inputValue()) === '27,31', 'preço 0 não sobrescreve a cotação boa');
  ok((await linha2('ITSA4').locator('input[data-campo="cotacao"]').inputValue()) === '27,31', 'preço em texto é ignorado');
  const textoTabela = await p2.locator('#tabela tbody').innerText();
  ok(!/NaN/.test(textoTabela), 'nenhum NaN aparece na tabela');
  ok(!/12345/.test(textoTabela), 'nome com tipo errado é ignorado');
  await p2.unroute('**/api/cotacoes**');

  // O diagnóstico deve dizer de onde veio o token
  await p2.click('#btn-diagnostico');
  await p2.waitForSelector('#diagnostico .conclusao');
  const conclusao2 = await p2.locator('#diagnostico .conclusao').innerText();
  ok(/repassado ao servidor/.test(conclusao2), `diagnóstico explica a origem do token: "${conclusao2.slice(0, 80)}…"`);
  ok(erros2.length === 0, `fase 2 sem erros de JS (${erros2.join(' | ') || 'nenhum'})`);
  await p2.close();
} finally {
  await browser.close();
  servidor.kill();
  if (servidorSemToken) servidorSemToken.kill();
  brapiFalso.close();
}

console.log(falhas ? `\n${falhas} verificação(ões) falharam` : '\nO fluxo pelo servidor local funciona de ponta a ponta');
process.exit(falhas ? 1 : 0);
