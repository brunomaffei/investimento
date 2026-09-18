/**
 * Verificações de interface com Chromium.
 *   npm i -D playwright-core && npm run test:ui
 * Variáveis opcionais:
 *   CHROMIUM_PATH   caminho do executável (default: o que o playwright encontrar)
 *   SCREENSHOT_DIR  onde salvar as capturas (default: pasta temporária)
 */
import { existsSync, globSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.log('playwright-core não instalado — pule com: npm i -D playwright-core');
  process.exit(0);
}

const APP = new URL('../index.html', import.meta.url).href;
const SAIDA = process.env.SCREENSHOT_DIR || tmpdir();

function acharChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidatos = globSync('/opt/pw-browsers/chromium-*/chrome-linux/chrome');
  return candidatos.find((c) => existsSync(c)); // undefined -> playwright decide
}
let falhas = 0;
const ok = (c, m) => { console.log(`${c ? '  ok   ' : '  FALHA'} ${m}`); if (!c) falhas++; };

const browser = await chromium.launch({ executablePath: acharChromium() });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const erros = [];
// erros de rede simulados (401 da brapi) não são falha de JS
page.on('console', (m) => {
  if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) erros.push(m.text());
});
page.on('pageerror', (e) => erros.push(String(e)));
await page.goto(APP);
await page.waitForSelector('#tabela tbody tr');

const linha = (ticker) => page.locator(`#tabela tbody tr:has(input.ticker[value="${ticker}"])`);
const celula = async (ticker, saida) => (await linha(ticker).locator(`[data-saida="${saida}"]`).innerText()).trim();

ok(erros.length === 0, `sem erros de console (${erros.join(' | ') || 'nenhum'})`);
ok((await page.locator('#tabela tbody tr').count()) === 7, 'carteira inicial com 7 linhas');

// Linha EXEMPLO: (5,102 bi / 3 bi x 85%) / 6% = 24,09 ; margem sobre 20,56 = +17,18%
ok((await celula('EXEMPLO', 'precoTeto')) === 'R$ 24,09', `preço-teto do EXEMPLO = ${await celula('EXEMPLO','precoTeto')}`);
ok(await celula('EXEMPLO', 'margem') === '+17,18%', `margem do EXEMPLO = ${await celula('EXEMPLO','margem')}`);
ok(await celula('EXEMPLO', 'lpa') === 'R$ 1,70', `LPA = ${await celula('EXEMPLO','lpa')}`);
ok(await celula('EXEMPLO', 'dpa') === 'R$ 1,45', `DPA = ${await celula('EXEMPLO','dpa')}`);
ok((await celula('EXEMPLO', 'veredito')) === 'SIM', 'veredito SIM');
const faltaBBAS = await celula('BBAS3', 'veredito');
ok(/PAYOUT|LPA/i.test(faltaBBAS), `o selo diz qual premissa falta: "${faltaBBAS}"`);
ok((await page.locator('#resumo .card.ok strong').innerText()) === '1', 'resumo: 1 dentro do teto');
ok((await page.locator('#resumo .card.alerta strong').innerText()) === '6', 'resumo: 6 com premissas faltando');

// Cabeçalho e corpo precisam ter o MESMO número de células, nos dois estados:
// com alguma linha em "Lucro proj." (colunas extras visíveis) e sem nenhuma.
const contarColunas = async () => page.evaluate(() => ({
  cabecalho: document.querySelectorAll('#tabela thead th').length,
  corpo: [...document.querySelectorAll('#tabela tbody tr')].map((tr) => tr.children.length),
}));
const comLucro = await contarColunas();
ok(comLucro.corpo.every((n) => n === comLucro.cabecalho),
  `com modo lucro: ${comLucro.cabecalho} colunas no cabeçalho, linhas com ${[...new Set(comLucro.corpo)].join('/')}`);

await linha('EXEMPLO').locator('select[data-campo="modo"]').selectOption('lpa');
const semLucro = await contarColunas();
ok(semLucro.cabecalho === comLucro.cabecalho - 2, 'sem modo lucro, duas colunas sao escondidas');
ok(semLucro.corpo.every((n) => n === semLucro.cabecalho),
  `sem modo lucro: ${semLucro.cabecalho} colunas no cabeçalho, linhas com ${[...new Set(semLucro.corpo)].join('/')}`);
await linha('EXEMPLO').locator('select[data-campo="modo"]').selectOption('lucro');

// Editar payout recalcula a linha sem perder o foco do campo
const payout = linha('EXEMPLO').locator('input[data-campo="payout"]');
await payout.fill('50');
await page.waitForTimeout(80);
ok(await celula('EXEMPLO', 'precoTeto') === 'R$ 14,17', `payout 50% -> teto ${await celula('EXEMPLO','precoTeto')}`);
ok(await celula('EXEMPLO', 'veredito') === 'NÃO', 'agora o veredito virou NÃO');
ok(await payout.evaluate((n) => n === document.activeElement), 'foco permanece no campo editado');
await payout.fill('85');

// Margem mínima exigida
await page.fill('#margem-minima', '25');
await page.waitForTimeout(80);
ok(await celula('EXEMPLO', 'veredito') === 'NÃO', 'margem mínima de 25% reprova +17,18%');
ok(/R\$ 19,27/.test(await celula('EXEMPLO', 'precoTeto')), `preço de compra alvo aparece sob o teto = ${await celula('EXEMPLO','precoTeto')}`);
await page.fill('#margem-minima', '0');

// Trocar a base do cálculo para "Dividendo (DPA)"
await linha('EXEMPLO').locator('select[data-campo="modo"]').selectOption('dividendo');
await linha('EXEMPLO').locator('input[data-campo="dpaInformado"]').fill('1,80');
await page.waitForTimeout(80);
ok(await celula('EXEMPLO', 'precoTeto') === 'R$ 30,00', `DPA 1,80 / 6% -> ${await celula('EXEMPLO','precoTeto')}`);

// Modo LPA direto num ticker da lista
const bb = linha('BBAS3');
await bb.locator('select[data-campo="modo"]').selectOption('lpa');
await bb.locator('input[data-campo="cotacao"]').fill('22,00');
await bb.locator('input[data-campo="lpaInformado"]').fill('8,00');
await bb.locator('input[data-campo="payout"]').fill('40');
await page.waitForTimeout(80);
ok(await celula('BBAS3', 'precoTeto') === 'R$ 53,33', `BBAS3 teto = ${await celula('BBAS3','precoTeto')}`);
ok(await celula('BBAS3', 'veredito') === 'SIM', 'BBAS3 marcado como SIM');

// Ordenação e filtro
const primeiraLinha = () => page.locator('#tabela tbody tr input.ticker').first().inputValue();
// Digitar não reordena a tabela (a linha fugiria do cursor); o clique no cabeçalho reordena.
await page.click('#tabela thead th[data-ordenar="margem"]'); // margem crescente
ok((await primeiraLinha()) === 'EXEMPLO', `crescente: menor margem primeiro (veio ${await primeiraLinha()})`);
await page.click('#tabela thead th[data-ordenar="margem"]'); // margem decrescente
ok((await primeiraLinha()) === 'BBAS3', `decrescente: maior margem primeiro (veio ${await primeiraLinha()})`);
await page.click('#tabela thead th[data-ordenar="ticker"]');
ok((await primeiraLinha()) === 'VIVT3', 'ordenar por ticker (Z->A)');
await page.click('#tabela thead th[data-ordenar="margem"]');
await page.check('#somente-comprar');
await page.waitForTimeout(50);
ok((await page.locator('#tabela tbody tr').count()) === 2, 'filtro "só os SIM" deixa 2 linhas');
await page.uncheck('#somente-comprar');
await page.fill('#busca', 'taee');
await page.waitForTimeout(50);
ok((await page.locator('#tabela tbody tr').count()) === 1, 'busca por texto filtra 1 linha');
await page.fill('#busca', '');

// Adicionar e remover
await page.click('#btn-adicionar');
ok((await page.locator('#tabela tbody tr').count()) === 8, 'botão + Ativo insere linha');
// a linha nova entra sem dados, então a ordenação por margem a joga para o fim
await page.locator('#tabela tbody tr:has(input.ticker[value=""])').locator('button.remover').click();
ok((await page.locator('#tabela tbody tr').count()) === 7, 'botão remover apaga a linha certa');
ok((await page.locator('#tabela tbody tr input.ticker').first().inputValue()) === 'BBAS3', 'demais linhas intactas');

// Persistência no localStorage após recarregar
await page.reload();
await page.waitForSelector('#tabela tbody tr');
ok(await celula('BBAS3', 'precoTeto') === 'R$ 53,33', 'dados sobrevivem ao recarregar a página');
ok(/margem/i.test(await page.locator('#tabela thead th.ativa').textContent()), 'ordenação também é salva');

// Cotações sem token -> mensagem clara, nada quebrado
await page.route('**/brapi.dev/**', (r) => r.fulfill({ status: 401, body: '{}' }));
await page.click('#btn-cotacoes');
await page.waitForFunction(() => document.querySelector('#status').textContent.includes('problema'), null, { timeout: 15000 });
const st = await page.locator('#status').innerText();
ok(st.toLowerCase().includes('token'), `erro 401 explicado ao usuário: "${st}"`);

// Plano sem fundamentos: módulos recusados, mas a cotação tem de chegar
await page.unroute('**/brapi.dev/**');
await page.check('#fundamentos');
await page.route('**/brapi.dev/**', (r) => {
  if (r.request().url().includes('modules=')) return r.fulfill({ status: 403, body: '{}' });
  const symbols = new URL(r.request().url()).pathname.split('/').pop().split(',');
  return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    results: symbols.map((s) => ({ symbol: s, regularMarketPrice: 12.34 })) }) });
});
await page.click('#btn-cotacoes');
await page.waitForFunction(() => document.querySelector('#status').textContent.includes('plano'), null, { timeout: 15000 });
ok((await linha('CPLE6').locator('input[data-campo="cotacao"]').inputValue()) === '12,34', 'preço atualizado mesmo sem direito aos fundamentos');
ok(/plano/i.test(await page.locator('#status').innerText()), 'app explica que os fundamentos não vieram');

// Cotação automática preenchendo preço e LPA
await page.unroute('**/brapi.dev/**');
await page.route('**/brapi.dev/**', (r) => {
  const symbols = new URL(r.request().url()).pathname.split('/').pop().split(',');
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    results: symbols.map((s) => ({ symbol: s, regularMarketPrice: 31.5, longName: `${s} Companhia`,
      defaultKeyStatistics: { trailingEps: 4 }, summaryProfile: { sector: 'Utilities' } })) }) });
});
await page.click('#btn-cotacoes');
await page.waitForFunction(() => document.querySelector('#status').textContent.includes('atualizados'), null, { timeout: 15000 });
ok((await linha('ITSA4').locator('input[data-campo="cotacao"]').inputValue()) === '31,50', 'cotação automática preenchida');
ok((await linha('ITSA4').locator('input[data-campo="lpaInformado"]').inputValue()) === '4,00', 'LPA vindo da API preenchido');
ok((await linha('BBAS3').locator('input[data-campo="lpaInformado"]').inputValue()) === '8,00', 'LPA digitado por mim NÃO foi sobrescrito');
ok((await linha('ITSA4').locator('.col-ticker .sub').innerText()).includes('Utilities'), 'setor preenchido pela API');

// Diagnóstico de conexão: rede bloqueada pelo navegador
await page.fill('#token', 'meu-token-de-teste');
await page.unroute('**/brapi.dev/**');
await page.route('**/brapi.dev/**', (r) => r.abort('failed'));
await page.click('#btn-diagnostico');
await page.waitForSelector('#diagnostico .conclusao', { timeout: 15000 });
const bloqueio = await page.locator('#diagnostico .conclusao').innerText();
ok(/bloqueou|permissão de rede/i.test(bloqueio), `diagnóstico identifica bloqueio: "${bloqueio.slice(0, 60)}…"`);
ok((await page.locator('#diagnostico li').count()) >= 1, 'diagnóstico lista as etapas testadas');

// Diagnóstico com plano sem fundamentos
await page.unroute('**/brapi.dev/**');
await page.route('**/brapi.dev/**', (r) => {
  const url = r.request().url();
  // Plano gratuito: módulos da v1 e fundamentos da v2 recusados; cotação liberada.
  if (url.includes('modules=') || url.includes('/v2/stocks/fundamentals')) return r.fulfill({ status: 403, body: '{}' });
  return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    results: [{ symbol: 'PETR4', regularMarketPrice: 31.9 }] }) });
});
await page.click('#btn-diagnostico');
await page.waitForFunction(() => /fundamentos|ok/i.test(document.querySelector('#diagnostico .conclusao')?.textContent || ''), null, { timeout: 15000 });
const conclusao = await page.locator('#diagnostico .conclusao').innerText();
ok(/não cobre fundamentos/i.test(conclusao), `diagnóstico aponta limitação de plano: "${conclusao.slice(0, 70)}…"`);
ok(/v2 também recusou/i.test(conclusao), 'diagnóstico reporta a rota v2 junto');
ok((await page.locator('#diagnostico ul').innerText()).includes('v2:'), 'painel lista as sondagens da API v2');
ok(!conclusao.includes('meu-token'), 'token não aparece no relatório');

// Exportações não lançam erro
const csv = await page.evaluate(() => { document.querySelector('#btn-csv').click(); return document.querySelector('#status').textContent; });
ok(csv.includes('CSV'), 'exportação CSV disparada');

await page.screenshot({ path: join(SAIDA, 'app-desktop.png'), fullPage: true });
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: join(SAIDA, 'app-mobile.png'), fullPage: true });
console.log(`  capturas em ${SAIDA}`);

ok(erros.length === 0, `nenhum erro de JS durante todo o fluxo (${erros.join(' | ') || 'nenhum'})`);
await browser.close();
console.log(falhas ? `\n${falhas} verificação(ões) falharam` : '\nTodas as verificações de interface passaram');
process.exit(falhas ? 1 : 0);
