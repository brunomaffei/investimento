/**
 * Rastreador: aplica o preço-teto ao mercado inteiro, sem ninguém digitar ticker.
 *
 * A entrada é o universo devolvido por assets/fundamentus.js (todas as ações e
 * todos os FIIs, cada um com cotação e dividend yield). Para cada papel:
 *
 *   DPA (12 meses) = cotação x DY        -> já vem pronto do universo
 *   Preço-teto     = DPA / yield aceitável
 *   Margem         = preço-teto / cotação - 1
 *
 * A conta NÃO é refeita aqui: cada papel vira uma linha no formato da carteira e
 * passa por Calc.avaliarAtivo, o mesmo caminho da tabela principal. Assim o número
 * do rastreador e o número da carteira nunca divergem.
 *
 * Diferença importante para a carteira: aqui o DPA é o que a empresa JÁ pagou nos
 * últimos 12 meses, não uma projeção. Serve para a triagem — o estudo do papel e a
 * projeção de lucro continuam sendo trabalho de quem investe.
 *
 * @typedef {Object} LinhaRastreada
 * @property {import('./fundamentus.js').AtivoDoUniverso} item
 * @property {object} metricas  saída de Calc.avaliarAtivo
 * @property {string[]} alertas
 */
(function (root, factory) {
  const calc = typeof require === 'function' ? require('./calc.js') : root.Calc;
  const api = factory(calc);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Rastreador = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Calc) {
  'use strict';

  /** Acima disso o yield quase sempre é provento extraordinário que não se repete. */
  const DY_SUSPEITO = 20;
  /** Yield tão baixo costuma ser histórico incompleto ou papel que mal paga. */
  const DY_IRRELEVANTE = 1;
  /** Quantas linhas a tela mostra de uma vez: o mercado inteiro trava o navegador. */
  const LIMITE_PADRAO = 60;

  const semAcento = (t) => String(t || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

  /**
   * Converte um papel do universo em ativo no formato da carteira.
   * Modo 'dividendo': o provento pago é o dado, não o lucro projetado.
   */
  function paraAtivo(item) {
    return {
      ticker: item.ticker,
      modo: 'dividendo',
      cotacao: item.cotacao,
      dpaInformado: item.dpa12m,
      // Guardado também como dado de mercado para a tela mostrar o yield de conferência.
      dpa12mMercado: item.dpa12m,
      setor: item.segmento || (item.tipo === 'fii' ? 'FII' : ''),
      fonteProventos: 'fundamentus',
    };
  }

  /** O que merece um aviso na linha, sem esconder o papel de quem quer ver. */
  function alertasDe(item) {
    const alertas = [];
    if (item.dpa12m === null) alertas.push('sem provento nos últimos 12 meses');
    else if (item.dy !== null && item.dy > DY_SUSPEITO) alertas.push(`DY de ${item.dy.toFixed(1)}% costuma ser provento extraordinário`);
    else if (item.dy !== null && item.dy < DY_IRRELEVANTE) alertas.push('DY muito baixo: histórico incompleto ou papel que quase não paga');
    if (item.liquidez !== null && item.liquidez < 100000) alertas.push('liquidez baixa: difícil comprar e vender');
    return alertas;
  }

  /**
   * Aplica filtros ao universo.
   * @param {{tipo?: 'todos'|'acao'|'fii', somenteSim?: boolean, liquidezMinima?: number|null,
   *          busca?: string, ocultarSemProvento?: boolean}} filtros
   */
  function filtrar(linhas, filtros = {}) {
    const { tipo = 'todos', somenteSim = false, ocultarSemProvento = true } = filtros;
    const liquidezMinima = Calc.parseNumero(filtros.liquidezMinima);
    const busca = semAcento(filtros.busca).trim();

    return linhas.filter(({ item, metricas }) => {
      if (tipo !== 'todos' && item.tipo !== tipo) return false;
      if (somenteSim && metricas.veredito !== 'sim') return false;
      if (ocultarSemProvento && item.dpa12m === null) return false;
      // Liquidez desconhecida não some da lista: some quem comprovadamente não negocia.
      if (liquidezMinima && item.liquidez !== null && item.liquidez < liquidezMinima) return false;
      if (busca && !semAcento(`${item.ticker} ${item.segmento || ''}`).includes(busca)) return false;
      return true;
    });
  }

  const CAMPOS = {
    ticker: ({ item }) => item.ticker,
    cotacao: ({ metricas }) => metricas.cotacao,
    dy: ({ item }) => item.dy,
    dpa: ({ metricas }) => metricas.dpa,
    precoTeto: ({ metricas }) => metricas.precoTeto,
    margem: ({ metricas }) => metricas.margem,
    liquidez: ({ item }) => item.liquidez,
    pvp: ({ item }) => item.pvp,
  };

  /** Ordena deixando quem não tem o dado sempre no fim, em qualquer direção. */
  function ordenar(linhas, { ordenarPor = 'margem', decrescente = true } = {}) {
    const valor = CAMPOS[ordenarPor] || CAMPOS.margem;
    return [...linhas].sort((a, b) => {
      const va = valor(a);
      const vb = valor(b);
      const vazioA = va === null || va === undefined || (typeof va === 'number' && !Number.isFinite(va));
      const vazioB = vb === null || vb === undefined || (typeof vb === 'number' && !Number.isFinite(vb));
      if (vazioA && vazioB) return 0;
      if (vazioA) return 1;
      if (vazioB) return -1;
      const cmp = typeof va === 'string' ? va.localeCompare(vb, 'pt-BR') : va - vb;
      return decrescente ? -cmp : cmp;
    });
  }

  /**
   * Roda o preço-teto sobre o mercado inteiro.
   * @param {import('./fundamentus.js').AtivoDoUniverso[]} universo
   * @param {object} config     mesma configuração da carteira (yieldPadrao, margemMinima)
   * @param {object} [filtros]  ver filtrar(); aceita ainda { ordenarPor, decrescente, limite }
   */
  function rastrear(universo, config = {}, filtros = {}) {
    const todas = (universo || []).map((item) => ({
      item,
      metricas: Calc.avaliarAtivo(paraAtivo(item), config),
      alertas: alertasDe(item),
    }));

    const filtradas = filtrar(todas, filtros);
    const ordenadas = ordenar(filtradas, filtros);
    const limite = filtros.limite === null ? ordenadas.length : (filtros.limite || LIMITE_PADRAO);
    const visiveis = ordenadas.slice(0, limite);

    return {
      visiveis,
      resumo: {
        universo: todas.length,
        acoes: todas.filter((l) => l.item.tipo === 'acao').length,
        fiis: todas.filter((l) => l.item.tipo === 'fii').length,
        filtrados: filtradas.length,
        mostrados: visiveis.length,
        // "Dentro do teto" é contado sobre o filtro aplicado, que é o que a tela mostra.
        comprar: filtradas.filter((l) => l.metricas.veredito === 'sim').length,
        melhorMargem: filtradas.reduce((melhor, l) => {
          const m = l.metricas.margem;
          return typeof m === 'number' && Number.isFinite(m) && (melhor === null || m > melhor) ? m : melhor;
        }, null),
      },
    };
  }

  return { rastrear, filtrar, ordenar, paraAtivo, alertasDe, DY_SUSPEITO, DY_IRRELEVANTE, LIMITE_PADRAO };
});
