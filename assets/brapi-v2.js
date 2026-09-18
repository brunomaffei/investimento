/**
 * Cliente da API v2 da brapi.
 *
 *   GET https://brapi.dev/api/v2/stocks/quote?symbols=B3SA3      (cotação)
 *   GET https://brapi.dev/api/v2/stocks/dividends?symbols=BBAS3  (dividendos e JCP)
 *   GET https://brapi.dev/api/v2/fii/dividends?symbols=XPLG11    (mesma coisa, para FII)
 *   Authorization: Bearer <BRAPI_TOKEN>
 *
 * Das rotas da v2, este projeto usa só essas: a carteira precisa de cotação e do
 * provento anual por ação. Histórico OHLCV, indicadores de FII, fundos, opções,
 * futuros, Tesouro e câmbio não entram no cálculo de preço-teto.
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
  const proventos = typeof require === 'function' ? require('./proventos.js') : root.Proventos;
  const api = factory(proventos);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BrapiV2 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Proventos) {
  'use strict';

  const BASE_V2 = 'https://brapi.dev/api/v2/stocks';
  // Rota de FII é irmã da de ações: .../v2/stocks -> .../v2/fii
  const paraFii = (base) => String(base || BASE_V2).replace(/\/stocks$/, '/fii');

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
   * Requisição autenticada a uma rota da v2, devolvendo o corpo em JSON.
   * @param {string} caminho Ex.: "/dividends?symbols=BBAS3"
   * @param {OpcoesV2} [opcoes]
   * @returns {Promise<Object>}
   * @throws {ErroBrapi}
   */
  async function pedir(caminho, opcoes = {}) {
    const { fetchImpl, base = BASE_V2 } = opcoes;
    const token = opcoes.token ?? tokenDoAmbiente();
    const http = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!http) throw new ErroBrapi('fetch indisponível neste ambiente.', { codigo: 'sem-fetch' });

    const cabecalhos = { Accept: 'application/json' };
    if (token) cabecalhos.Authorization = `Bearer ${token}`;

    let resposta;
    try {
      resposta = await http(`${base}${caminho}`, { headers: cabecalhos });
    } catch (erro) {
      throw new ErroBrapi(`Sem conexão com a brapi (${erro.message}).`, { codigo: 'rede' });
    }
    if (!resposta.ok) {
      throw new ErroBrapi(mensagemDeErro(resposta.status), { status: resposta.status, codigo: 'http' });
    }
    try {
      return await resposta.json();
    } catch {
      throw new ErroBrapi('A brapi respondeu algo que não é JSON.', { status: 200, codigo: 'corpo-invalido' });
    }
  }

  /**
   * Proventos dos últimos 12 meses de um ativo, em reais por ação/cota.
   * Tenta a rota de ações e cai para a de FII quando o ticker não é de ação —
   * assim o app não precisa saber de antemão o tipo do ativo.
   * @param {string} symbol
   * @param {OpcoesV2} [opcoes]
   * @returns {Promise<{dpa12m: number|null, eventos: number, chaveValor: string|null, rota: 'stocks'|'fii'}>}
   * @throws {ErroBrapi} quando nenhuma das duas rotas responde.
   */
  async function buscarProventos12m(symbol, opcoes = {}) {
    const alvo = String(symbol || '').trim().toUpperCase();
    if (!alvo) throw new ErroBrapi('Informe um ticker.', { codigo: 'sem-ticker' });
    const caminho = `/dividends?symbols=${encodeURIComponent(alvo)}`;
    const baseAcoes = opcoes.base || BASE_V2;

    /** @param {string} base @param {'stocks'|'fii'} rota */
    const tentar = async (base, rota) => {
      const corpo = await pedir(caminho, { ...opcoes, base });
      const soma = Proventos.somar12m(corpo);
      return { dpa12m: soma.valor, eventos: soma.eventos, chaveValor: soma.chaveValor, rota };
    };

    try {
      const resultado = await tentar(baseAcoes, 'stocks');
      if (resultado.dpa12m !== null) return resultado;
      // Sem evento na rota de ações: pode ser FII. Vale a segunda tentativa.
      try {
        const comoFii = await tentar(paraFii(baseAcoes), 'fii');
        return comoFii.dpa12m !== null ? comoFii : resultado;
      } catch {
        return resultado;
      }
    } catch (erro) {
      if (erro.status !== 404) throw erro;
      return tentar(paraFii(baseAcoes), 'fii');
    }
  }

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

    // Vírgula literal entre os símbolos (cada um escapado à parte): é o formato
    // que a documentação mostra, e %2C nem sempre é aceito.
    const url = `${base}/quote?symbols=${lista.map(encodeURIComponent).join(',')}`;
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

  // Plano gratuito aceita um ticker por requisição: vários viram 400/413/414.
  const STATUS_DE_LOTE = [400, 413, 414];

  /**
   * Busca vários ativos. Tenta numa chamada só e, se o plano recusar o lote,
   * repete um por um — que é o que o plano gratuito permite.
   * @param {string[]} symbols
   * @param {OpcoesV2} [opcoes]
   * @returns {Promise<{dados: Object<string, CotacaoV2>, faltando: string[], erros: Object<string, string>, avisos: string[]}>}
   * @throws {ErroBrapi} quando nem a consulta individual funciona.
   */
  async function buscarCotacoes(symbols, opcoes = {}) {
    const pedidos = [...new Set((symbols || []).map((s) => String(s || '').trim().toUpperCase()).filter(Boolean))];
    /** @type {Object<string, CotacaoV2>} */
    const dados = {};
    /** @type {Object<string, string>} */
    const erros = {};
    const avisos = [];

    const guardar = (itens) => {
      for (const item of itens) {
        const info = conteudo(item);
        const symbol = String(info?.symbol || item?.symbol || '').toUpperCase();
        if (symbol) dados[symbol] = info;
      }
    };

    try {
      guardar(await pedirCotacoes(pedidos, opcoes));
    } catch (erro) {
      const podeSerLote = pedidos.length > 1 && erro instanceof ErroBrapi && STATUS_DE_LOTE.includes(erro.status);
      if (!podeSerLote) throw erro;

      avisos.push('Seu plano aceita um ticker por consulta: o app passou a consultar um a um.');
      let algumFuncionou = false;
      for (const symbol of pedidos) {
        try {
          guardar(await pedirCotacoes([symbol], opcoes));
          algumFuncionou = true;
        } catch (falha) {
          erros[symbol] = falha.message;
        }
      }
      // Se nem sozinho funcionou, o problema não era o tamanho do lote.
      if (!algumFuncionou) throw erro;
    }

    return { dados, faltando: pedidos.filter((s) => !dados[s]), erros, avisos };
  }

  return {
    buscarCotacao, buscarCotacoes, buscarProventos12m, pedirCotacoes, pedir,
    conteudo, mensagemDeErro, ErroBrapi, BASE_V2, paraFii,
  };
});
