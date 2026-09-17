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

  /**
   * `fetch` rejeita com TypeError quando o próprio navegador barra a chamada
   * (CORS, CSP de página publicada, extensão) — é diferente de estar offline.
   */
  function bloqueadoPeloNavegador(erro) {
    return erro instanceof TypeError || /failed to fetch|load failed|networkerror/i.test(erro.message || '');
  }

  function motivoDeFalhaDeRede(erro) {
    if (bloqueadoPeloNavegador(erro)) {
      return 'O navegador bloqueou a chamada à brapi (CORS ou política da página publicada). Use o index.html na sua máquina ou preencha a cotação à mão.';
    }
    return `Sem conexão com a brapi (${erro.message}). Preencha a cotação à mão.`;
  }

  /**
   * Roda uma bateria de chamadas para separar as causas possíveis de "não atualiza":
   * rede bloqueada, token recusado na URL, token recusado no header, plano sem
   * fundamentos. Nunca devolve o token em texto.
   */
  async function diagnosticar(opcoes) {
    const { token, fetchImpl } = opcoes || {};
    const http = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!http) throw new Error('fetch indisponível neste ambiente.');
    const etapas = [];

    const executar = async (rotulo, chave, url, cabecalhos) => {
      const inicio = Date.now();
      try {
        const resposta = await http(url, { headers: { Accept: 'application/json', ...(cabecalhos || {}) } });
        const etapa = { rotulo, chave, ok: resposta.ok, status: resposta.status, ms: Date.now() - inicio };
        if (resposta.ok) {
          const corpo = await resposta.json().catch(() => null);
          const primeiro = corpo && Array.isArray(corpo.results) ? corpo.results[0] : null;
          etapa.preco = primeiro ? Number(primeiro.regularMarketPrice) || null : null;
          etapa.lpa = primeiro?.defaultKeyStatistics?.trailingEps ?? null;
        } else {
          etapa.detalhe = mensagemDeErro(resposta.status);
        }
        etapas.push(etapa);
      } catch (erro) {
        etapas.push({
          rotulo, chave, ok: false, status: 0, ms: Date.now() - inicio,
          bloqueado: bloqueadoPeloNavegador(erro), detalhe: erro.message,
        });
      }
    };

    // PETR4 é liberada pela brapi sem token: isola problema de rede de problema de token.
    await executar('Rede: PETR4 sem token', 'rede', `${BASE}PETR4`);
    if (token) {
      const seguro = encodeURIComponent(token);
      await executar('Token na URL (?token=)', 'url', `${BASE}PETR4?token=${seguro}`);
      await executar('Token no header (Bearer)', 'header', `${BASE}PETR4`, { Authorization: `Bearer ${token}` });
      await executar('Fundamentos (LPA/dividendos)', 'fundamentos', `${BASE}PETR4?modules=${MODULOS}&dividends=true&token=${seguro}`);
    }
    return etapas;
  }

  /** Traduz o resultado do diagnóstico em uma conclusão em português. */
  function interpretar(etapas) {
    const achar = (chave) => (etapas || []).find((e) => e.chave === chave);
    const rede = achar('rede');
    if (!rede) return 'Diagnóstico não executado.';
    if (rede.bloqueado) {
      return 'O navegador bloqueou a chamada antes de sair. É o caso típico da página publicada, que não tem permissão de rede: baixe o repositório e abra o index.html na sua máquina.';
    }
    if (!rede.ok && rede.status === 0) {
      return `Não houve resposta da brapi (${rede.detalhe || 'sem detalhe'}). Verifique sua conexão.`;
    }
    if (!rede.ok) {
      return `A brapi respondeu HTTP ${rede.status} até no ticker livre (PETR4). O problema não é o seu token: ${rede.detalhe || ''}`.trim();
    }

    const url = achar('url');
    const header = achar('header');
    if (!url && !header) return 'A rede está ok. Cole o token no campo para testar a autenticação.';
    if (url?.ok || header?.ok) {
      const via = url?.ok ? 'na URL' : 'no header Authorization';
      const fundamentos = achar('fundamentos');
      if (fundamentos && !fundamentos.ok) {
        return `Rede e token ok (token aceito ${via}). Seu plano não cobre fundamentos (HTTP ${fundamentos.status}) — a cotação atualiza, LPA e dividendos não.`;
      }
      if (fundamentos?.ok && fundamentos.lpa === null) {
        return `Rede e token ok (token aceito ${via}). A API aceitou o pedido de fundamentos, mas não devolveu LPA para PETR4.`;
      }
      return `Tudo ok: token aceito ${via}${fundamentos?.ok ? ' e fundamentos liberados' : ''}. Se ainda não atualiza, confira se os tickers estão no formato da B3 (PETR4, TAEE11).`;
    }
    return `O token foi recusado nas duas formas (URL: HTTP ${url?.status}, header: HTTP ${header?.status}). Confira se copiou o token inteiro em brapi.dev/dashboard.`;
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

    const pedir = async (lote, comFundamentos, viaHeader) => {
      const cabecalhos = { Accept: 'application/json' };
      if (viaHeader && token) cabecalhos.Authorization = `Bearer ${token}`;
      const url = montarUrl(lote, viaHeader ? null : token, comFundamentos);
      const resposta = await http(url, { headers: cabecalhos });
      if (!resposta.ok) return { status: resposta.status };
      const corpo = await resposta.json();
      return { resultados: Array.isArray(corpo.results) ? corpo.results : [] };
    };

    // A brapi documenta o token no header Authorization, mas historicamente aceita
    // ?token= na URL (que não dispara preflight de CORS). Tentamos a URL primeiro e
    // caímos para o header se o token for recusado.
    const tentar = async (lote, comFundamentos) => {
      const naUrl = await pedir(lote, comFundamentos, false);
      if (naUrl.status !== 401 || !token) return naUrl;
      const noHeader = await pedir(lote, comFundamentos, true);
      if (!noHeader.status) {
        avisos.add('Seu token só é aceito no header Authorization — o app já usa esse caminho.');
        return noHeader;
      }
      return noHeader.status === 401 ? naUrl : noHeader;
    };

    for (const lote of dividirEmLotes(limpos, LOTE)) {
      try {
        let retorno = await tentar(lote, fundamentos);

        // Plano sem direito aos módulos: refaz a chamada só com o preço.
        if (retorno.status && fundamentos && STATUS_DE_PLANO.includes(retorno.status)) {
          const semModulos = await tentar(lote, false);
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
        lote.forEach((t) => { erros[t] = motivoDeFalhaDeRede(erro); });
      }
    }

    return { dados, erros, avisos: [...avisos] };
  }

  return { buscarCotacoes, diagnosticar, interpretar, somarProventos12m, normalizar, mensagemDeErro, motivoDeFalhaDeRede, LOTE };
});
