/**
 * Núcleo de cálculo do preço-teto (método Décio Bazin) e da margem de segurança.
 *
 * Fórmulas:
 *   LPA (lucro por ação)      = lucro projetado / quantidade de ações
 *   DPA (dividendo por ação)  = LPA x payout
 *   Preço-teto                = DPA / yield aceitável
 *   Margem de segurança       = (preço-teto / cotação atual) - 1
 *
 * Posição (o que a pessoa realmente tem):
 *   valor investido = quantidade x preço médio
 *   valor de hoje   = quantidade x cotação
 *   renda anual     = quantidade x DPA
 *   yield on cost   = DPA / preço médio   (o yield que a SUA compra travou)
 *
 * Unidades, para não misturar: payout e yield aceitável são PONTOS PERCENTUAIS
 * (6 = 6%); margem, yieldAtual, yieldOnCost e resultadoPct são FRAÇÕES (0,06 = 6%).
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

  // Corte clássico do método Bazin. Vale quando ninguém informou yield: campo de
  // configuração vazio não pode travar a carteira inteira — o usuário não tem como
  // adivinhar que o "6" cinza do campo era só um exemplo.
  const YIELD_PADRAO = 6;

  // Faixa de sanidade do yield aceitável, em pontos percentuais. Fora dela quase
  // sempre é erro de unidade: quem digita 0,06 pensando em "6%" recebia preço-teto
  // 100 vezes maior e a carteira inteira virava SIM.
  const YIELD_MINIMO_RAZOAVEL = 1;
  const YIELD_MAXIMO_RAZOAVEL = 30;

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
      // Ambíguo: "1.234" é milhar, "20.56" é decimal. Grupo final de 3 dígitos indica
      // milhar — mas só quando a parte inteira tem cara de milhar: "0.850" é o LPA
      // copiado de site em inglês, e virar 850 inflava o preço-teto em mil vezes.
      const [inteiros, decimais] = texto.split('.');
      const pareceMilhar = decimais.length === 3
        && /^-?[1-9]\d{0,2}$/.test(inteiros);
      if (pareceMilhar) texto = texto.replace('.', '');
    }

    const numero = Number(texto);
    if (!Number.isFinite(numero)) return null;
    return numero * escala;
  }

  const positivo = (n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null);

  /**
   * Avalia um ativo e devolve as métricas derivadas.
   * @param {object} ativo   Premissas do ativo (ver seed.js para o formato).
   * @param {object} config  { yieldPadrao, payoutPadrao, margemMinima } em pontos percentuais.
   */
  function avaliarAtivo(ativo, config) {
    const cfg = config || {};
    const yieldPadrao = parseNumero(cfg.yieldPadrao);
    const payoutPadrao = parseNumero(cfg.payoutPadrao);
    const margemMinima = parseNumero(cfg.margemMinima) || 0;

    const cotacao = positivo(parseNumero(ativo.cotacao));
    const yieldAceitavel = positivo(parseNumero(ativo.yieldAceitavel))
      ?? positivo(yieldPadrao)
      ?? YIELD_PADRAO;
    const yieldDoFallback = positivo(parseNumero(ativo.yieldAceitavel)) === null
      && positivo(yieldPadrao) === null;
    const modo = ['dividendo', 'lpa'].includes(ativo.modo) ? ativo.modo : 'lucro';

    const lucro = parseNumero(ativo.lucroProjetado);
    const quantidade = positivo(parseNumero(ativo.quantidadeAcoes));
    // Payout: o da linha, o padrão da carteira ou — na falta dos dois — o que o
    // mercado praticou nos últimos 12 meses (DPA pago ÷ LPA). O último não é
    // premissa inventada: é o payout realizado, calculado com dados de fonte.
    const payoutDaLinha = parseNumero(ativo.payout);
    const dpaDeMercado = positivo(parseNumero(ativo.dpa12mMercado));

    let lpa = modo === 'lpa'
      ? parseNumero(ativo.lpaInformado)
      : lucro !== null && quantidade !== null
        ? lucro / quantidade
        : null;

    // Só faz sentido com lucro positivo: em prejuízo, o payout de mercado saía
    // negativo e, multiplicado por um LPA também negativo, devolvia DPA positivo —
    // empresa no vermelho ganhava preço-teto e selo SIM.
    const payoutDeMercado = dpaDeMercado !== null && lpa !== null && lpa > 0
      ? (dpaDeMercado / lpa) * 100
      : null;
    const payout = payoutDaLinha !== null
      ? payoutDaLinha
      : payoutPadrao !== null
        ? payoutPadrao
        : payoutDeMercado;
    const origemPayout = payoutDaLinha !== null ? 'linha'
      : payoutPadrao !== null ? 'padrao'
        : payoutDeMercado !== null ? 'mercado' : null;

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

    // ---- posição: quantas ações a pessoa tem e quanto pagou por elas --------
    // CUIDADO com os nomes: `quantidade` (acima) é o número de ações DA EMPRESA,
    // divisor do lucro projetado. A posição da pessoa é `ativo.quantidade` e vive
    // aqui como `posicao`. Trocar os dois quebraria o preço-teto em silêncio.
    const posicao = positivo(parseNumero(ativo.quantidade));
    // Preço médio 0 seria custo zero (bonificação existe), mas dividir por ele dá
    // Infinity: fora do cálculo, com a linha marcada como incompleta.
    const precoMedio = positivo(parseNumero(ativo.precoMedio));

    const valorInvestido = posicao !== null && precoMedio !== null ? posicao * precoMedio : null;
    const valorAtual = posicao !== null && cotacao !== null ? posicao * cotacao : null;
    // Mesma guarda do preço-teto: prejuízo ou payout zero não viram renda.
    const rendaAnual = posicao !== null && dpa !== null && dpa > 0 ? posicao * dpa : null;
    // MÉDIA, não fluxo real: no app o DPA é sempre anual. Ação paga em datas
    // irregulares e FII costuma pagar todo mês — o rótulo na tela diz isso.
    const rendaMensal = rendaAnual === null ? null : rendaAnual / 12;
    const yieldOnCost = dpa !== null && dpa > 0 && precoMedio !== null ? dpa / precoMedio : null;
    const resultado = valorAtual !== null && valorInvestido !== null ? valorAtual - valorInvestido : null;
    const resultadoPct = resultado !== null && valorInvestido > 0 ? resultado / valorInvestido : null;
    // Sinal para a tela, não para o veredito: ter quantidade sem preço médio (ou sem
    // cotação) não impede o preço-teto do Bazin — só impede o resultado da posição.
    const posicaoIncompleta = posicao !== null && (precoMedio === null || cotacao === null);
    const payoutImplicito = modo === 'dividendo' && dpa !== null && lpa ? (dpa / lpa) * 100 : null;

    // Lista campo a campo o que impede o cálculo, para a tela poder dizer o que digitar.
    let veredito = 'incompleto';
    const faltando = [];
    if (cotacao === null) faltando.push('cotação');

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
      yieldDoFallback,
      yieldSuspeito: yieldAceitavel < YIELD_MINIMO_RAZOAVEL || yieldAceitavel > YIELD_MAXIMO_RAZOAVEL,
      lpa,
      dpa,
      precoTeto,
      margem,
      precoAlvo,
      yieldAtual,
      payout,
      origemPayout,
      payoutDeMercado,
      dpaDeMercado,
      // Dividend yield do provento pago sobre o preço de hoje: número de conferência,
      // porque histórico incompleto de proventos aparece como yield baixo demais.
      yieldDeMercado: dpaDeMercado !== null && cotacao !== null ? dpaDeMercado / cotacao : null,
      payoutDoPadrao: origemPayout === 'padrao',
      payoutImplicito,
      // Posição. Valor em reais; yieldOnCost e resultadoPct em fração.
      posicao,
      precoMedio,
      valorInvestido,
      valorAtual,
      rendaAnual,
      rendaMensal,
      yieldOnCost,
      resultado,
      resultadoPct,
      posicaoIncompleta,
      veredito,
      faltando,
    };
  }

  /**
   * Soma que preserva o "não informado": zero parcela devolve null, não 0 — um
   * total de R$ 0,00 numa carteira ainda não preenchida parece resposta, e não é.
   * Soma sempre os valores crus; arredondar antes acumularia centavos.
   */
  function somar(linhas, pegar) {
    let total = null;
    for (const linha of linhas) {
      const valor = pegar(linha.metricas);
      if (typeof valor !== 'number' || !Number.isFinite(valor)) continue;
      total = (total === null ? 0 : total) + valor;
    }
    return total;
  }

  /**
   * Totais da posição. Resultado e yield on cost saem do MESMO subconjunto de
   * linhas: misturar quem informou preço médio com quem não informou inflaria o
   * lucro e o yield da carteira inteira.
   */
  function totaisDaPosicao(linhas) {
    const comPosicao = linhas.filter((l) => l.metricas.posicao !== null);
    const comparaveis = comPosicao.filter((l) => l.metricas.valorInvestido !== null && l.metricas.valorAtual !== null);

    const valorInvestido = somar(comparaveis, (m) => m.valorInvestido);
    const valorAtualComparavel = somar(comparaveis, (m) => m.valorAtual);
    const rendaAnual = somar(comPosicao, (m) => m.rendaAnual);
    const rendaAnualComparavel = somar(comparaveis, (m) => m.rendaAnual);

    return {
      ativos: comPosicao.length,
      // Valor de hoje da carteira inteira (inclui quem não lembra o preço médio).
      valorAtual: somar(comPosicao, (m) => m.valorAtual),
      valorInvestido,
      resultado: valorInvestido !== null && valorAtualComparavel !== null
        ? valorAtualComparavel - valorInvestido
        : null,
      resultadoPct: valorInvestido !== null && valorInvestido > 0 && valorAtualComparavel !== null
        ? valorAtualComparavel / valorInvestido - 1
        : null,
      rendaAnual,
      rendaMensal: rendaAnual === null ? null : rendaAnual / 12,
      // Agregado (renda ÷ custo), nunca a média dos yields: média de razões mente
      // quando as posições têm tamanhos diferentes.
      yieldOnCost: rendaAnualComparavel !== null && valorInvestido > 0
        ? rendaAnualComparavel / valorInvestido
        : null,
      // Contagens para a tela poder explicar de onde o número saiu — e o que falta.
      comparaveis: comparaveis.length,
      semPrecoMedio: comPosicao.filter((l) => l.metricas.precoMedio === null).length,
      semCotacao: comPosicao.filter((l) => l.metricas.cotacao === null).length,
      semProvento: comPosicao.filter((l) => l.metricas.rendaAnual === null).length,
    };
  }

  /**
   * Simulação de compra: soma ao que a pessoa já tem, nunca substitui.
   * "Se eu comprar 300 ações de X" é uma compra INCREMENTAL — sobrescrever a
   * posição responderia outra pergunta e ainda apagaria o dado real.
   *
   * A compra é feita pela cotação de hoje (é o preço que ela pagaria agora) e o
   * preço médio novo sai da média ponderada. Venda (quantidade negativa) reduz a
   * posição e mantém o preço médio, que é como o custo médio funciona.
   *
   * @returns {{ativos: object[], custo: number|null, caixa: number|null, compras: number}}
   */
  function simularCompras(ativos) {
    let custo = null;
    let caixa = null;
    let compras = 0;

    const simulados = (ativos || []).map((ativo) => {
      const delta = parseNumero(ativo.simulacaoQtd);
      if (delta === null || delta === 0) return ativo;
      const cotacao = positivo(parseNumero(ativo.cotacao));
      const posicao = positivo(parseNumero(ativo.quantidade)) ?? 0;
      const precoMedio = positivo(parseNumero(ativo.precoMedio));
      const nova = posicao + delta;
      compras++;

      if (delta > 0 && cotacao !== null) {
        custo = (custo === null ? 0 : custo) + delta * cotacao;
      }
      if (delta < 0 && cotacao !== null) {
        caixa = (caixa === null ? 0 : caixa) + Math.min(posicao, -delta) * cotacao;
      }
      // Vendeu tudo: a linha continua na carteira (o preço-teto ainda interessa),
      // mas sem posição.
      if (nova <= 0) return { ...ativo, quantidade: 0, simulado: true };

      const precoMedioNovo = delta > 0 && cotacao !== null
        ? (precoMedio !== null ? (posicao * precoMedio + delta * cotacao) / nova : cotacao)
        : precoMedio;

      return {
        ...ativo,
        quantidade: nova,
        precoMedio: precoMedioNovo === null ? '' : precoMedioNovo,
        simulado: true,
      };
    });

    return { ativos: simulados, custo, caixa, compras };
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
        carteira: totaisDaPosicao(linhas),
      },
    };
  }

  return {
    parseNumero, avaliarAtivo, avaliarCarteira, totaisDaPosicao, simularCompras, MULTIPLICADORES,
    YIELD_PADRAO, YIELD_MINIMO_RAZOAVEL, YIELD_MAXIMO_RAZOAVEL,
  };
});
