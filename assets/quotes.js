/**
 * Busca de cotações e fundamentos na brapi.dev (API pública de dados da B3).
 *
 * A chamada acontece no navegador do usuário, direto para a brapi. O token
 * gratuito (brapi.dev/dashboard) fica salvo apenas no localStorage da máquina.
 * Se a busca falhar, o app continua funcionando com preços digitados à mão.
 *
 * Importante sobre planos: a cotação está no plano gratuito, mas os módulos de
 * fundamentos (defaultKeyStatistics) e o histórico de dividendos são de planos
 * pagos. Por isso os fundamentos são opcionais: quando a consulta com módulos é
 * recusada, refazemos a chamada só com o preço, para não perder a atualização.
 * Exceção documentada pela brapi: PETR4, MGLU3, VALE3 e ITUB4 têm acesso total
 * sem token, o que serve para testar a integração.
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

  const STATUS_DE_PLANO = [401, 402, 403];

  function mensagemDeErro(status) {
    if (status === 401) return 'Token inválido ou ausente (pegue um grátis em brapi.dev).';
    if (status === 403) return 'Seu plano não cobre esses dados (a cotação é gratuita; fundamentos são pagos).';
    if (status === 402 || status === 429) return 'Limite do plano atingido. Tente de novo mais tarde.';
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

  function montarUrl(lote, token, comFundamentos) {
    const params = new URLSearchParams();
    if (comFundamentos) {
      params.set('modules', MODULOS);
      params.set('dividends', 'true');
    }
    if (token) params.set('token', token);
    const consulta = params.toString();
    return `${BASE}${lote.join(',')}${consulta ? `?${consulta}` : ''}`;
  }

  /**
   * @param {string[]} tickers
   * @param {{token?: string, fundamentos?: boolean, fetchImpl?: Function}} opcoes
   *   fundamentos: pede LPA/dividendos junto (exige plano pago, exceto nos tickers de teste).
   * @returns {Promise<{dados: Object, erros: Object, avisos: string[]}>}
   */
  async function buscarCotacoes(tickers, opcoes) {
    const { token, fetchImpl, fundamentos = false } = opcoes || {};
    const http = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!http) throw new Error('fetch indisponível neste ambiente.');

    const limpos = [...new Set((tickers || []).map((t) => String(t || '').trim().toUpperCase()).filter(Boolean))];
    const dados = {};
    const erros = {};
    const avisos = new Set();

    const pedir = async (lote, comFundamentos) => {
      const resposta = await http(montarUrl(lote, token, comFundamentos), { headers: { Accept: 'application/json' } });
      if (!resposta.ok) return { status: resposta.status };
      const corpo = await resposta.json();
      return { resultados: Array.isArray(corpo.results) ? corpo.results : [] };
    };

    for (const lote of dividirEmLotes(limpos, LOTE)) {
      try {
        let retorno = await pedir(lote, fundamentos);

        // Plano sem direito aos módulos: refaz a chamada só com o preço.
        if (retorno.status && fundamentos && STATUS_DE_PLANO.includes(retorno.status)) {
          const semModulos = await pedir(lote, false);
          if (semModulos.resultados) {
            avisos.add('Fundamentos não liberados no seu plano da brapi — só a cotação foi atualizada.');
            retorno = semModulos;
          }
        }

        if (retorno.status) {
          const motivo = mensagemDeErro(retorno.status);
          lote.forEach((t) => { erros[t] = motivo; });
          continue;
        }

        retorno.resultados.forEach((r) => {
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

    return { dados, erros, avisos: [...avisos] };
  }

  return { buscarCotacoes, somarProventos12m, normalizar, mensagemDeErro, LOTE };
});
