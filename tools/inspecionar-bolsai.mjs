#!/usr/bin/env node
/**
 * Mostra a resposta real da bolsai para um ticker e quais campos o app reconheceu.
 * Serve para ajustar as listas de candidatos em assets/bolsai.js sem adivinhação.
 *
 *   BOLSAI_KEY=sua_chave node tools/inspecionar-bolsai.mjs BBAS3
 *   node tools/inspecionar-bolsai.mjs BBAS3 --chave sua_chave
 *
 * A chave nunca é impressa.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { achatar, extrair, somarProventos12m, CANDIDATOS_LPA, BASE } = require('../assets/bolsai.js');

const args = process.argv.slice(2);
const indiceChave = args.indexOf('--chave');
const chave = (indiceChave >= 0 ? args[indiceChave + 1] : process.env.BOLSAI_KEY) || '';
// Sem a flag, indiceChave é -1: não há índice a ignorar (senão o 0 seria excluído).
const indiceIgnorado = indiceChave >= 0 ? indiceChave + 1 : -1;
const ticker = args.find((a, i) => !a.startsWith('--') && i !== indiceIgnorado);
const base = process.env.BOLSAI_BASE || BASE;

if (!ticker) {
  console.error('Uso: BOLSAI_KEY=... node tools/inspecionar-bolsai.mjs TICKER');
  process.exit(2);
}
if (!chave) {
  console.error('Falta a chave: defina BOLSAI_KEY ou passe --chave. Pegue uma grátis em usebolsai.com.');
  process.exit(2);
}

const pedir = async (caminho) => {
  const resposta = await fetch(`${base}${caminho}`, {
    headers: { Accept: 'application/json', 'X-API-Key': chave },
  });
  const texto = await resposta.text();
  let corpo = null;
  try { corpo = JSON.parse(texto); } catch { /* não é JSON */ }
  return { status: resposta.status, ok: resposta.ok, corpo, texto };
};

const alvo = ticker.toUpperCase();
console.log(`Consultando ${base}/fundamentals/${alvo}\n`);

const fundamentos = await pedir(`/fundamentals/${encodeURIComponent(alvo)}`);
console.log(`HTTP ${fundamentos.status}`);
if (!fundamentos.ok) {
  console.log(fundamentos.texto.slice(0, 500));
  process.exit(1);
}

const plano = achatar(fundamentos.corpo);
console.log('\nCampos recebidos (chave = valor):');
for (const [k, v] of Object.entries(plano)) {
  if (v === null || typeof v === 'object') continue;
  console.log(`  ${k.padEnd(28)} ${v}`);
}

const lpa = extrair(plano, CANDIDATOS_LPA);
console.log(`\nLPA reconhecido: ${lpa.valor === null ? 'NENHUM' : `${lpa.valor} (campo "${lpa.chave}")`}`);
if (lpa.valor === null) {
  console.log('→ Veja na lista acima qual campo é o lucro por ação e acrescente o nome dele');
  console.log('  em CANDIDATOS_LPA, no arquivo assets/bolsai.js.');
}

const proventos = await pedir(`/dividends/${encodeURIComponent(alvo)}`);
console.log(`\nProventos: HTTP ${proventos.status}`);
if (proventos.ok) {
  const soma = somarProventos12m(proventos.corpo);
  console.log(`  ${soma.eventos} evento(s) nos últimos 12 meses somando R$ ${soma.valor ?? 0}`);
  console.log(`  campo de valor usado: ${soma.chaveValor || 'NENHUM'}`);
  const primeiro = (Array.isArray(proventos.corpo) ? proventos.corpo : Object.values(proventos.corpo || {}).find(Array.isArray))?.[0];
  if (primeiro) console.log(`  exemplo de evento: ${JSON.stringify(primeiro)}`);
}
