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
  // A brapi também expõe uma API v2 com rotas separadas (/api/v2/stocks/quote?symbols=…).
  // O app usa a v1; o diagnóstico sonda a v2 para descobrir o que o plano serve lá.
  const paraV2 = (base) => String(base || BASE).replace(/\/quote\/?$/, '/v2/stocks');
  // Formato de ticker da B3 (PETR4, TAEE11): evita consultar linhas de exemplo.
  const TICKER_B3 = /^[A-Z]{4}\d{1,2}$/;
  // A brapi libera estes quatro por completo, sem token e sem restrição de plano —
  // então eles NÃO servem para descobrir o que o seu plano cobre.
  const LIVRES = ['PETR4', 'MGLU3', 'VALE3', 'ITUB4'];
  const LOTE = 10; // a brapi aceita vários tickers por chamada; lotes evitam URLs gigantes
  const MODULOS = 'defaultKeyStatistics,summaryProfile';

  const dividirEmLotes = (itens, tamanho) => {
    const lotes = [];
    for (let i = 0; i < itens.length; i += tamanho) lotes.push(itens.slice(i, i + tamanho));
    return lotes;
  };

  const STATUS_DE_PLANO = [401, 402, 403];
  // O plano gratuito aceita um ticker por requisição. A recusa do lote chega como
  // 400/413/414, mas também como 403 quando a rota pedida é paga para vários —
  // então 402/403 também merecem a tentativa individual. 401 não: token inválido
  // não melhora dividindo o lote, e insistir só gastaria requisição.
  const STATUS_DE_LOTE = [400, 413, 414];
  const VALE_TENTAR_UM_A_UM = [...STATUS_DE_LOTE, 402, 403];

  function mensagemDeErro(status) {
    if (status === 401) return 'Token inválido ou ausente (pegue um grátis em brapi.dev).';
    if (status === 403) return 'Seu plano não cobre esses dados (a cotação é gratuita; fundamentos são pagos).';
    if (status === 402 || status === 429) return 'Limite do plano atingido. Tente de novo mais tarde.';
    if (status === 404) return 'Ticker não encontrado na B3.';
    if (status === 400) return 'A brapi recusou a consulta (HTTP 400) — no plano gratuito, um ticker por vez.';
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

  const ASSINATURA_SERVIDOR = 'preco-teto';

  /**
   * Procura tickers parecidos em /api/quote/list?search=…, para quando um código
   * não existe mais (CPLE6 virou CPLE3 na migração da Copel ao Novo Mercado, por
   * exemplo) e o usuário precisa saber qual usar no lugar.
   * @param {string} termo Parte do código, normalmente as 4 primeiras letras.
   * @param {{token?: string, fetchImpl?: Function, base?: string, limite?: number, excluir?: string}} [opcoes]
   *   excluir: o código que falhou — sugerir ele de volta não ajudaria ninguém.
   * @returns {Promise<string[]>} códigos encontrados.
   */
  async function buscarTickersParecidos(termo, opcoes = {}) {
    const { token, fetchImpl, base = BASE, limite = 6, excluir } = opcoes;
    const http = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    const busca = String(termo || '').trim().toUpperCase();
    if (!http || busca.length < 3) return [];

    const params = new URLSearchParams({ search: busca });
    if (token) params.set('token', token);
    try {
      const resposta = await http(`${base}list?${params}`, { headers: { Accept: 'application/json' } });
      if (!resposta.ok) return [];
      const corpo = await resposta.json();
      // A lista vem em `stocks`; cada item traz o código em `stock`.
      const itens = Array.isArray(corpo?.stocks) ? corpo.stocks
        : Object.values(corpo || {}).find(Array.isArray) || [];
      const codigos = itens
        .map((i) => String(i?.stock || i?.symbol || i?.ticker || i || '').toUpperCase())
        .filter((c) => TICKER_B3.test(c) && c !== busca && c !== String(excluir || '').toUpperCase());
      return [...new Set(codigos)].slice(0, limite);
    } catch {
      return [];
    }
  }

  /**
   * O app pode ser servido por `tools/servidor.mjs`, que consulta a brapi do lado
   * do servidor (sem CORS) e guarda o token fora do navegador. Detecta se esse
   * servidor está atendendo nesta origem.
   */
  async function detectarServidor(opcoes) {
    const { fetchImpl, base = '' } = opcoes || {};
    const ausente = { disponivel: false, comToken: false, comBolsai: false, comUniverso: false };
    const http = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!http) return ausente;
    // Em file:// não há servidor para consultar.
    if (typeof location !== 'undefined' && !/^https?:$/.test(location.protocol)) return ausente;
    try {
      const resposta = await http(`${base}/api/health`, { headers: { Accept: 'application/json' } });
      if (!resposta.ok) return ausente;
      const corpo = await resposta.json();
      if (!corpo || corpo.servico !== ASSINATURA_SERVIDOR) return ausente;
      return {
        disponivel: true,
        comToken: !!corpo.comToken,
        comBolsai: !!corpo.comBolsai,
        // Servidores antigos não têm o rastreador: a tela precisa saber antes de pedir.
        comUniverso: !!corpo.comUniverso,
        versao: corpo.versao || null,
      };
    } catch {
      return ausente;
    }
  }

  /**
   * Busca as cotações através do servidor local, que devolve o mesmo formato.
   * O token é enviado só quando o servidor não tem o seu (BRAPI_TOKEN ausente):
   * é a mesma máquina, e sem isso o token digitado na tela seria ignorado.
   */
  async function buscarPeloServidor(tickers, opcoes) {
    const { fundamentos = false, fetchImpl, base = '', token } = opcoes || {};
    const http = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!http) throw new Error('fetch indisponível neste ambiente.');
    const limpos = [...new Set((tickers || []).map((t) => String(t || '').trim().toUpperCase()).filter(Boolean))];
    if (!limpos.length) return { dados: {}, erros: {}, avisos: [] };

    const params = new URLSearchParams({ tickers: limpos.join(',') });
    if (fundamentos) params.set('fundamentos', '1');
    if (token) params.set('token', token);
    const resposta = await http(`${base}/api/cotacoes?${params}`, { headers: { Accept: 'application/json' } });
    if (!resposta.ok) {
      const motivo = `O servidor local respondeu HTTP ${resposta.status}.`;
      return { dados: {}, erros: Object.fromEntries(limpos.map((t) => [t, motivo])), avisos: [] };
    }
    const corpo = await resposta.json();
    return {
      dados: corpo.dados || {},
      erros: corpo.erros || {},
      avisos: corpo.avisos || [],
    };
  }

  /**
   * Roda uma bateria de chamadas para separar as causas possíveis de "não atualiza":
   * rede bloqueada, token recusado na URL, token recusado no header, plano sem
   * fundamentos. Nunca devolve o token em texto.
   */
  async function diagnosticar(opcoes) {
    const { token, fetchImpl, tickers = [], base = BASE } = opcoes || {};
    const http = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!http) throw new Error('fetch indisponível neste ambiente.');
    const etapas = [];

    const executar = async (rotulo, chave, url, cabecalhos, forma = 'brapi') => {
      const inicio = Date.now();
      try {
        const resposta = await http(url, { headers: { Accept: 'application/json', ...(cabecalhos || {}) } });
        const etapa = { rotulo, chave, ok: resposta.ok, status: resposta.status, ms: Date.now() - inicio };
        if (resposta.ok) {
          const corpo = await resposta.json().catch(() => null);
          if (forma === 'servidor') {
            // O servidor local devolve {dados, erros, avisos}, não o formato da brapi.
            const info = corpo?.dados ? Object.values(corpo.dados)[0] : null;
            etapa.preco = info?.preco ?? null;
            etapa.lpa = info?.lpa ?? null;
            const motivos = Object.values(corpo?.erros || {});
            if (!info && motivos.length) etapa.detalhe = motivos[0];
          } else {
            // A v1 devolve {results:[ativo]}, a v2 devolve {results:[{data:ativo}]}.
            const lista = Array.isArray(corpo?.results) ? corpo.results
              : Array.isArray(corpo) ? corpo
              : Object.values(corpo || {}).find(Array.isArray) || [];
            const item = lista[0] || null;
            const primeiro = item && typeof item.data === 'object' && item.data !== null ? item.data : item;
            etapa.preco = primeiro ? Number(primeiro.regularMarketPrice ?? primeiro.close ?? primeiro.price) || null : null;
            // Mesma leitura de normalizar(): earningsPerShare vem na raiz, sem módulo pago.
            const bruto = primeiro?.defaultKeyStatistics?.trailingEps ?? primeiro?.earningsPerShare;
            // Atenção: Number(null) é 0, o que mostraria "LPA 0,00" onde não há LPA.
            const lpa = bruto === null || bruto === undefined ? null : Number(bruto);
            etapa.lpa = Number.isFinite(lpa) ? lpa : null;
            if (primeiro) etapa.campos = Object.keys(primeiro).length;
          }
        } else {
          etapa.detalhe = chave.startsWith('v2-') && resposta.status === 404
            ? 'Essa rota não existe nessa versão da API.'
            : mensagemDeErro(resposta.status);
        }
        etapas.push(etapa);
      } catch (erro) {
        etapas.push({
          rotulo, chave, ok: false, status: 0, ms: Date.now() - inicio,
          bloqueado: bloqueadoPeloNavegador(erro), detalhe: erro.message,
        });
      }
    };

    // Fundamentos precisam ser testados num ticker que NÃO seja dos liberados,
    // senão o resultado diz respeito à cortesia da brapi, não ao seu plano.
    const candidatos = (tickers || []).map((t) => String(t || '').trim().toUpperCase()).filter((t) => TICKER_B3.test(t));
    const alvoFundamentos = candidatos.find((t) => !LIVRES.includes(t)) || null;

    const servidor = await detectarServidor({ fetchImpl: http });
    if (servidor.disponivel) {
      const params = new URLSearchParams({ tickers: 'PETR4' });
      if (!servidor.comToken && token) params.set('token', token);
      await executar(
        `Servidor local (sem CORS)${servidor.comToken ? ' com BRAPI_TOKEN' : ' sem BRAPI_TOKEN'}${servidor.comBolsai ? ' + bolsai' : ''}`,
        'servidor', `/api/cotacoes?${params}`, null, 'servidor',
      );
      Object.assign(etapas[etapas.length - 1], {
        comToken: servidor.comToken,
        comBolsai: servidor.comBolsai,
        versao: servidor.versao,
      });
    }
    // PETR4 é liberada pela brapi sem token: isola problema de rede de problema de token.
    await executar('Rede: PETR4 sem token', 'rede', `${BASE}PETR4`);
    if (token) {
      const seguro = encodeURIComponent(token);
      await executar('Token na URL (?token=)', 'url', `${BASE}PETR4?token=${seguro}`);
      await executar('Token no header (Bearer)', 'header', `${BASE}PETR4`, { Authorization: `Bearer ${token}` });
      const ticker = alvoFundamentos || 'PETR4';
      await executar(
        `Fundamentos (LPA/dividendos) em ${ticker}`,
        'fundamentos',
        `${BASE}${ticker}?modules=${MODULOS}&dividends=true&token=${seguro}`,
      );
      etapas[etapas.length - 1].tickerLivre = LIVRES.includes(ticker);

      // A v1 devolve earningsPerShare na raiz em alguns tickers, sem módulo pago:
      // se vier para um ticker seu, o LPA é automático sem bolsai e sem plano pago.
      await executar(`LPA na raiz (sem módulos) em ${ticker}`, 'lpa-raiz', `${BASE}${ticker}?token=${seguro}`);
      etapas[etapas.length - 1].tickerLivre = LIVRES.includes(ticker);

      // Sondagem da API v2: se ela servir fundamentos no seu plano, o app pode migrar.
      const v2 = paraV2(base);
      await executar(`v2: cotação de ${ticker}`, 'v2-quote', `${v2}/quote?symbols=${ticker}&token=${seguro}`);
      await executar(`v2: fundamentos de ${ticker}`, 'v2-fundamentos', `${v2}/fundamentals?symbols=${ticker}&token=${seguro}`);
      await executar(`v2: perfil de ${ticker}`, 'v2-profile', `${v2}/profile?symbols=${ticker}&token=${seguro}`);
    }
    return etapas;
  }

  /**
   * Complemento sobre o LPA vindo na resposta comum (sem módulo pago). Devolve
   * string vazia quando não há notícia — aí quem fala é a ressalva do plano.
   */
  function noticiaDoLpa(raiz) {
    if (!raiz?.ok || raiz.lpa === null || raiz.lpa === undefined) return '';
    const emQual = raiz.rotulo?.split(' em ')[1] || 'seu ticker';
    if (raiz.tickerLivre) {
      return ` O LPA veio na resposta comum, mas só em ${emQual}, que a brapi libera de graça — acrescente um ticker seu à lista para saber se vale para os demais.`;
    }
    return ` E a melhor notícia: a brapi devolveu o LPA de ${emQual} (${raiz.lpa}) na resposta comum, sem módulo pago — o app preenche o LPA sozinho, sem bolsai e sem plano pago.`;
  }

  /** Complemento sobre fundamentos, que dependem do plano e não da conexão. */
  function ressalvaDeFundamentos(fundamentos) {
    if (!fundamentos) return '';
    const emQual = fundamentos.rotulo?.split(' em ')[1];
    if (!fundamentos.ok) {
      return ` Já os fundamentos da brapi foram recusados${emQual ? ` em ${emQual}` : ''} (HTTP ${fundamentos.status}): nesse plano, LPA e dividendos vêm da bolsai (BOLSAI_KEY) ou você preenche à mão.`;
    }
    if (fundamentos.tickerLivre) {
      return ` Os fundamentos só foram testados em ${emQual || 'PETR4'}, que a brapi libera de graça — isso não prova que seu plano cobre os demais.`;
    }
    return ` Os fundamentos também vieram${emQual ? ` em ${emQual}` : ''}, então LPA e dividendos podem ser preenchidos automaticamente.`;
  }

  /** Traduz o resultado do diagnóstico em uma conclusão em português. */
  function interpretar(etapas) {
    const achar = (chave) => (etapas || []).find((e) => e.chave === chave);
    const servidor = achar('servidor');
    if (servidor?.ok && servidor.preco) {
      const origemToken = servidor.comToken ? 'o token do servidor (BRAPI_TOKEN)' : 'o token digitado aqui, repassado ao servidor';
      const base = `O servidor local está respondendo e trouxe preço usando ${origemToken} — as cotações passam por ele, sem CORS.`;
      if (servidor.comBolsai) {
        return `${base} Os fundamentos (LPA e proventos) vêm da bolsai pelo servidor, então não dependem do seu plano na brapi.`;
      }
      // LPA liberado na resposta comum é a informação mais útil daqui: vem antes
      // da ressalva sobre o plano, e não pode ficar escondida atrás deste ramo.
      return `${base}${noticiaDoLpa(achar('lpa-raiz')) || ressalvaDeFundamentos(achar('fundamentos'))}`;
    }
    if (servidor?.ok && !servidor.preco) {
      const semToken = servidor.comToken === false;
      return semToken
        ? `O servidor local responde, mas não trouxe preço${servidor.detalhe ? ` (${servidor.detalhe})` : ''}. Ele subiu sem BRAPI_TOKEN: reinicie com BRAPI_TOKEN=seu_token npm start, ou mantenha o token neste campo — o app agora o repassa ao servidor.`
        : `O servidor local responde, mas não trouxe preço${servidor.detalhe ? `: ${servidor.detalhe}` : '.'}`;
    }
    const rede = achar('rede');
    if (!rede) return 'Diagnóstico não executado.';
    if (rede.bloqueado) {
      return 'O navegador bloqueou a chamada antes de sair — é o caso da página publicada (sem permissão de rede) e também de abrir o arquivo por file:// quando o CORS recusa. Solução: rode `npm start` no repositório e abra http://localhost:8787, que consulta a brapi pelo servidor.';
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
      const v2Fund = achar('v2-fundamentos');
      const noticia = noticiaDoLpa(achar('lpa-raiz'));
      if (noticia) return `Rede e token ok (token aceito ${via}).${noticia}`;
      // A v2 pode servir no plano em que a v1 recusa: essa informação vem primeiro.
      if (fundamentos && !fundamentos.ok && v2Fund?.ok) {
        return `Rede e token ok (token aceito ${via}). Os fundamentos da API v1 foram recusados (HTTP ${fundamentos.status}), mas a rota v2 respondeu — vale migrar o app para /api/v2/stocks/fundamentals. Me mande esta linha do diagnóstico.`;
      }
      if (fundamentos && !fundamentos.ok) {
        const alternativa = v2Fund && !v2Fund.ok ? ` A rota v2 também recusou (HTTP ${v2Fund.status}).` : '';
        return `Rede e token ok (token aceito ${via}). Seu plano não cobre fundamentos (HTTP ${fundamentos.status}) — a cotação atualiza, LPA e dividendos não.${alternativa} Com BOLSAI_KEY no servidor, o LPA vem da bolsai.`;
      }
      if (fundamentos?.ok && fundamentos.tickerLivre) {
        return `Rede e token ok (token aceito ${via}). Os fundamentos foram testados em ${fundamentos.rotulo.split(' em ')[1] || 'PETR4'}, que a brapi libera de graça — isso NÃO prova que seu plano cobre os demais. Adicione um ticker seu à lista e teste de novo.`;
      }
      if (fundamentos?.ok && fundamentos.lpa === null) {
        return `Rede e token ok (token aceito ${via}). A API aceitou o pedido de fundamentos, mas não devolveu LPA para esse ticker.`;
      }
      return `Tudo ok: token aceito ${via}${fundamentos?.ok ? ' e fundamentos liberados no seu plano' : ''}. Se ainda não atualiza, confira se os tickers estão no formato da B3 (PETR4, TAEE11).`;
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

  function montarUrl(lote, token, comFundamentos, base) {
    const params = new URLSearchParams();
    if (comFundamentos) {
      params.set('modules', MODULOS);
      params.set('dividends', 'true');
    }
    if (token) params.set('token', token);
    const consulta = params.toString();
    return `${base || BASE}${lote.join(',')}${consulta ? `?${consulta}` : ''}`;
  }

  /**
   * @param {string[]} tickers
   * @param {{token?: string, fundamentos?: boolean, fetchImpl?: Function, base?: string}} opcoes
   *   fundamentos: pede LPA/dividendos junto (exige plano pago, exceto nos tickers de teste).
   *   base: sobrescreve a URL da brapi (usada pelo servidor local e pelos testes).
   * @returns {Promise<{dados: Object, erros: Object, avisos: string[]}>}
   */
  async function buscarCotacoes(tickers, opcoes) {
    const { token, fetchImpl, fundamentos = false, base } = opcoes || {};
    const http = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!http) throw new Error('fetch indisponível neste ambiente.');

    const limpos = [...new Set((tickers || []).map((t) => String(t || '').trim().toUpperCase()).filter(Boolean))];
    const dados = {};
    const erros = {};
    const avisos = new Set();

    const pedir = async (lote, comFundamentos, viaHeader) => {
      const cabecalhos = { Accept: 'application/json' };
      if (viaHeader && token) cabecalhos.Authorization = `Bearer ${token}`;
      const url = montarUrl(lote, viaHeader ? null : token, comFundamentos, base);
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

    // O plano não serve módulos: descoberto uma vez, vale para o resto da consulta
    // (evita repetir o 403 em cada ticker quando o lote é dividido).
    let planoSemModulos = false;

    /**
     * Consulta com as duas quedas compostas: se o plano recusar os módulos pagos,
     * refaz sem eles. Precisa valer também por ticker, senão dividir o lote
     * devolveria só 403 e nenhuma cotação.
     */
    const consultar = async (alvos) => {
      const querFundamentos = fundamentos && !planoSemModulos;
      const retorno = await tentar(alvos, querFundamentos);
      if (!retorno.status || !querFundamentos || !STATUS_DE_PLANO.includes(retorno.status)) return retorno;

      const semModulos = await tentar(alvos, false);
      if (semModulos.resultados) {
        planoSemModulos = true;
        avisos.add('Fundamentos não liberados no seu plano da brapi — só a cotação foi atualizada.');
        return semModulos;
      }
      // As duas falharam: reportar a falha da consulta SIMPLES, que é a informativa
      // (um 404 de ticker inexistente diz mais do que o 403 do módulo pago).
      return semModulos;
    };

    for (const lote of dividirEmLotes(limpos, LOTE)) {
      try {
        let retorno = await consultar(lote);

        // Lote recusado: refaz ticker a ticker, que é o que o plano gratuito aceita.
        if (retorno.status && lote.length > 1 && VALE_TENTAR_UM_A_UM.includes(retorno.status)) {
          avisos.add('Seu plano aceita um ticker por consulta: o app passou a consultar um a um.');
          const resultados = [];
          for (const ticker of lote) {
            const individual = await consultar([ticker]);
            if (individual.resultados) resultados.push(...individual.resultados);
            else erros[ticker] = mensagemDeErro(individual.status);
          }
          retorno = { resultados };
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
          if (!dados[t] && !erros[t]) erros[t] = 'Sem retorno da API para este ticker.';
        });
      } catch (erro) {
        lote.forEach((t) => { erros[t] = motivoDeFalhaDeRede(erro); });
      }
    }

    return { dados, erros, avisos: [...avisos] };
  }

  return {
    buscarCotacoes, buscarPeloServidor, detectarServidor, diagnosticar, interpretar,
    somarProventos12m, normalizar, mensagemDeErro, motivoDeFalhaDeRede,
    buscarTickersParecidos,
    LOTE, BASE, ASSINATURA_SERVIDOR, TICKER_B3, LIVRES,
  };
});
