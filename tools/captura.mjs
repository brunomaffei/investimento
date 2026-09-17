#!/usr/bin/env node
/**
 * Gera a captura de tela usada no README, com uma carteira de demonstração.
 * Os números são ilustrativos e os tickers são fictícios de propósito.
 *   node tools/captura.mjs [pasta-de-saida]
 */
import { existsSync, globSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const SAIDA = process.argv[2] || 'docs';
const APP = new URL('../index.html', import.meta.url).href;
const executablePath = process.env.CHROMIUM_PATH
  || globSync('/opt/pw-browsers/chromium-*/chrome-linux/chrome').find((c) => existsSync(c));

const DEMO = {
  config: { yieldPadrao: 6, margemMinima: 0, token: '', ordenarPor: 'margem', ordemDecrescente: true, somenteComprar: false, busca: '' },
  ativos: [
    { id: 'd1', ticker: 'EXEMPLO1', setor: 'Finance', modo: 'lucro', cotacao: '20,56', lucroProjetado: '5,102 bi', quantidadeAcoes: '3 bi', payout: '85', yieldAceitavel: '6' },
    { id: 'd2', ticker: 'EXEMPLO2', setor: 'Utilities', modo: 'lucro', cotacao: '45,14', lucroProjetado: '4,233 bi', quantidadeAcoes: '1.152.254.440', payout: '70', yieldAceitavel: '6' },
    { id: 'd3', ticker: 'EXEMPLO3', setor: 'Communications', modo: 'lucro', cotacao: '30,71', lucroProjetado: '8,179 bi', quantidadeAcoes: '3.226.546.622', payout: '90', yieldAceitavel: '6' },
    { id: 'd4', ticker: 'EXEMPLO4', setor: 'Finance', modo: 'lucro', cotacao: '22,71', lucroProjetado: '22 bi', quantidadeAcoes: '5.730.834.040', payout: '45', yieldAceitavel: '7' },
    { id: 'd5', ticker: 'EXEMPLO5', setor: 'Utilities', modo: 'lpa', cotacao: '56,70', lpaInformado: '6,10', payout: '50', yieldAceitavel: '6' },
    { id: 'd6', ticker: 'FIIXX11', setor: 'Fundo imobiliário', modo: 'dividendo', cotacao: '9,58', dpaInformado: '1,08', yieldAceitavel: '10' },
  ],
};

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 1480, height: 900 }, deviceScaleFactor: 2 });
await page.goto(APP);
await page.evaluate((demo) => localStorage.setItem('precoteto.v1', JSON.stringify(demo)), DEMO);
await page.reload();
await page.waitForSelector('#tabela tbody tr');
await page.evaluate(() => { document.querySelector('#status').textContent = ''; });
const caminho = join(SAIDA, 'tela.png');
await page.locator('body').screenshot({ path: caminho });
console.log(`captura salva em ${caminho}`);
await browser.close();
