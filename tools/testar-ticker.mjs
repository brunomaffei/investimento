#!/usr/bin/env node
/**
 * Investiga um ticker nas duas versões da API da brapi e mostra o que cada rota
 * responde. Serve para entender casos como "Ticker não encontrado na B3" em um
 * papel que você sabe que existe.
 *
 *   BRAPI_TOKEN=seu_token node tools/testar-ticker.mjs CPLE6
 *   npm run ticker -- CPLE6
 *
 * O token nunca é impresso.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BASE } = require('../assets/quotes.js');
const { BASE_V2, paraFii } = require('../assets/brapi-v2.js');
const { somar12m } = require('../assets/proventos.js');

const args = process.argv.slice(2);
const indiceToken = args.indexOf('--token');
const token = (indiceToken >= 0 ? args[indiceToken + 1] : process.env.BRAPI_TOKEN) || '';
const indiceIgnorado = indiceToken >= 0 ? indiceToken + 1 : -1;
const ticker = (args.find((a, i) => !a.startsWith('--') && i !== indiceIgnorado) || '').toUpperCase();

if (!ticker) {
  console.error('Uso: BRAPI_TOKEN=... node tools/testar-ticker.mjs TICKER');
  process.exit(2);
}

const base = process.env.BRAPI_BASE || BASE;
const baseV2 = process.env.BRAPI_V2_BASE || BASE_V2;

// Placeholders que aparecem quando o exemplo da documentação é colado literalmente.
const PARECE_EXEMPLO = /^(seu[_-]?token|sua[_-]?chave|token|chave|xxx+|<.*>|\.\.\.)$/i;

const statusVistos = [];

/** Executa uma rota e resume a resposta em uma linha. */
async function rota(rotulo, url, comHeader) {
  const cabecalhos = { Accept: 'application/json' };
  if (comHeader && token) cabecalhos.Authorization = `Bearer ${token}`;
  const inicio = Date.now();
  try {
    const resposta = await fetch(url, { headers: cabecalhos });
    const ms = Date.now() - inicio;
    statusVistos.push(resposta.status);
    if (!resposta.ok) {
      console.log(`  ${resposta.status === 200 ? '✅' : '❌'} ${rotulo.padEnd(34)} HTTP ${resposta.status}  ${ms} ms`);
      return null;
    }
    const corpo = await resposta.json().catch(() => null);
    const item = corpo?.results?.[0];
    const dados = item?.data && typeof item.data === 'object' ? item.data : item;
    const preco = dados?.regularMarketPrice ?? dados?.close ?? null;
    const lpa = dados?.earningsPerShare ?? dados?.defaultKeyStatistics?.trailingEps ?? null;
    const proventos = somar12m(corpo);
    const resumo = [
      preco !== null ? `preço ${preco}` : null,
      lpa !== null && lpa !== undefined ? `LPA ${lpa}` : null,
      proventos.valor !== null ? `proventos 12m ${proventos.valor.toFixed(2)} (${proventos.eventos} eventos)` : null,
    ].filter(Boolean).join(', ') || 'respondeu sem dados reconhecidos';
    console.log(`  ✅ ${rotulo.padEnd(34)} ${resumo}  ${ms} ms`);
    return dados;
  } catch (erro) {
    console.log(`  🚫 ${rotulo.padEnd(34)} ${erro.message}  ${Date.now() - inicio} ms`);
    return null;
  }
}

const comToken = (url) => (token ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : url);

console.log(`\nInvestigando ${ticker}${token ? ' (com token)' : ' (sem token)'}\n`);
if (PARECE_EXEMPLO.test(token)) {
  console.log(`  ⚠️  O token informado é "${token}" — parece o texto de exemplo, não uma chave real.\n`);
}
await rota('v1: cotação', comToken(`${base}${ticker}`));
await rota('v1: cotação + módulos pagos', comToken(`${base}${ticker}?modules=defaultKeyStatistics&dividends=true`));
await rota('v2: cotação', `${baseV2}/quote?symbols=${ticker}`, true);
await rota('v2: dividendos (ações)', `${baseV2}/dividends?symbols=${ticker}`, true);
await rota('v2: dividendos (FII)', `${paraFii(baseV2)}/dividends?symbols=${ticker}`, true);

const todas401 = statusVistos.length > 0 && statusVistos.every((s) => s === 401);
if (todas401) {
  // Isola a variável: PETR4 é liberada pela brapi sem token nenhum. Se ela
  // responder, o problema é a chave — não a API, a rede ou o ticker.
  console.log('\nTodas as rotas recusaram com 401. Testando um ticker livre SEM token para isolar:');
  await rota('v1: PETR4 sem token (controle)', `${base}PETR4`);
  console.log('\nSe o controle acima respondeu, o problema é o token, não o ticker.');
  console.log('Confira se você exportou a chave real (o texto "seu_token" do exemplo não serve):');
  console.log('  BRAPI_TOKEN=<sua chave de brapi.dev/dashboard> npm run ticker -- ' + ticker);
  console.log('  ou: npm run ticker -- ' + ticker + ' --token <sua chave>\n');
} else {
  console.log('\nHTTP 404 em todas as rotas indica que a brapi não tem esse código — confira a grafia na B3.');
  console.log('HTTP 403 significa que a rota existe, mas seu plano não a cobre.\n');
}
