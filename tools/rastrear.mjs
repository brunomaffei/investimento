#!/usr/bin/env node
/**
 * Roda o rastreador no terminal: baixa o mercado inteiro e imprime os papéis mais
 * descontados pelo preço-teto do método Bazin. Serve para conferir os números sem
 * abrir o navegador — e para descobrir rápido se a fonte de dados mudou de formato.
 *
 *   node tools/rastrear.mjs
 *   npm run rastrear -- --yield 8 --tipo fii --liquidez "1 mi" --top 20
 *
 * Opções:
 *   --yield N      yield aceitável em % (padrão 6, o corte clássico do Bazin)
 *   --margem N     margem de segurança mínima em % para marcar SIM (padrão 0)
 *   --tipo T       todos | acao | fii (padrão todos)
 *   --liquidez V   volume mínimo negociado por dia, aceita "1 mi" (padrão nenhum)
 *   --top N        quantas linhas imprimir (padrão 25)
 *   --csv          imprime em CSV, para colar na planilha
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buscarTudo, BASE_FUNDAMENTUS } = require('../assets/fundamentus.js');
const { rastrear } = require('../assets/rastreador.js');

const args = process.argv.slice(2);
const opcao = (nome, padrao) => {
  const i = args.indexOf(`--${nome}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : padrao;
};

const config = { yieldPadrao: opcao('yield', 6), margemMinima: opcao('margem', 0) };
const filtros = {
  tipo: opcao('tipo', 'todos'),
  liquidezMinima: opcao('liquidez', ''),
  somenteSim: args.includes('--so-sim'),
  limite: Number(opcao('top', 25)) || 25,
};

const nf = (casas) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
const num = (v, casas = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : nf(casas).format(v));

const base = process.env.FUNDAMENTUS_BASE || BASE_FUNDAMENTUS;

const { ativos, erros } = await buscarTudo({ base });
erros.forEach((e) => console.error(`aviso: ${e}`));
if (!ativos.length) {
  console.error('Nenhum ativo veio da fonte. Ela pode estar fora do ar ou ter mudado de formato.');
  process.exit(1);
}

const { visiveis, resumo } = rastrear(ativos, config, filtros);

if (args.includes('--csv')) {
  console.log('Ticker;Tipo;Cotacao;DY;Provento12m;PrecoTeto;Margem;Comprar');
  visiveis.forEach(({ item, metricas: m }) => console.log([
    item.ticker, item.tipo, num(m.cotacao), num(item.dy), num(m.dpa), num(m.precoTeto),
    num(m.margem === null ? null : m.margem * 100, 1), m.veredito,
  ].join(';')));
} else {
  console.log(`\nUniverso: ${resumo.universo} papéis (${resumo.acoes} ações + ${resumo.fiis} FIIs). `
    + `Filtrados: ${resumo.filtrados}. Abaixo do teto: ${resumo.comprar}. `
    + `Yield aceitável: ${config.yieldPadrao}%.\n`);
  console.log(['TICKER'.padEnd(8), 'COTAÇÃO'.padStart(10), 'DY'.padStart(7), 'PROV.12M'.padStart(10),
    'TETO'.padStart(10), 'MARGEM'.padStart(9), ' COMPRAR'].join(''));
  visiveis.forEach(({ item, metricas: m }) => {
    console.log([
      item.ticker.padEnd(8),
      num(m.cotacao).padStart(10),
      `${num(item.dy, 1)}%`.padStart(7),
      num(m.dpa).padStart(10),
      num(m.precoTeto).padStart(10),
      `${num(m.margem === null ? null : m.margem * 100, 1)}%`.padStart(9),
      ` ${{ sim: 'SIM', nao: 'não', incompleto: '—' }[m.veredito]}`,
    ].join(''));
  });
  console.log(`\nMostrando ${resumo.mostrados} de ${resumo.filtrados}. `
    + 'Provento é o que já foi pago nos últimos 12 meses, não projeção.');
}
