/**
 * Fonte gratuita e sem cadastro: o endpoint v8 de gráficos do Yahoo Finance,
 * que alimenta o site deles e responde JSON sem token nenhum.
 *
 *   GET https://query1.finance.yahoo.com/v8/finance/chart/BBAS3.SA?interval=1d&range=1y&events=div
 *
 * Serve para o que o plano gratuito da brapi recusa: os proventos. De quebra,
 * traz o preço em `meta.regularMarketPrice`, útil como reserva.
 *
 * Limitações conhecidas, para não haver surpresa:
 *  - é API não oficial: o Yahoo nunca a publicou e pode mudar sem aviso;
 *  - não funciona a partir do navegador (CORS), só do servidor;
 *  - tickers da B3 levam o sufixo `.SA` (BBAS3 -> BBAS3.SA).
 *
 * @typedef {Object} ResumoYahoo
 * @property {number|null} preco    Último preço negociado, quando disponível.
 * @property {number|null} dpa12m   Soma dos proventos dos últimos 12 meses.
 * @property {number}      eventos  Quantos proventos entraram na soma.
 * @property {string|null} moeda    Moeda informada pelo Yahoo (BRL para a B3).
 * @property {string|null} nome     Nome longo do ativo, quando vem.
 */
(function (root, factory) {
  const proventos = typeof require === 'function' ? require('./proventos.js') : root.Proventos;
  const api = factory(proventos);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Yahoo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Proventos) {
  'use strict';

  const BASE_YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart';

  /** BBAS3 -> BBAS3.SA; quem já vier com sufixo é respeitado. */
  const paraSimboloYahoo = (ticker) => {
    const limpo = String(ticker || '').trim().toUpperCase();
    return limpo.includes('.') ? limpo : `${limpo}.SA`;
  };

  class ErroYahoo extends Error {
    constructor(mensagem, detalhes = {}) {
      super(mensagem);
      this.name = 'ErroYahoo';
      this.status = detalhes.status ?? 0;
      this.codigo = detalhes.codigo || 'falha';
    }
  }

  /**
   * Os proventos vêm como objeto indexado por timestamp:
   *   {"1717027200": {amount: 0.35, date: 1717027200}}
   * Vira lista para a soma comum de 12 meses tratar como qualquer outra fonte.
   */
  function eventosDeProventos(resultado) {
    const bruto = resultado?.events?.dividends;
    if (!bruto) return [];
    return Array.isArray(bruto) ? bruto : Object.values(bruto);
  }

  /**
   * Prazo de toda consulta externa. Sem isso, uma fonte que aceita a conexão e não
   * responde segurava a atualização por minutos (o padrão do Node desiste perto dos
   * 5) — na tela, o botão ficava "Buscando…" até alguém recarregar a página.
   */
  const PRAZO_YAHOO = 10000;

  const comPrazo = (ms) => (typeof AbortSignal === 'function' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined);

  /**
   * Busca preço e proventos de 12 meses de um ativo.
   * @param {string} ticker Código na B3, ex.: "BBAS3".
   * @param {{fetchImpl?: Function, base?: string, intervalo?: string, prazoMs?: number}} [opcoes]
   * @returns {Promise<ResumoYahoo>}
   * @throws {ErroYahoo}
   */
  async function buscarResumo(ticker, opcoes = {}) {
    const { fetchImpl, base = BASE_YAHOO, prazoMs = PRAZO_YAHOO } = opcoes;
    const http = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!http) throw new ErroYahoo('fetch indisponível neste ambiente.', { codigo: 'sem-fetch' });

    const simbolo = paraSimboloYahoo(ticker);
    if (!simbolo || simbolo === '.SA') throw new ErroYahoo('Informe um ticker.', { codigo: 'sem-ticker' });

    const url = `${base}/${encodeURIComponent(simbolo)}?interval=1d&range=1y&events=div`;
    let resposta;
    try {
      // O endpoint recusa cliente sem User-Agent de navegador.
      resposta = await http(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }, signal: comPrazo(prazoMs) });
    } catch (erro) {
      throw new ErroYahoo(`Sem conexão com o Yahoo (${erro.message}).`, { codigo: 'rede' });
    }
    if (!resposta.ok) {
      const motivo = resposta.status === 404 ? 'Ticker não encontrado no Yahoo.' : `Falha no Yahoo (HTTP ${resposta.status}).`;
      throw new ErroYahoo(motivo, { status: resposta.status, codigo: 'http' });
    }

    let corpo;
    try {
      corpo = await resposta.json();
    } catch {
      throw new ErroYahoo('O Yahoo respondeu algo que não é JSON.', { codigo: 'corpo-invalido' });
    }

    const erroDaApi = corpo?.chart?.error;
    if (erroDaApi) {
      throw new ErroYahoo(`Yahoo: ${erroDaApi.description || erroDaApi.code || 'erro desconhecido'}.`, { codigo: 'api' });
    }

    const resultado = corpo?.chart?.result?.[0];
    if (!resultado) throw new ErroYahoo('Resposta do Yahoo sem resultado.', { codigo: 'sem-resultado' });

    const soma = Proventos.somar12m(eventosDeProventos(resultado));
    const preco = Number(resultado?.meta?.regularMarketPrice);

    return {
      preco: Number.isFinite(preco) && preco > 0 ? preco : null,
      dpa12m: soma.valor,
      eventos: soma.eventos,
      moeda: resultado?.meta?.currency || null,
      nome: resultado?.meta?.longName || resultado?.meta?.shortName || null,
    };
  }

  return { buscarResumo, paraSimboloYahoo, eventosDeProventos, ErroYahoo, BASE_YAHOO };
});
