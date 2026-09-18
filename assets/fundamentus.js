/**
 * Universo completo da B3 em duas páginas, sem token e sem cadastro:
 *
 *   https://www.fundamentus.com.br/resultado.php      -> todas as ações
 *   https://www.fundamentus.com.br/fii_resultado.php  -> todos os FIIs
 *
 * Cada página é uma tabela HTML com cotação e dividend yield por papel. Com esses
 * dois números sai o provento por ação (DY x cotação) e, dele, o preço-teto — que
 * é o bastante para rastrear o mercado inteiro em duas requisições.
 *
 * Os dados têm atraso e servem para triagem mensal, não para decisão intradiária.
 * É raspagem de HTML: pode quebrar se a página mudar, por isso o parser é guiado
 * pelos NOMES das colunas no cabeçalho, não por posição fixa.
 *
 * @typedef {Object} AtivoDoUniverso
 * @property {string} ticker
 * @property {'acao'|'fii'} tipo
 * @property {number|null} cotacao
 * @property {number|null} dy        Dividend yield em pontos percentuais (9.45 = 9,45%).
 * @property {number|null} dpa12m    Provento por ação estimado: cotação x dy.
 * @property {number|null} liquidez  Volume financeiro médio diário (R$).
 * @property {string|null} segmento  Só para FIIs.
 * @property {number|null} pvp
 */
(function (root, factory) {
  const calc = typeof require === 'function' ? require('./calc.js') : root.Calc;
  const api = factory(calc);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Fundamentus = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Calc) {
  'use strict';

  const BASE_FUNDAMENTUS = 'https://www.fundamentus.com.br';
  const PAGINAS = {
    acao: '/resultado.php',
    fii: '/fii_resultado.php',
  };

  /**
   * Chave de comparação do cabeçalho: sem acento, sem pontuação e sem espaço.
   * "Liq.2meses" -> "liq2meses", "Div.Yield" -> "divyield", "Cotação" -> "cotacao".
   */
  const chaveDaColuna = (t) => String(t || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  /** Remove marcação e entidades, deixando o texto da célula. */
  const texto = (html) => String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

  /**
   * Cabeçalhos procurados por trecho do nome — a ordem das colunas muda entre as
   * duas páginas e pode mudar com o tempo.
   */
  const COLUNAS = [
    { campo: 'ticker', procura: ['papel'] },
    { campo: 'cotacao', procura: ['cotacao'] },
    { campo: 'dy', procura: ['divyield', 'dividendyield'] },
    { campo: 'pvp', procura: ['pvp'] },
    // Volume financeiro negociado. Nas ações a coluna chama "Liq.2meses"; nos FIIs,
    // "Liquidez". Cuidado: "Liq. Corr." é liquidez corrente (balanço), outra coisa —
    // por isso a busca é por termo inteiro normalizado, não por "liq".
    { campo: 'liquidez', procura: ['liq2meses', 'liquidez'] },
    { campo: 'segmento', procura: ['segmento'] },
  ];

  /** Mapeia nome de coluna -> índice, a partir da linha de cabeçalho. */
  function mapearColunas(cabecalhos) {
    const indice = {};
    cabecalhos.forEach((bruto, i) => {
      const nome = chaveDaColuna(bruto);
      for (const { campo, procura } of COLUNAS) {
        if (indice[campo] === undefined && procura.some((p) => nome.includes(p))) indice[campo] = i;
      }
    });
    return indice;
  }

  const linhas = (html) => String(html || '').match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  const celulas = (linha, tag) => (linha.match(new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, 'gi')) || []).map(texto);

  /**
   * Lê a tabela de uma das páginas do Fundamentus.
   * @param {string} html
   * @param {'acao'|'fii'} tipo
   * @returns {AtivoDoUniverso[]}
   */
  function lerTabela(html, tipo) {
    const todas = linhas(html);
    const cabecalho = todas.find((l) => /<th[^>]*>/i.test(l));
    if (!cabecalho) return [];
    const indice = mapearColunas(celulas(cabecalho, 'th'));
    if (indice.ticker === undefined || indice.cotacao === undefined) return [];

    const ativos = [];
    for (const linha of todas) {
      const cols = celulas(linha, 'td');
      if (!cols.length) continue;
      const ticker = String(cols[indice.ticker] || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!/^[A-Z]{4}\d{1,2}$/.test(ticker)) continue;

      const valor = (campo) => (indice[campo] === undefined ? null : Calc.parseNumero(cols[indice[campo]]));
      const cotacao = valor('cotacao');
      const dy = valor('dy');
      ativos.push({
        ticker,
        tipo,
        cotacao: cotacao !== null && cotacao > 0 ? cotacao : null,
        dy: dy !== null && dy >= 0 ? dy : null,
        // Provento por ação: o yield publicado aplicado ao preço publicado.
        dpa12m: cotacao !== null && cotacao > 0 && dy !== null && dy > 0 ? (cotacao * dy) / 100 : null,
        liquidez: valor('liquidez'),
        pvp: valor('pvp'),
        segmento: indice.segmento === undefined ? null : (cols[indice.segmento] || '').trim() || null,
      });
    }
    return ativos;
  }

  /**
   * Lê o corpo respeitando a codificação da página. O Fundamentus responde em
   * ISO-8859-1: decodificar como UTF-8 transformaria "Cotação" em "Cota\uFFFDo", o
   * cabeçalho deixaria de ser reconhecido e a tabela sairia VAZIA — falha silenciosa
   * pior que um erro. Por isso: charset do header, depois o do <meta>, e se ainda
   * sobrar caractere inválido, mais uma tentativa em windows-1252.
   */
  const EQUIVALENTES = { 'iso-8859-1': 'windows-1252', latin1: 'windows-1252', 'iso8859-1': 'windows-1252' };

  async function lerTexto(resposta) {
    if (typeof resposta.arrayBuffer !== 'function' || typeof TextDecoder !== 'function') return resposta.text();
    const bytes = new Uint8Array(await resposta.arrayBuffer());
    const tentar = (rotulo) => {
      const nome = EQUIVALENTES[String(rotulo || '').toLowerCase()] || rotulo || 'utf-8';
      try {
        return new TextDecoder(nome).decode(bytes);
      } catch {
        return null;
      }
    };
    const doHeader = /charset\s*=\s*"?([\w-]+)/i.exec(
      (resposta.headers && typeof resposta.headers.get === 'function' && resposta.headers.get('content-type')) || '',
    );
    let texto = tentar(doHeader && doHeader[1]);
    if (!doHeader) {
      const doMeta = /<meta[^>]+charset\s*=\s*"?([\w-]+)/i.exec(texto || '');
      if (doMeta) texto = tentar(doMeta[1]) || texto;
    }
    if (texto && texto.includes('\uFFFD')) texto = tentar('windows-1252') || texto;
    return texto || '';
  }

  /**
   * Baixa e lê uma das páginas.
   * @param {'acao'|'fii'} tipo
   * @param {{fetchImpl?: Function, base?: string}} [opcoes]
   * @returns {Promise<AtivoDoUniverso[]>}
   */
  async function buscarUniverso(tipo, opcoes = {}) {
    const { fetchImpl, base = BASE_FUNDAMENTUS, segundos = 25 } = opcoes;
    const http = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!http) throw new Error('fetch indisponível neste ambiente.');
    const caminho = PAGINAS[tipo];
    if (!caminho) throw new Error(`Tipo desconhecido: ${tipo}`);

    // Fonte lenta não pode deixar a tela girando para sempre: melhor erro em 25s.
    const relogio = typeof AbortSignal === 'function' && AbortSignal.timeout
      ? AbortSignal.timeout(segundos * 1000)
      : undefined;
    const resposta = await http(`${base}${caminho}`, {
      headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0' },
      signal: relogio,
    });
    if (!resposta.ok) throw new Error(`Fundamentus respondeu HTTP ${resposta.status} em ${caminho}.`);
    return lerTabela(await lerTexto(resposta), tipo);
  }

  /** Busca ações e FIIs, devolvendo a lista única do mercado. */
  async function buscarTudo(opcoes = {}) {
    const resultados = await Promise.allSettled([
      buscarUniverso('acao', opcoes),
      buscarUniverso('fii', opcoes),
    ]);
    const ativos = [];
    const erros = [];
    resultados.forEach((r, i) => {
      if (r.status === 'fulfilled') ativos.push(...r.value);
      else erros.push(`${i === 0 ? 'ações' : 'FIIs'}: ${r.reason.message}`);
    });
    return { ativos, erros };
  }

  return { buscarTudo, buscarUniverso, lerTabela, lerTexto, mapearColunas, BASE_FUNDAMENTUS, PAGINAS };
});
