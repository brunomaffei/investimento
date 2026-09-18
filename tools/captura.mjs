#!/usr/bin/env node
/**
 * Gera a captura de tela usada no README: rastreador em cima, carteira embaixo.
 * Sobe um Fundamentus falso e o servidor real, para a imagem mostrar o app como
 * ele fica de verdade. Os números são ilustrativos e os tickers são fictícios.
 *   node tools/captura.mjs [pasta-de-saida]
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, globSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const SAIDA = process.argv[2] || 'docs';
const RAIZ = new URL('..', import.meta.url).pathname;
const executablePath = process.env.CHROMIUM_PATH
  || globSync('/opt/pw-browsers/chromium-*/chrome-linux/chrome').find((c) => existsSync(c));

const DEMO = {
  config: {
    yieldPadrao: 6, margemMinima: 0, token: '', ordenarPor: 'margem', ordemDecrescente: true,
    somenteComprar: false, busca: '', autoAtualizar: false, rastreadorAberto: true,
    carteiraAberta: true, simulando: false,
    projecao: { aporteMensal: '1.000', anos: 10, crescimentoAnual: '', reinvestir: true },
  },
  ativos: [
    { id: 'd1', ticker: 'EXEMPLO1', setor: 'Finance', modo: 'lucro', cotacao: '20,56', lucroProjetado: '5,102 bi', quantidadeAcoes: '3 bi', payout: '85', yieldAceitavel: '6', quantidade: '300', precoMedio: '18,40' },
    { id: 'd2', ticker: 'EXEMPLO2', setor: 'Utilities', modo: 'lucro', cotacao: '45,14', lucroProjetado: '4,233 bi', quantidadeAcoes: '1.152.254.440', payout: '70', yieldAceitavel: '6', quantidade: '120', precoMedio: '41,00' },
    { id: 'd3', ticker: 'EXEMPLO3', setor: 'Communications', modo: 'lucro', cotacao: '30,71', lucroProjetado: '8,179 bi', quantidadeAcoes: '3.226.546.622', payout: '90', yieldAceitavel: '6' },
    { id: 'd4', ticker: 'EXEMPLO4', setor: 'Finance', modo: 'lucro', cotacao: '22,71', lucroProjetado: '22 bi', quantidadeAcoes: '5.730.834.040', payout: '45', yieldAceitavel: '7' },
    { id: 'd5', ticker: 'EXEMPLO5', setor: 'Utilities', modo: 'lpa', cotacao: '56,70', lpaInformado: '6,10', payout: '50', yieldAceitavel: '6', quantidade: '80', precoMedio: '52,00' },
    { id: 'd6', ticker: 'FIIXX11', setor: 'Fundo imobiliário', modo: 'dividendo', cotacao: '9,58', dpaInformado: '1,08', yieldAceitavel: '10', quantidade: '900', precoMedio: '9,10' },
  ],
};

const tabela = (cabecalho, linhas) => `<html><body><table>`
  + `<tr>${cabecalho.map((c) => `<th>${c}</th>`).join('')}</tr>`
  + `${linhas.map((l) => `<tr>${l.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}`
  + `</table></body></html>`;

const ACOES = tabela(['Papel', 'Cotação', 'P/VP', 'Div.Yield', 'Liq. Corr.', 'Liq.2meses'], [
  ['AAAA3', '23,10', '0,78', '9,45%', '1,25', '1.250.300.000'],
  ['BBBB4', '31,05', '1,05', '12,80%', '0,98', '2.100.000.000'],
  ['CCCC3', '38,42', '1,60', '7,10%', '1,40', '640.000.000'],
  ['DDDD11', '35,40', '2,10', '8,10%', '1,15', '410.000.000'],
  ['EEEE3', '12,80', '0,90', '5,40%', '1,02', '180.000.000'],
  ['FFFF4', '100,00', '3,00', '2,00%', '1,10', '80.000.000'],
]);
const FIIS = tabela(['Papel', 'Segmento', 'Cotação', 'FFO Yield', 'Dividend Yield', 'P/VP', 'Liquidez'], [
  ['GGGG11', 'Logística', '95,50', '9,50%', '9,18%', '0,92', '12.000.000'],
  ['HHHH11', 'Híbrido', '9,80', '11,00%', '12,40%', '1,02', '25.000.000'],
  ['IIII11', 'Papel', '8,45', '10,10%', '11,60%', '0,97', '9.500.000'],
  ['JJJJ11', 'Shoppings', '104,20', '8,40%', '8,05%', '0,88', '6.800.000'],
]);

const fonte = createServer((pedido, resposta) => {
  resposta.writeHead(200, { 'Content-Type': 'text/html; charset=ISO-8859-1' });
  resposta.end(Buffer.from(pedido.url.includes('fii') ? FIIS : ACOES, 'latin1'));
});
fonte.listen(0);
await once(fonte, 'listening');

const cache = await mkdtemp(join(tmpdir(), 'captura-'));
const servidor = spawn(process.execPath, ['tools/servidor.mjs', '--porta', '0'], {
  cwd: RAIZ,
  env: {
    ...process.env,
    FUNDAMENTUS_BASE: `http://127.0.0.1:${fonte.address().port}`,
    UNIVERSO_CACHE_DIR: cache,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const porta = await new Promise((resolve, reject) => {
  const limite = setTimeout(() => reject(new Error('servidor não subiu')), 10000);
  servidor.stdout.on('data', (d) => {
    const achado = String(d).match(/http:\/\/localhost:(\d+)/);
    if (achado) {
      clearTimeout(limite);
      resolve(Number(achado[1]));
    }
  });
});

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 1480, height: 1240 }, deviceScaleFactor: 2 });
try {
  await page.goto(`http://127.0.0.1:${porta}/`);
  await page.evaluate((demo) => localStorage.setItem('precoteto.v1', JSON.stringify(demo)), DEMO);
  await page.reload();
  await page.waitForSelector('#tabela-rastreador tbody tr', { timeout: 20000 });
  await page.waitForSelector('#tabela-posicoes tbody tr');
  await page.selectOption('#r-limite', '30');
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    document.querySelector('#status').textContent = '';
    document.querySelector('#r-status').textContent = '';
  });
  const caminho = join(SAIDA, 'tela.png');
  await page.locator('body').screenshot({ path: caminho });
  console.log(`captura salva em ${caminho}`);
} finally {
  await browser.close();
  servidor.kill();
  fonte.close();
  await rm(cache, { recursive: true, force: true });
}
