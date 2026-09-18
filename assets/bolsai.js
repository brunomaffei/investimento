/**
 * Fundamentos pela API da bolsai (https://usebolsai.com), que normaliza dados da
 * CVM/B3 e cobre LPA e dividendos no plano gratuito (200 requisições/dia).
 *
 *   Base:  https://api.usebolsai.com/api/v1
 *   Auth:  header X-API-Key
 *   LPA:   GET /fundamentals/{ticker}    (27 indicadores TTM)
 *   DPA:   GET /dividends/{ticker}       (eventos com data e valor)
 *
 * Sobre nomes de campo: a documentação pública mistura nomes em português e
 * inglês, então cada métrica é buscada por uma lista de candidatos e o resultado
 * informa QUAL chave foi usada (`origem`). Quando nada casa, devolvemos as chaves
 * recebidas em `chavesRecebidas` — é o que permite corrigir sem adivinhação.
 * Use `node tools/inspecionar-bolsai.mjs TICKER` para ver a resposta real.
 *
 * Só são lidos valores em reais por ação (LPA e proventos), nunca percentuais
 * como payout ou dividend yield: esses vêm em escalas ambíguas (0,45 ou 45) e,
 * no caso do payout, são premissa do usuário de todo jeito.
 */
(function (root, factory) {
  const proventos = typeof require === 'function' ? require('./proventos.js') : root.Proventos;
  const api = factory(proventos);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Bolsai = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Proventos) {
  'use strict';

  const BASE = 'https://api.usebolsai.com/api/v1';

  const CANDIDATOS_LPA = ['lpa', 'eps', 'lucro_por_acao', 'lucroPorAcao', 'earnings_per_share', 'earningsPerShare', 'trailing_eps', 'trailingEps'];
  // Datas, valores e a soma de 12 meses são os mesmos de qualquer fonte: assets/proventos.js.
  const { CANDIDATOS_DATA, CANDIDATOS_VALOR } = Proventos;

  const numero = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim()) {
      const n = Number(v.replace(',', '.'));
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };

  /**
   * Prazo de toda consulta externa. Sem isso, uma fonte que aceita a conexão e não
   * responde segurava a atualização por minutos (o padrão do Node desiste perto dos
   * 5) — na tela, o botão ficava "Buscando…" até alguém recarregar a página.
   */
  const PRAZO_BOLSAI = 10000;

  const comPrazo = (ms) => (typeof AbortSignal === 'function' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined);

  /** Achata um nível de aninhamento (data/result/fundamentals) para procurar campos. */
  function achatar(corpo) {
    if (!corpo || typeof corpo !== 'object') return {};
    const plano = { ...corpo };
    for (const chave of ['data', 'result', 'results', 'fundamentals', 'fundamentos', 'indicators', 'indicadores']) {
      const filho = corpo[chave];
      if (filho && typeof filho === 'object' && !Array.isArray(filho)) Object.assign(plano, filho);
    }
    return plano;
  }

  /** Procura a primeira chave presente entre os candidatos e informa qual usou. */
  function extrair(plano, candidatos) {
    for (const chave of candidatos) {
      if (plano[chave] !== undefined && plano[chave] !== null) {
        const valor = numero(plano[chave]);
        if (valor !== null) return { valor, chave };
      }
    }
    return { valor: null, chave: null };
  }

  /** Soma os proventos de 12 meses (implementação compartilhada). */
  const somarProventos12m = (corpo, agora) => Proventos.somar12m(corpo, agora);

  function mensagemDeErro(status) {
    if (status === 401 || status === 403) return 'Chave da bolsai inválida ou ausente (X-API-Key).';
    if (status === 429) return 'Limite diário da bolsai atingido (200 requisições/dia no plano gratuito).';
    if (status === 404) return 'Ticker não encontrado na bolsai.';
    return `Falha na bolsai (HTTP ${status}).`;
  }

  /**
   * Busca LPA e proventos de 12 meses por ticker.
   * @param {string[]} tickers
   * @param {{chave: string, fetchImpl?: Function, base?: string, dividendos?: boolean}} opcoes
   * @returns {Promise<{dados: Object, erros: Object, avisos: string[]}>}
   */
  async function buscarFundamentos(tickers, opcoes) {
    const { chave, fetchImpl, base = BASE, dividendos = true, prazoMs = PRAZO_BOLSAI } = opcoes || {};
    const http = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!http) throw new Error('fetch indisponível neste ambiente.');

    const limpos = [...new Set((tickers || []).map((t) => String(t || '').trim().toUpperCase()).filter(Boolean))];
    const dados = {};
    const erros = {};
    const avisos = new Set();
    const cabecalhos = { Accept: 'application/json', ...(chave ? { 'X-API-Key': chave } : {}) };

    const pedir = async (caminho) => {
      const resposta = await http(`${base}${caminho}`, { headers: cabecalhos, signal: comPrazo(prazoMs) });
      if (!resposta.ok) return { status: resposta.status };
      return { corpo: await resposta.json() };
    };

    for (const ticker of limpos) {
      try {
        const fundamentos = await pedir(`/fundamentals/${encodeURIComponent(ticker)}`);
        if (fundamentos.status) {
          erros[ticker] = mensagemDeErro(fundamentos.status);
          continue;
        }
        const plano = achatar(fundamentos.corpo);
        const lpa = extrair(plano, CANDIDATOS_LPA);
        const registro = { lpa: lpa.valor, dpa12m: null, origem: { lpa: lpa.chave, dpa: null } };

        if (lpa.valor === null) {
          registro.chavesRecebidas = Object.keys(plano).slice(0, 40);
          avisos.add(`A bolsai respondeu para ${ticker} mas nenhum campo de LPA foi reconhecido. Rode "node tools/inspecionar-bolsai.mjs ${ticker}" e ajuste a lista de candidatos em assets/bolsai.js.`);
        }

        if (dividendos) {
          const proventos = await pedir(`/dividends/${encodeURIComponent(ticker)}`);
          if (proventos.status) {
            avisos.add(`Proventos de ${ticker} não vieram: ${mensagemDeErro(proventos.status)}`);
          } else {
            const soma = somarProventos12m(proventos.corpo);
            registro.dpa12m = soma.valor;
            registro.origem.dpa = soma.chaveValor;
            registro.eventos12m = soma.eventos;
          }
        }

        dados[ticker] = registro;
      } catch (erro) {
        erros[ticker] = `Sem conexão com a bolsai (${erro.message}).`;
      }
    }

    return { dados, erros, avisos: [...avisos] };
  }

  return {
    buscarFundamentos, somarProventos12m, extrair, achatar, mensagemDeErro,
    BASE, CANDIDATOS_LPA, CANDIDATOS_VALOR, CANDIDATOS_DATA,
  };
});
