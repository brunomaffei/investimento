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

// brapi falso: preço fixo, e 403 em qualquer pedido de módulos (como o plano gratuito)
const brapiFalso = createServer((pedido, resposta) => {
  const url = new URL(pedido.url, 'http://local');
  if (url.searchParams.has('modules')) return resposta.writeHead(403).end('{}');
  const tickers = url.pathname.split('/').pop().split(',');
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
} finally {
  await browser.close();
  servidor.kill();
  brapiFalso.close();
}

console.log(falhas ? `\n${falhas} verificação(ões) falharam` : '\nO fluxo pelo servidor local funciona de ponta a ponta');
process.exit(falhas ? 1 : 0);
