/**
 * Prova que o LPA chega automático: brapi falsa (preço) + bolsai falsa
 * (fundamentos) + servidor real + Chromium real. Nada depende de internet.
 *
 *   npm i -D playwright-core && node test/bolsai-integracao.e2e.mjs
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

const CHAVE_BOLSAI = 'CHAVE-BOLSAI-SECRETA';
const LPA_POR_TICKER = { BBAS3: 8.55, ITSA4: 1.62, TAEE11: 2.94, CPLE6: 1.18, VIVT3: 3.4, BBSE3: 4.71 };

// brapi falsa: só preço (como o plano gratuito real)
const brapi = createServer((pedido, resposta) => {
  const url = new URL(pedido.url, 'http://local');
  if (url.searchParams.has('modules')) return resposta.writeHead(403).end('{}');
  const tickers = url.pathname.split('/').pop().split(',');
  resposta.writeHead(200, { 'Content-Type': 'application/json' });
  resposta.end(JSON.stringify({ results: tickers.map((t) => ({ symbol: t, regularMarketPrice: 24.5 })) }));
});
brapi.listen(0);
await once(brapi, 'listening');

// bolsai falsa: exige X-API-Key e responde no formato documentado
const chamadasBolsai = [];
const bolsai = createServer((pedido, resposta) => {
  chamadasBolsai.push({ url: pedido.url, chave: pedido.headers['x-api-key'] || null });
  if (pedido.headers['x-api-key'] !== CHAVE_BOLSAI) return resposta.writeHead(401).end('{}');
  const [, , , recurso, ticker] = pedido.url.split('/');
  resposta.writeHead(200, { 'Content-Type': 'application/json' });
  if (recurso === 'fundamentals') {
    const lpa = LPA_POR_TICKER[ticker];
    return resposta.end(JSON.stringify({ ticker, pl: 5.32, pvp: 1.42, roe: 26.6, lpa }));
  }
  const hoje = new Date().toISOString();
  return resposta.end(JSON.stringify({ dividends: [
    { ex_date: hoje, value: 1.1 }, { ex_date: hoje, value: 0.9 }, { ex_date: '2015-01-01', value: 50 },
  ] }));
});
bolsai.listen(0);
await once(bolsai, 'listening');

const porta = 8907;
const servidor = spawn(process.execPath, ['tools/servidor.mjs', '--porta', String(porta), '--token', 'TOKEN-BRAPI'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: {
    ...process.env,
    BRAPI_BASE: `http://127.0.0.1:${brapi.address().port}/api/quote/`,
    BOLSAI_BASE: `http://127.0.0.1:${bolsai.address().port}/api/v1`,
    BOLSAI_KEY: CHAVE_BOLSAI,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const log = [];
servidor.stdout.on('data', (d) => log.push(String(d)));
servidor.stderr.on('data', (d) => log.push(String(d)));
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://127.0.0.1:${porta}/api/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 100));
}

const browser = await chromium.launch({ executablePath: acharChromium() });
const page = await browser.newPage({ viewport: { width: 1480, height: 900 } });
const erros = [];
page.on('pageerror', (e) => erros.push(String(e)));

try {
  const saude = await (await fetch(`http://127.0.0.1:${porta}/api/health`)).json();
  ok(saude.comBolsai === true, '/api/health informa que a bolsai está configurada');

  await page.goto(`http://127.0.0.1:${porta}/`);
  await page.waitForSelector('#tabela tbody tr');
  const linha = (t) => page.locator(`#tabela tbody tr:has(input.ticker[value="${t}"])`);

  // Sem marcar a caixa, fundamentos não são buscados (economiza requisições)
  await page.click('#btn-cotacoes');
  await page.waitForFunction(() => /atualizados/.test(document.querySelector('#status').textContent), null, { timeout: 20000 });
  ok(chamadasBolsai.length === 0, 'caixa desmarcada: nenhuma requisição à bolsai');
  ok((await linha('BBAS3').locator('input[data-campo="lpaInformado"]').inputValue()) === '', 'LPA segue vazio');

  // Marcando a caixa, o LPA chega automático
  await page.check('#fundamentos');
  await page.click('#btn-cotacoes');
  await page.waitForFunction(() => /bolsai/i.test(document.querySelector('#status').textContent), null, { timeout: 20000 });
  const st = await page.locator('#status').innerText();
  ok(/pela bolsai/.test(st), `status credita a fonte: "${st.slice(0, 100)}…"`);
  ok((await linha('BBAS3').locator('input[data-campo="lpaInformado"]').inputValue()) === '8,55', 'LPA de BBAS3 preenchido automaticamente');
  ok((await linha('BBSE3').locator('input[data-campo="lpaInformado"]').inputValue()) === '4,71', 'LPA de BBSE3 preenchido automaticamente');

  // Com o payout digitado, a linha calcula sozinha: 8,55 x 40% / 6% = R$ 57,00
  await linha('BBAS3').locator('input[data-campo="payout"]').fill('40');
  await page.fill('#yield-padrao', '6');
  await page.fill('#margem-minima', '0');
  await page.waitForTimeout(120);
  const teto = (await linha('BBAS3').locator('[data-saida="precoTeto"]').innerText()).trim();
  ok(teto.startsWith('R$ 57,00'), `preço-teto calculado do LPA automático: "${teto}"`);
  ok((await linha('BBAS3').locator('[data-saida="veredito"]').innerText()).trim() === 'SIM', 'veredito SIM (cotação 24,50 < teto 57,00)');

  // Modo dividendo recebe a soma de 12 meses (1,10 + 0,90 = 2,00; o de 2015 fica fora)
  await linha('ITSA4').locator('select[data-campo="modo"]').selectOption('dividendo');
  await page.click('#btn-cotacoes');
  await page.waitForFunction(() => /atualizados/.test(document.querySelector('#status').textContent), null, { timeout: 20000 });
  ok((await linha('ITSA4').locator('input[data-campo="dpaInformado"]').inputValue()) === '2,00', 'DPA de 12 meses preenchido');

  // Segurança e diagnóstico
  ok(!(await page.content()).includes(CHAVE_BOLSAI), 'a chave da bolsai não aparece na página');
  ok(chamadasBolsai.every((c) => !c.url.includes(CHAVE_BOLSAI)), 'a chave não vai na URL');
  ok(chamadasBolsai.every((c) => c.chave === CHAVE_BOLSAI), 'toda chamada à bolsai leva o header X-API-Key');

  await page.click('#btn-diagnostico');
  await page.waitForSelector('#diagnostico .conclusao');
  const conclusao = await page.locator('#diagnostico .conclusao').innerText();
  ok(/bolsai/i.test(conclusao), `diagnóstico credita a bolsai: "${conclusao.slice(0, 90)}…"`);
  ok(/\+ bolsai/.test(await page.locator('#diagnostico ul').innerText()), 'etapa do servidor mostra "+ bolsai"');

  ok(erros.length === 0, `sem erros de JS (${erros.join(' | ') || 'nenhum'})`);
  ok(log.join('').includes('[bolsai]'), 'servidor registra a consulta à bolsai no log');
  ok(!log.join('').includes(CHAVE_BOLSAI), 'a chave não aparece no log do servidor');
  await page.screenshot({ path: process.env.SCREENSHOT_DIR ? `${process.env.SCREENSHOT_DIR}/bolsai.png` : '/tmp/bolsai.png', fullPage: false });
} finally {
  await browser.close();
  servidor.kill();
  brapi.close();
  bolsai.close();
}

console.log(falhas ? `\n${falhas} verificação(ões) falharam` : '\nLPA automático pela bolsai funciona de ponta a ponta');
process.exit(falhas ? 1 : 0);
