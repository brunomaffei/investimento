/**
 * Soma de proventos dos últimos 12 meses, tolerante ao formato da fonte.
 *
 * brapi e bolsai nomeiam os campos de forma diferente (e a documentação pública
 * mistura português e inglês), então data e valor são procurados por uma lista de
 * candidatos e o resultado informa qual chave foi usada. Assim nenhum número
 * entra na carteira sem se saber de onde veio.
 *
 * @typedef {Object} SomaDeProventos
 * @property {number|null} valor     Soma em reais por ação, ou null se não houver evento.
 * @property {number}      eventos   Quantos eventos entraram na soma.
 * @property {string|null} chaveValor Campo usado como valor (ex.: "rate", "value").
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Proventos = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CANDIDATOS_DATA = ['ex_date', 'exDate', 'data_com', 'dataCom', 'lastDatePrior', 'payment_date', 'paymentDate', 'paymentDateTime', 'date', 'data'];
  const CANDIDATOS_VALOR = ['rate', 'value', 'valor', 'amount', 'dividend', 'provento', 'cash_amount'];
  const COLECOES = ['dividends', 'dividendos', 'cashDividends', 'cash_dividends', 'results', 'data', 'events', 'eventos'];

  /**
   * Converte a data do evento em milissegundos. Além de texto ISO, aceita epoch:
   * o Yahoo manda segundos (1717027200) e Date.parse devolveria NaN, fazendo um
   * provento de anos atrás passar pelo corte de 12 meses.
   * @param {string|number} valor
   * @returns {number} NaN quando não dá para interpretar.
   */
  function paraMilissegundos(valor) {
    if (typeof valor === 'number' || /^\d{9,14}$/.test(String(valor || ''))) {
      const n = Number(valor);
      if (!Number.isFinite(n) || n <= 0) return NaN;
      // Menos de 1e12 é segundo (1e12 ms = 2001); acima já é milissegundo.
      return n < 1e12 ? n * 1000 : n;
    }
    return Date.parse(valor);
  }

  const numero = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim()) {
      const n = Number(v.replace(',', '.'));
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };

  /** Um evento é o que tem algum campo de valor reconhecido. */
  const pareceEvento = (item) => !!item
    && typeof item === 'object'
    && CANDIDATOS_VALOR.some((c) => item[c] !== undefined && item[c] !== null);

  /**
   * Encontra a lista de eventos. Cuidado: `results` costuma ser um array de
   * ENVELOPES ({data: {dividends: [...]}}), não de eventos — por isso um array só
   * é aceito quando os itens parecem eventos; senão, procura dentro do primeiro.
   * @param {Object|Array} corpo
   * @param {number} [profundidade]
   * @returns {Array<Object>}
   */
  function listaDeEventos(corpo, profundidade = 0) {
    if (profundidade > 4) return [];
    if (Array.isArray(corpo)) {
      if (corpo.some(pareceEvento)) return corpo;
      return corpo.length ? listaDeEventos(corpo[0], profundidade + 1) : [];
    }
    if (!corpo || typeof corpo !== 'object') return [];
    // Primeiro as chaves conhecidas (mais barato e previsível)...
    for (const chave of COLECOES) {
      const valor = corpo[chave];
      if (valor === undefined || valor === null) continue;
      const achado = listaDeEventos(valor, profundidade + 1);
      if (achado.length) return achado;
    }
    // ...depois qualquer objeto/array aninhado, para formatos como
    // {dividendsData: {cashDividends: [...]}} sem precisar mapear cada envelope.
    for (const valor of Object.values(corpo)) {
      if (!valor || typeof valor !== 'object') continue;
      const achado = listaDeEventos(valor, profundidade + 1);
      if (achado.length) return achado;
    }
    return [];
  }

  /**
   * @param {Object|Array} corpo Resposta da API.
   * @param {number} [agora] Momento de referência (facilita testar).
   * @returns {SomaDeProventos}
   */
  function somar12m(corpo, agora = Date.now()) {
    const eventos = listaDeEventos(corpo);
    if (!eventos.length) return { valor: null, eventos: 0, chaveValor: null };

    const limite = agora - 365 * 24 * 60 * 60 * 1000;
    let soma = 0;
    let usados = 0;
    let chaveValor = null;

    for (const evento of eventos) {
      if (!evento || typeof evento !== 'object') continue;
      const chave = CANDIDATOS_VALOR.find((c) => numero(evento[c]) !== null);
      const valor = chave ? numero(evento[chave]) : null;
      if (valor === null || valor <= 0) continue;

      const chaveData = CANDIDATOS_DATA.find((c) => evento[c]);
      const data = chaveData ? paraMilissegundos(evento[chaveData]) : NaN;
      // Evento sem data legível entra: é melhor somar a menos do que inventar.
      if (Number.isFinite(data) && data < limite) continue;

      soma += valor;
      usados++;
      chaveValor = chaveValor || chave;
    }
    return { valor: usados ? soma : null, eventos: usados, chaveValor };
  }

  return { somar12m, listaDeEventos, paraMilissegundos, CANDIDATOS_DATA, CANDIDATOS_VALOR, COLECOES };
});
