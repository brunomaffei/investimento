/**
 * Cliente da API v2 da brapi.
 *
 *   GET https://brapi.dev/api/v2/stocks/quote?symbols=B3SA3
 *   Authorization: Bearer <BRAPI_TOKEN>
 *
 * O token sai de BRAPI_TOKEN no ambiente do servidor e nunca é enviado na URL
 * (não entra em log de proxy) nem exposto ao navegador: o front conversa com
 * /api/cotacoes do servidor local, que faz esta chamada.
 *
 * Tipagem por JSDoc: o projeto é JavaScript puro servido direto ao navegador,
 * sem build nem TypeScript, e este arquivo segue o mesmo formato de módulo
 * (UMD simples) usado por assets/quotes.js e assets/bolsai.js.
 *
 * @typedef {Object} CotacaoV2
 * @property {string}  symbol              Código do ativo na B3 (ex.: "B3SA3").
 * @property {number}  [regularMarketPrice] Último preço negociado.
 * @property {number}  [regularMarketChangePercent] Variação percentual do dia.
 * @property {number}  [regularMarketDayLow]  Mínima do dia.
 * @property {number}  [regularMarketDayHigh] Máxima do dia.
 * @property {number}  [fiftyTwoWeekLow]   Mínima de 52 semanas.
 * @property {number}  [fiftyTwoWeekHigh]  Máxima de 52 semanas.
 * @property {number}  [marketCap]         Valor de mercado.
 * @property {number}  [earningsPerShare]  LPA, quando o plano/resposta traz.
 * @property {string}  [longName]          Razão social.
 *
 * @typedef {Object} OpcoesV2
 * @property {string}   [token]     Token da brapi. Padrão: process.env.BRAPI_TOKEN.
 * @property {Function} [fetchImpl] Implementação de fetch (injetada nos testes).
 * @property {string}   [base]      Base da API v2. Padrão: BASE_V2.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BrapiV2 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const BASE_V2 = 'https://brapi.dev/api/v2/stocks';

  /** Erro de chamada à brapi, com o status HTTP preservado para quem decide o que fazer. */
  class ErroBrapi extends Error {
    /**
     * @param {string} mensagem
     * @param {{status?: number, codigo?: string, symbol?: string}} [detalhes]
     */
    constructor(mensagem, detalhes = {}) {
      super(mensagem);
      this.name = 'ErroBrapi';
      this.status = detalhes.status ?? 0;
      this.codigo = detalhes.codigo || 'falha';
      if (detalhes.symbol) this.symbol = detalhes.symbol;
    }
  }

  /** @param {number} status @returns {string} */
  function mensagemDeErro(status) {
    if (status === 401) return 'Token da brapi inválido ou ausente (header Authorization: Bearer).';
    if (status === 403) return 'Seu plano na brapi não cobre esses dados.';
    if (status === 402 || status === 429) return 'Limite do plano da brapi atingido.';
    if (status === 404) return 'Ticker não encontrado na B3.';
    if (status >= 500) return `A brapi está indisponível (HTTP ${status}).`;
    return `Falha na brapi (HTTP ${status}).`;
  }

  const tokenDoAmbiente = () => (typeof process !== 'undefined' && process.env ? process.env.BRAPI_TOKEN || '' : '');

  /**
   * Faz a chamada crua e devolve a lista de `results`, já validada.
   * @param {string[]} symbols
   * @param {OpcoesV2} [opcoes]
   * @returns {Promise<Array<Object>>}
   * @throws {ErroBrapi} em resposta não-2xx, corpo inválido ou lista vazia.
   */
  async function pedirCotacoes(symbols, opcoes = {}) {
    const { fetchImpl, base = BASE_V2 } = opcoes;
    const token = opcoes.token ?? tokenDoAmbiente();
    const http = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!http) throw new ErroBrapi('fetch indisponível neste ambiente.', { codigo: 'sem-fetch' });

    const lista = (symbols || []).map((s) => String(s || '').trim().toUpperCase()).filter(Boolean);
    if (!lista.length) throw new ErroBrapi('Informe ao menos um ticker.', { codigo: 'sem-ticker' });

    const url = `${base}/quote?symbols=${encodeURIComponent(lista.join(','))}`;
    const cabecalhos = { Accept: 'application/json' };
    if (token) cabecalhos.Authorization = `Bearer ${token}`;

    let resposta;
    try {
      resposta = await http(url, { headers: cabecalhos });
    } catch (erro) {
      throw new ErroBrapi(`Sem conexão com a brapi (${erro.message}).`, { codigo: 'rede' });
    }

    if (!resposta.ok) {
      throw new ErroBrapi(mensagemDeErro(resposta.status), { status: resposta.status, codigo: 'http' });
    }

    let corpo;
    try {
      corpo = await resposta.json();
    } catch {
      throw new ErroBrapi('A brapi respondeu algo que não é JSON.', { status: 200, codigo: 'corpo-invalido' });
    }

    const resultados = Array.isArray(corpo?.results) ? corpo.results : null;
    if (!resultados) throw new ErroBrapi('Resposta da brapi sem a lista "results".', { status: 200, codigo: 'sem-results' });
    if (!resultados.length) throw new ErroBrapi('A brapi não retornou nenhum ativo.', { status: 200, codigo: 'lista-vazia' });
    return resultados;
  }

  /**
   * A v2 entrega o ativo em `results[0].data`. Algumas rotas devolvem o objeto
   * direto no item — aceitar as duas formas evita depender desse detalhe.
   * @param {Object} item
   * @returns {CotacaoV2}
   */
  const conteudo = (item) => (item && typeof item.data === 'object' && item.data !== null ? item.data : item);

  /**
   * Busca a cotação de um ativo.
   * @param {string} symbol Ticker da B3, ex.: "B3SA3".
   * @param {OpcoesV2} [opcoes]
   * @returns {Promise<CotacaoV2>} O conteúdo de `results[0].data`.
   * @throws {ErroBrapi}
   */
  async function buscarCotacao(symbol, opcoes = {}) {
    const alvo = String(symbol || '').trim().toUpperCase();
    const resultados = await pedirCotacoes([alvo], opcoes);
    const dados = conteudo(resultados[0]);
    if (!dados || typeof dados !== 'object') {
      throw new ErroBrapi(`Resposta sem dados para ${alvo}.`, { status: 200, codigo: 'sem-dados', symbol: alvo });
    }
    return dados;
  }

  /**
   * Busca vários ativos numa chamada. Erros de transporte não são engolidos:
   * a exceção sobe, porque nesse caso nenhum ticker foi atendido.
   * @param {string[]} symbols
   * @param {OpcoesV2} [opcoes]
   * @returns {Promise<{dados: Object<string, CotacaoV2>, faltando: string[]}>}
   * @throws {ErroBrapi}
   */
  async function buscarCotacoes(symbols, opcoes = {}) {
    const pedidos = [...new Set((symbols || []).map((s) => String(s || '').trim().toUpperCase()).filter(Boolean))];
    const resultados = await pedirCotacoes(pedidos, opcoes);
    /** @type {Object<string, CotacaoV2>} */
    const dados = {};
    for (const item of resultados) {
      const info = conteudo(item);
      const symbol = String(info?.symbol || item?.symbol || '').toUpperCase();
      if (symbol) dados[symbol] = info;
    }
    return { dados, faltando: pedidos.filter((s) => !dados[s]) };
  }

  return { buscarCotacao, buscarCotacoes, pedirCotacoes, conteudo, mensagemDeErro, ErroBrapi, BASE_V2 };
});
