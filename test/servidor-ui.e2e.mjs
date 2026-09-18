/**
 * Prova o cenário que o navegador bloqueava: com o app servido por
 * tools/servidor.mjs, o botão "Atualizar cotações" funciona, porque a consulta
 * sai do servidor. Sobe um brapi falso, o servidor real e um Chromium real.
 *
 *   npm i -D playwright-core && node test/servidor-ui.e2e.mjs
 */
import { createServer } from 'node:http';
import { once } from 'node:events';
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

// brapi falso: 403 em módulos (plano gratuito) e 401 sem token fora dos tickers livres
const LIVRES = ['PETR4', 'MGLU3', 'VALE3', 'ITUB4'];
const brapiFalso = createServer((pedido, resposta) => {
  const url = new URL(pedido.url, 'http://local');
  if (url.searchParams.has('modules')) return resposta.writeHead(403).end('{}');
  const tickers = decodeURIComponent(url.pathname).split('/').pop().split(',');
  // Plano gratuito: um ticker por requisição. Lote com vários volta 400.
  if (tickers.length > 1) return resposta.writeHead(400).end('{}');
  const temToken = url.searchParams.has('token') || !!pedido.headers.authorization;
  if (!temToken && tickers.some((t) => !LIVRES.includes(t))) return resposta.writeHead(401).end('{}');
  resposta.writeHead(200, { 'Content-Type': 'application/json' });
  resposta.end(JSON.stringify({ results: tickers.map((t) => ({
    symbol: t, regularMarketPrice: 27.31, longName: `${t} Participações`,
    earningsPerShare: 5.5, // a v1 devolve o LPA na raiz, sem módulo pago
    summaryProfile: { sector: 'Finance' },
  })) }));
});
brapiFalso.listen(0);
await once(brapiFalso, 'listening');
const baseFalsa = `http://127.0.0.1:${brapiFalso.address().port}/api/quote/`;

// Yahoo falso: provento pago de 12 meses, em epoch de segundos
const yahooFalso = createServer((pedido, resposta) => {
  const agora = Math.floor(Date.now() / 1000);
  resposta.writeHead(200, { 'Content-Type': 'application/json' });
  resposta.end(JSON.stringify({ chart: { error: null, result: [{
    meta: { regularMarketPrice: 27.31, currency: 'BRL' },
    events: { dividends: { [agora]: { amount: 1.5 }, [agora - 300]: { amount: 1.2 } } },
  }] } }));
});
yahooFalso.listen(0);
await once(yahooFalso, 'listening');

const { porta, processo: servidor } = await subirServidor(['--token', 'TOKEN-SECRETO'], {
  BRAPI_BASE: baseFalsa,
  YAHOO_BASE: `http://127.0.0.1:${yahooFalso.address().port}/v8/finance/chart`,
});

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

  // Atualização automática ao abrir: ninguém clicou em nada ainda
  await page.waitForFunction(() => /atualizados/.test(document.querySelector('#status').textContent), null, { timeout: 20000 });
  ok(true, 'atualizou sozinho ao abrir, sem clique');
  ok((await linha('BBAS3').locator('input[data-campo="cotacao"]').inputValue()) === '27,31', 'cotação já preenchida na abertura');
  ok(/um ticker por consulta/.test(await page.locator('#status').innerText()),
    'app avisa que passou a consultar um a um (plano gratuito recusa o lote)');
  ok((await page.locator('#tabela tbody tr input[data-campo="cotacao"]').count()) === 7, 'a lista inteira segue na tela');
  ok((await linha('BBAS3').locator('input[data-campo="lpaInformado"]').inputValue()) === '5,50', 'LPA da raiz da resposta preenchido sem plano pago');
  // Com a busca de fundamentos ligada por padrão, o provento vem do Yahoo e o payout
  // é derivado dele: a carteira abre completa, sem nada para digitar.
  ok((await page.locator('#resumo .card.alerta strong').innerText()) === '0',
    'abrindo o app, nenhuma premissa fica faltando');

  // Um payout padrão fecha a conta de todas as linhas de uma vez
  await page.fill('#payout-padrao', '50');
  await page.fill('#yield-padrao', '6');
  await page.fill('#margem-minima', '0');
  await page.waitForTimeout(150);
  ok((await page.locator('#resumo .card.alerta strong').innerText()) === '0', 'com payout padrão, nenhuma premissa fica faltando');
  const tetoBB = (await linha('BBAS3').locator('[data-saida="precoTeto"]').innerText()).trim();
  ok(tetoBB.startsWith('R$ 45,83'), `preço-teto de todos calculado: 5,50 x 50% / 6% = "${tetoBB}"`);
  // 7 = os 6 tickers + a linha EXEMPLO, que já vinha com payout próprio.
  ok((await page.locator('#resumo .card.ok strong').innerText()) === '7', 'todas as linhas passam a ter veredito');
  await page.fill('#payout-padrao', '');

  // Desligando a caixa, uma nova abertura não consulta nada
  await page.uncheck('#auto-atualizar');
  const antes = (await (await fetch(`http://127.0.0.1:${porta}/api/health`)).json()) && true;
  await page.reload();
  await page.waitForSelector('#tabela tbody tr');
  await page.waitForTimeout(600);
  ok((await page.locator('#status').innerText()).trim() === '', 'com "atualizar ao abrir" desmarcado, nada é consultado');
  ok(antes, 'servidor segue respondendo');
  await page.check('#auto-atualizar');

  await page.click('#btn-cotacoes');
  await page.waitForFunction(() => /atualizados/.test(document.querySelector('#status').textContent), null, { timeout: 20000 });
  const st = await page.locator('#status').innerText();
  ok(/via servidor local/.test(st), `status informa o caminho usado: "${st}"`);
  ok((await linha('BBAS3').locator('input[data-campo="cotacao"]').inputValue()) === '27,31', 'cotação chegou pelo servidor');
  ok((await linha('ITSA4').locator('.col-ticker .sub').innerText()).includes('Finance'), 'setor preenchido');

  // Com fundamentos marcados, o brapi falso recusa (403) e a cotação precisa sobreviver
  await page.check('#fundamentos');
  await page.fill('#busca', '');
  await page.click('#btn-cotacoes');
  await page.waitForFunction(() => /plano/i.test(document.querySelector('#status').textContent), null, { timeout: 20000 });
  ok((await linha('BBAS3').locator('input[data-campo="cotacao"]').inputValue()) === '27,31', 'preço mantido mesmo com fundamentos recusados');
  // Caso do usuário: lote recusado (400) + módulos pagos recusados (403) ao mesmo
  // tempo. As duas quedas precisam se compor, senão nenhuma linha atualiza.
  const precosPreenchidos = await page.locator('#tabela tbody tr input[data-campo="cotacao"]')
    .evaluateAll((campos) => campos.filter((c) => c.value.trim() !== '').length);
  ok(precosPreenchidos === 7, `todas as linhas com preço mesmo com 400 + 403 (${precosPreenchidos}/7)`);
  const comErro = await page.locator('#tabela tbody tr:has(.tag.erro)').evaluateAll(
    (linhas) => linhas.map((l) => `${l.querySelector('input.ticker')?.value}: ${l.querySelector('.tag.erro')?.title}`),
  );
  ok(comErro.length === 0, `nenhuma linha fica com selo de erro (${comErro.join(' | ') || 'nenhuma'})`);

  // O provento do Yahoo chega mesmo com a linha em modo "LPA direto": vira payout
  // implícito (2,70 / 5,50 = 49%) e a linha passa a ter veredito sem digitar nada.
  const bbas = linha('BBAS3');
  ok(/12m R\$ 2,70/.test(await bbas.innerText()), `a linha mostra o provento pago: ${(await bbas.innerText()).replace(/\n/g, ' ')}`);
  ok(/12m: 49%/.test(await bbas.innerText()), 'e o payout implícito derivado dele');
  const tetoDerivado = (await bbas.locator('[data-saida="precoTeto"]').innerText()).trim();
  // 2,70 de provento ÷ 6% de yield aceitável = R$ 45,00, sem nada digitado.
  ok(tetoDerivado.startsWith('R$ 45,00'), `teto calculado sem premissa digitada: "${tetoDerivado}"`);
  ok((await bbas.locator('[data-saida="veredito"]').innerText()).trim() === 'SIM', 'veredito sai sozinho');
  ok((await page.locator('#resumo .card.alerta strong').innerText()) === '0', 'nenhuma premissa faltando');

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
  const semToken = await subirServidor([], { BRAPI_BASE: baseFalsa, BRAPI_TOKEN: '' });
  const portaSemToken = semToken.porta;
  servidorSemToken = semToken.processo;

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
  // O motivo também aparece na própria linha, não só no status
  ok((await linha2('BBAS3').locator('.tag.erro').count()) === 1, 'a linha ganha selo de erro');
  ok(/[Tt]oken/.test(await linha2('BBAS3').locator('.tag.erro').getAttribute('title')), 'o selo carrega o motivo');

  // Agora o token vai no campo da tela — era o caso que falhava antes
  await p2.fill('#token', 'TOKEN-DIGITADO-NA-TELA');
  await p2.click('#btn-cotacoes');
  await p2.waitForFunction(() => /atualizados/.test(document.querySelector('#status').textContent), null, { timeout: 20000 });
  const comTokenNaTela = await p2.locator('#status').innerText();
  ok(/via servidor local/.test(comTokenNaTela), `usou o servidor: "${comTokenNaTela.slice(0, 90)}…"`);
  ok((await linha2('BBAS3').locator('input[data-campo="cotacao"]').inputValue()) === '27,31',
    'token digitado na tela é repassado ao servidor e a cotação chega');
  ok((await linha2('BBAS3').locator('.tag.erro').count()) === 0, 'selo de erro desaparece quando dá certo');
  // innerText aplica text-transform: uppercase, então a comparação ignora caixa.
  ok(/^auto$/i.test((await linha2('BBAS3').locator('.tag').innerText()).trim()), 'linha passa a mostrar "auto"');

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
  yahooFalso.close();
}

console.log(falhas ? `\n${falhas} verificação(ões) falharam` : '\nO fluxo pelo servidor local funciona de ponta a ponta');
process.exit(falhas ? 1 : 0);
