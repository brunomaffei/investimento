/**
 * Projeção da bola de neve: o que acontece com a carteira se a pessoa continuar
 * aportando e reinvestindo os proventos.
 *
 * Mês a mês:
 *   1. entra o aporte
 *   2. a carteira paga renda = patrimônio x yield mensal
 *   3. se reinvestir, a renda volta para o patrimônio
 *
 * Premissas — que são premissas mesmo, e a tela precisa dizer isso:
 *   - o yield da carteira continua o mesmo (renda anual ÷ valor de hoje);
 *   - o preço das ações não muda, então "patrimônio" cresce só por aporte e
 *     reinvestimento — nada aqui projeta valorização;
 *   - o dividendo pode crescer por ano (crescimentoAnual), padrão 0;
 *   - sem imposto: dividendo de ação e de FII é isento para pessoa física hoje,
 *     mas JCP tem 15% na fonte e a regra pode mudar.
 *
 * @typedef {Object} PontoDaProjecao
 * @property {number} mes          1, 2, 3…
 * @property {number} patrimonio   valor da carteira ao fim do mês
 * @property {number} aportado     quanto saiu do bolso até aqui (posição inicial + aportes)
 * @property {number} recebido     quanto a carteira pagou até aqui
 * @property {number} rendaMensal  quanto ela pagou NESTE mês
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Projecao = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MESES_PADRAO = 120; // 10 anos
  const numero = (v, padrao = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : padrao);

  /**
   * @param {Object} entrada
   * @param {number} entrada.patrimonio      valor de hoje da carteira
   * @param {number} entrada.rendaAnual      quanto ela paga por ano hoje
   * @param {number} [entrada.aporteMensal]  quanto a pessoa pretende aportar por mês
   * @param {number} [entrada.meses]         horizonte (padrão 120)
   * @param {boolean} [entrada.reinvestir]   padrão true
   * @param {number} [entrada.crescimentoAnual] crescimento do dividendo em % ao ano
   * @returns {{serie: PontoDaProjecao[], yieldAnual: number|null, resumo: Object}}
   */
  function projetar(entrada = {}) {
    const patrimonioInicial = Math.max(0, numero(entrada.patrimonio));
    const rendaAnual = Math.max(0, numero(entrada.rendaAnual));
    const aporteMensal = Math.max(0, numero(entrada.aporteMensal));
    const meses = Math.max(1, Math.min(600, Math.round(numero(entrada.meses, MESES_PADRAO))));
    const reinvestir = entrada.reinvestir !== false;
    const crescimentoAnual = Math.max(-50, Math.min(50, numero(entrada.crescimentoAnual)));

    // Yield da carteira de hoje. Sem patrimônio não há como derivar taxa nenhuma:
    // devolver série vazia é mais honesto do que projetar sobre um chute.
    const yieldAnual = patrimonioInicial > 0 ? rendaAnual / patrimonioInicial : null;
    if (yieldAnual === null) {
      return { serie: [], yieldAnual: null, resumo: { patrimonioFinal: null, rendaMensalFinal: null, aportado: null, recebido: null } };
    }

    const crescimentoMensal = (1 + crescimentoAnual / 100) ** (1 / 12) - 1;
    const serie = [];
    let patrimonio = patrimonioInicial;
    let aportado = patrimonioInicial;
    let recebido = 0;
    let taxaMensal = yieldAnual / 12;

    for (let mes = 1; mes <= meses; mes++) {
      patrimonio += aporteMensal;
      aportado += aporteMensal;
      // O dividendo cresce com o tempo; o yield sobre o preço de compra sobe junto.
      taxaMensal *= 1 + crescimentoMensal;
      const rendaMensal = patrimonio * taxaMensal;
      recebido += rendaMensal;
      if (reinvestir) patrimonio += rendaMensal;
      serie.push({ mes, patrimonio, aportado, recebido, rendaMensal });
    }

    const ultimo = serie[serie.length - 1];
    return {
      serie,
      yieldAnual,
      resumo: {
        patrimonioFinal: ultimo.patrimonio,
        rendaMensalFinal: ultimo.rendaMensal,
        aportado: ultimo.aportado,
        recebido: ultimo.recebido,
      },
    };
  }

  /** Um ponto por ano (mês 12, 24, 36…), que é o que o gráfico desenha. */
  function porAno(serie) {
    return (serie || []).filter((p) => p.mes % 12 === 0).map((p) => ({ ...p, ano: p.mes / 12 }));
  }

  return { projetar, porAno, MESES_PADRAO };
});
