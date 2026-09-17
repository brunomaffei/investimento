/**
 * Núcleo de cálculo do preço-teto (método Décio Bazin) e da margem de segurança.
 *
 * Fórmulas:
 *   LPA (lucro por ação)      = lucro projetado / quantidade de ações
 *   DPA (dividendo por ação)  = LPA x payout
 *   Preço-teto                = DPA / yield aceitável
 *   Margem de segurança       = (preço-teto / cotação atual) - 1
 *
 * Três modos de entrada, do mais trabalhoso ao mais direto:
 *   'lucro'     -> lucro projetado + quantidade de ações + payout (o da planilha de referência)
 *   'lpa'       -> LPA já conhecido + payout (a API de cotações preenche o LPA sozinha)
 *   'dividendo' -> DPA informado direto (FIIs, ou média de proventos dos últimos 12 meses)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Calc = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MULTIPLICADORES = {
    k: 1e3, mil: 1e3,
    m: 1e6, mi: 1e6, mm: 1e6, milhao: 1e6, milhoes: 1e6,
    b: 1e9, bi: 1e9, bilhao: 1e9, bilhoes: 1e9,
    t: 1e12, tri: 1e12,
  };

  /**
   * Converte texto em número aceitando formato brasileiro e atalhos de escala.
   * Exemplos: "5.102.000.000,00" -> 5102000000 | "22 bi" -> 22e9 | "1,45" -> 1.45
   * Retorna null quando não há número válido.
   */
  function parseNumero(valor) {
    if (valor === null || valor === undefined || valor === '') return null;
    if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;

    let texto = String(valor)
      .trim()
      .toLowerCase()
      .replace(/r\$/g, '')
      .replace(/%/g, '')
      .replace(/\s| /g, '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '');
    if (!texto) return null;

    let escala = 1;
    const sufixo = texto.match(/([a-z]+)$/);
    if (sufixo) {
      const chave = sufixo[1];
      if (!(chave in MULTIPLICADORES)) return null;
      escala = MULTIPLICADORES[chave];
      texto = texto.slice(0, -chave.length);
    }
    if (!texto || texto === '-') return null;

    const temVirgula = texto.includes(',');
    const pontos = texto.split('.').length - 1;
    if (temVirgula) {
      // Vírgula é o separador decimal: pontos restantes são de milhar.
      texto = texto.replace(/\./g, '').replace(',', '.');
    } else if (pontos > 1) {
      texto = texto.replace(/\./g, '');
    } else if (pontos === 1) {
      // Ambíguo: "1.234" é milhar, "20.56" é decimal. Grupo final de 3 dígitos = milhar.
      const [, decimais] = texto.split('.');
      if (decimais.length === 3) texto = texto.replace('.', '');
    }

    const numero = Number(texto);
    if (!Number.isFinite(numero)) return null;
    return numero * escala;
  }

  const positivo = (n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null);

  /**
   * Avalia um ativo e devolve as métricas derivadas.
   * @param {object} ativo   Premissas do ativo (ver seed.js para o formato).
   * @param {object} config  { yieldPadrao, margemMinima } em pontos percentuais.
   */
  function avaliarAtivo(ativo, config) {
    const cfg = config || {};
    const yieldPadrao = parseNumero(cfg.yieldPadrao);
    const margemMinima = parseNumero(cfg.margemMinima) || 0;

    const cotacao = positivo(parseNumero(ativo.cotacao));
    const yieldAceitavel = positivo(parseNumero(ativo.yieldAceitavel)) ?? positivo(yieldPadrao);
    const modo = ['dividendo', 'lpa'].includes(ativo.modo) ? ativo.modo : 'lucro';

    const lucro = parseNumero(ativo.lucroProjetado);
    const quantidade = positivo(parseNumero(ativo.quantidadeAcoes));
    const payout = parseNumero(ativo.payout);

    let lpa = modo === 'lpa'
      ? parseNumero(ativo.lpaInformado)
      : lucro !== null && quantidade !== null
        ? lucro / quantidade
        : null;
    let dpa = null;

    if (modo === 'dividendo') {
      dpa = parseNumero(ativo.dpaInformado);
    } else if (lpa !== null && payout !== null) {
      dpa = lpa * (payout / 100);
    }

    const precoTeto = dpa !== null && dpa > 0 && yieldAceitavel ? dpa / (yieldAceitavel / 100) : null;
    const margem = precoTeto !== null && cotacao !== null ? precoTeto / cotacao - 1 : null;
    // Preço máximo a pagar para respeitar a margem de segurança exigida.
    const precoAlvo = precoTeto !== null ? precoTeto / (1 + margemMinima / 100) : null;
    const yieldAtual = dpa !== null && cotacao !== null ? dpa / cotacao : null;
    const payoutImplicito = modo === 'dividendo' && dpa !== null && lpa ? (dpa / lpa) * 100 : null;

    // Lista campo a campo o que impede o cálculo, para a tela poder dizer o que digitar.
    let veredito = 'incompleto';
    const faltando = [];
    if (cotacao === null) faltando.push('cotação');
    if (!yieldAceitavel) faltando.push('yield');
    if (modo === 'dividendo') {
      if (dpa === null) faltando.push('DPA');
    } else {
      if (modo === 'lpa' && lpa === null) faltando.push('LPA');
      if (modo === 'lucro') {
        if (lucro === null) faltando.push('lucro');
        if (quantidade === null) faltando.push('nº de ações');
      }
      if (payout === null) faltando.push('payout');
    }
    // Premissas preenchidas, mas o resultado não é um dividendo positivo (prejuízo, payout 0).
    if (!faltando.length && (dpa === null || dpa <= 0)) faltando.push('lucro positivo');
    if (!faltando.length) {
      veredito = margem * 100 >= margemMinima ? 'sim' : 'nao';
    }

    return {
      modo,
      cotacao,
      yieldAceitavel,
      lpa,
      dpa,
      precoTeto,
      margem,
      precoAlvo,
      yieldAtual,
      payoutImplicito,
      veredito,
      faltando,
    };
  }

  /** Avalia a carteira inteira e devolve o resumo agregado. */
  function avaliarCarteira(ativos, config) {
    const linhas = (ativos || []).map((ativo) => ({ ativo, metricas: avaliarAtivo(ativo, config) }));
    const comprar = linhas.filter((l) => l.metricas.veredito === 'sim');
    const margens = comprar
      .map((l) => l.metricas.margem)
      .filter((m) => typeof m === 'number' && Number.isFinite(m));
    return {
      linhas,
      resumo: {
        total: linhas.length,
        comprar: comprar.length,
        aguardar: linhas.filter((l) => l.metricas.veredito === 'nao').length,
        incompletos: linhas.filter((l) => l.metricas.veredito === 'incompleto').length,
        melhorMargem: margens.length ? Math.max(...margens) : null,
      },
    };
  }

  return { parseNumero, avaliarAtivo, avaliarCarteira, MULTIPLICADORES };
});
