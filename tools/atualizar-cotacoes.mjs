#!/usr/bin/env node
/**
 * Atualiza as cotações de um arquivo de carteira exportado pelo app (JSON).
 * Útil quando você prefere rodar no terminal ou quando o navegador bloqueia a API.
 *
 *   node tools/atualizar-cotacoes.mjs carteira.json [--token SEU_TOKEN] [--fundamentos]
 *
 * O token também pode vir da variável de ambiente BRAPI_TOKEN.
 * --fundamentos pede LPA e dividendos junto (exige plano pago na brapi); se o
 * plano não cobrir, o script avisa e atualiza somente as cotações.
 * O arquivo é sobrescrito com os preços novos; premissas suas não são tocadas.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buscarCotacoes } = require('../assets/quotes.js');

const TICKER_B3 = /^[A-Z]{4}\d{1,2}$/;

function lerArgumentos(argv) {
  const args = argv.slice(2);
  const idxToken = args.findIndex((a) => a === '--token' || a === '-t');
  const token = idxToken >= 0 ? args[idxToken + 1] : process.env.BRAPI_TOKEN;
  const arquivo = args.find((a, i) => !a.startsWith('-') && i !== idxToken + 1);
  return { arquivo, token, fundamentos: args.includes('--fundamentos') };
}

const fmt = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  const { arquivo, token, fundamentos } = lerArgumentos(process.argv);
  if (!arquivo) {
    console.error('Uso: node tools/atualizar-cotacoes.mjs <carteira.json> [--token SEU_TOKEN] [--fundamentos]');
    process.exit(2);
  }

  const estado = JSON.parse(await readFile(arquivo, 'utf8'));
  if (!Array.isArray(estado.ativos)) {
    console.error('Arquivo inválido: falta a lista "ativos". Exporte a carteira em JSON pelo app.');
    process.exit(2);
  }

  const tickers = estado.ativos
    .map((a) => String(a.ticker || '').trim().toUpperCase())
    .filter((t) => TICKER_B3.test(t));
  if (!tickers.length) {
    console.error('Nenhum ticker da B3 reconhecido na carteira.');
    process.exit(1);
  }

  console.log(`Consultando ${tickers.length} ticker(s) na brapi.dev…`);
  const { dados, erros, avisos } = await buscarCotacoes(tickers, { token, fundamentos });

  let atualizados = 0;
  for (const ativo of estado.ativos) {
    const info = dados[String(ativo.ticker || '').toUpperCase()];
    if (!info || info.preco === null) continue;
    ativo.cotacao = fmt.format(info.preco);
    ativo.cotacaoAtualizadaEm = info.atualizadoEm;
    if (info.nome && !ativo.nome) ativo.nome = info.nome;
    if (info.setor && !ativo.setor) ativo.setor = info.setor;
    if (info.lpa !== null && ativo.modo === 'lpa' && !String(ativo.lpaInformado || '').trim()) {
      ativo.lpaInformado = fmt.format(info.lpa);
    }
    if (info.dpa12m !== null && ativo.modo === 'dividendo' && !String(ativo.dpaInformado || '').trim()) {
      ativo.dpaInformado = fmt.format(info.dpa12m);
    }
    atualizados++;
    console.log(`  ${ativo.ticker.padEnd(7)} R$ ${fmt.format(info.preco)}`);
  }

  await writeFile(arquivo, `${JSON.stringify(estado, null, 2)}\n`);
  console.log(`\n${atualizados} ativo(s) atualizados em ${arquivo}.`);
  for (const aviso of avisos || []) console.warn(`  aviso  ${aviso}`);
  for (const [ticker, motivo] of Object.entries(erros)) console.warn(`  aviso  ${ticker}: ${motivo}`);
  console.log('Importe o arquivo de volta no app pelo botão "⬆ Importar".');
}

main().catch((erro) => {
  console.error(`Erro: ${erro.message}`);
  process.exit(1);
});
