/**
 * Busca de cotações e fundamentos na brapi.dev (API pública de dados da B3).
 *
 * A chamada acontece no navegador do usuário, direto para a brapi. O token
 * gratuito (brapi.dev/dashboard) fica salvo apenas no localStorage da máquina.
 * Se a busca falhar, o app continua funcionando com preços digitados à mão.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Quotes = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const BASE = 'https://brapi.dev/api/quote/';
  const LOTE = 10; // a brapi aceita vários tickers por chamada; lotes evitam URLs gigantes
  const MODULOS = 'defaultKeyStatistics,summaryProfile';

  const dividirEmLotes = (itens, tamanho) => {
    const lotes = [];
    for (let i = 0; i < itens.length; i += tamanho) lotes.push(itens.slice(i, i + tamanho));
    return lotes;
  };

  function mensagemDeErro(status) {
    if (status === 401 || status === 403) return 'Token inválido ou ausente (pegue um grátis em brapi.dev).';
    if (status === 402 || status === 429) return 'Limite do plano gratuito atingido. Tente de novo mais tarde.';
    if (status === 404) return 'Ticker não encontrado na B3.';
    return `Falha na consulta (HTTP ${status}).`;
  }

  /** Soma os proventos pagos nos últimos 12 meses, quando a API devolver o histórico. */
  function somarProventos12m(resultado) {
    const lista = resultado?.dividendsData?.cashDividends;
    if (!Array.isArray(lista) || !lista.length) return null;
    const limite = Date.now() - 365 * 24 * 60 * 60 * 1000;
    const soma = lista.reduce((total, item) => {
      const data = Date.parse(item.paymentDate || item.lastDatePrior || '');
      const valor = Number(item.rate);
      if (!Number.isFinite(valor) || (Number.isFinite(data) && data < limite)) return total;
      return total + valor;
    }, 0);
    return soma > 0 ? soma : null;
  }

  function normalizar(resultado) {
    const preco = Number(resultado.regularMarketPrice);
    const lpa = Number(
      resultado?.defaultKeyStatistics?.trailingEps ?? resultado?.earningsPerShare ?? NaN,
    );
    return {
      ticker: String(resultado.symbol || '').toUpperCase(),
      preco: Number.isFinite(preco) && preco > 0 ? preco : null,
      nome: resultado.longName || resultado.shortName || null,
      setor: resultado?.summaryProfile?.sector || null,
      lpa: Number.isFinite(lpa) ? lpa : null,
      dpa12m: somarProventos12m(resultado),
      atualizadoEm: new Date().toISOString(),
    };
  }

  /**
   * @param {string[]} tickers
   * @param {{token?: string, fetchImpl?: Function}} opcoes
   * @returns {Promise<{dados: Object<string, object>, erros: Object<string, string>}>}
   */
  async function buscarCotacoes(tickers, opcoes) {
    const { token, fetchImpl } = opcoes || {};
    const http = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!http) throw new Error('fetch indisponível neste ambiente.');

    const limpos = [...new Set((tickers || []).map((t) => String(t || '').trim().toUpperCase()).filter(Boolean))];
    const dados = {};
    const erros = {};

    for (const lote of dividirEmLotes(limpos, LOTE)) {
      const params = new URLSearchParams({ modules: MODULOS, dividends: 'true' });
      if (token) params.set('token', token);
      const url = `${BASE}${lote.join(',')}?${params}`;

      try {
        const resposta = await http(url, { headers: { Accept: 'application/json' } });
        if (!resposta.ok) {
          const motivo = mensagemDeErro(resposta.status);
          lote.forEach((t) => { erros[t] = motivo; });
          continue;
        }
        const corpo = await resposta.json();
        const resultados = Array.isArray(corpo.results) ? corpo.results : [];
        resultados.forEach((r) => {
          const normalizado = normalizar(r);
          if (normalizado.ticker) dados[normalizado.ticker] = normalizado;
        });
        lote.forEach((t) => {
          if (!dados[t]) erros[t] = 'Sem retorno da API para este ticker.';
        });
      } catch (erro) {
        const motivo = `Sem conexão com a brapi (${erro.message}). Preencha a cotação à mão.`;
        lote.forEach((t) => { erros[t] = motivo; });
      }
    }

    return { dados, erros };
  }

  return { buscarCotacoes, somarProventos12m, normalizar, mensagemDeErro, LOTE };
});
