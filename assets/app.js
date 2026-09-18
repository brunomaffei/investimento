/** Interface: tabela editável, resumo, cotações automáticas e import/export. */
(function () {
  'use strict';

  const Calc = window.Calc;
  const { parseNumero, avaliarCarteira, avaliarAtivo } = Calc;
  const {
    buscarCotacoes, buscarPeloServidor, detectarServidor, diagnosticar, interpretar, TICKER_B3,
  } = window.Quotes;
  const { CONFIG_PADRAO, CARTEIRA_INICIAL } = window.Seed;

  const CHAVE_STORAGE = 'precoteto.v1';

  const el = (sel) => document.querySelector(sel);
  const novoId = () => `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

  // Precisa existir ANTES de carregar(): a função grava aqui o aviso, e carregar()
  // é chamada logo abaixo. Declarar depois fazia o app não abrir (ReferenceError)
  // justamente no caso que este aviso existe para tratar: dado salvo ilegível.
  let avisoDeCarregamento = null;

  let estado = carregar();

  // ---------------------------------------------------------------- persistência

  // Quando o dado salvo não pode ser lido, a carteira do usuário sumia e era
  // substituída pela lista de exemplo — que o primeiro salvamento gravava por cima.
  // Agora o original é preservado em outra chave e a tela avisa.
  function carregar() {
    let bruto = null;
    try {
      bruto = localStorage.getItem(CHAVE_STORAGE);
      const salvo = JSON.parse(bruto || 'null');
      if (salvo && Array.isArray(salvo.ativos)) {
        return {
          config: { ...CONFIG_PADRAO, ...(salvo.config || {}) },
          ativos: salvo.ativos.map((a) => ({ ...a, id: a.id || novoId() })),
        };
      }
      if (bruto) {
        avisoDeCarregamento = 'O que estava salvo não tinha a lista de ativos e foi guardado à parte; a carteira voltou ao exemplo inicial.';
        guardarCopiaDoEstadoIlegivel(bruto);
      }
    } catch (erro) {
      console.warn('Não foi possível ler os dados salvos:', erro);
      avisoDeCarregamento = `Os dados salvos no navegador estavam ilegíveis (${erro.message}). Eles foram guardados em uma cópia antes de a carteira voltar ao exemplo inicial.`;
      guardarCopiaDoEstadoIlegivel(bruto);
    }
    return {
      config: { ...CONFIG_PADRAO },
      ativos: CARTEIRA_INICIAL.map((a) => ({ ...a, id: novoId() })),
    };
  }

  /** Guarda o texto original para não perder a carteira de quem salvou. */
  function guardarCopiaDoEstadoIlegivel(bruto) {
    if (!bruto) return;
    try {
      localStorage.setItem(`${CHAVE_STORAGE}.ilegivel`, bruto);
    } catch (erro) {
      console.warn('Não foi possível guardar a cópia do estado ilegível:', erro);
    }
  }

  let jaAvisouFalhaAoSalvar = false;

  function salvar() {
    try {
      localStorage.setItem(CHAVE_STORAGE, JSON.stringify(estado));
      jaAvisouFalhaAoSalvar = false;
    } catch (erro) {
      console.warn('Não foi possível salvar:', erro);
      // Uma vez por falha, não a cada tecla: a tela mostrava os números como se
      // estivessem guardados e tudo sumia no recarregamento seguinte.
      if (!jaAvisouFalhaAoSalvar) {
        jaAvisouFalhaAoSalvar = true;
        status('O navegador não está guardando as alterações (memória cheia ou navegação privativa). Exporte em JSON para não perder o que você digitou.',
          'erro', [erro.message]);
      }
    }
  }

  // ------------------------------------------------------------------ formatação

  const nf = (min, max) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: min, maximumFractionDigits: max });
  const fmt2 = nf(2, 2);
  const fmt0 = nf(0, 0);

  const finito = (v) => typeof v === 'number' && Number.isFinite(v);
  const positivo = (v) => finito(v) && v > 0;

  const vazio = '<span class="vazio">—</span>';
  const fmtMoeda = (n) => (n === null || n === undefined || !Number.isFinite(n) ? vazio : `R$ ${fmt2.format(n)}`);
  const fmtPct = (n, casas = 2) => {
    if (n === null || !Number.isFinite(n)) return vazio;
    const sinal = n > 0 ? '+' : '';
    return `${sinal}${nf(casas, casas).format(n * 100)}%`;
  };
  const escapar = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtQuantidade(n) {
    if (n === null || !Number.isFinite(n)) return vazio;
    if (Math.abs(n) >= 1e9) return `${fmt2.format(n / 1e9)} bi`;
    if (Math.abs(n) >= 1e6) return `${fmt2.format(n / 1e6)} mi`;
    return fmt0.format(n);
  }

  function classeMargem(margem, veredito) {
    if (veredito === 'incompleto' || margem === null) return 'neutro';
    return margem >= 0 ? 'positivo' : 'negativo';
  }

  // ------------------------------------------------------------------ renderização

  const COLUNAS = [
    { chave: 'ticker', rotulo: 'Ticker', ordenavel: true },
    { chave: 'modo', rotulo: 'Base' },
    { chave: 'cotacao', rotulo: 'Cotação', ordenavel: true, num: true },
    // Só aparecem quando algum ativo é calculado a partir do lucro projetado.
    { chave: 'lucroProjetado', rotulo: 'Lucro projetado', num: true, soModoLucro: true },
    { chave: 'quantidadeAcoes', rotulo: 'Qtd. ações', num: true, soModoLucro: true },
    { chave: 'payout', rotulo: 'Payout (%)', num: true },
    { chave: 'yieldAceitavel', rotulo: 'Yield aceit. (%)', num: true },
    { chave: 'lpa', rotulo: 'LPA', ordenavel: true, num: true },
    { chave: 'dpa', rotulo: 'DPA', ordenavel: true, num: true },
    { chave: 'precoTeto', rotulo: 'Preço-teto', ordenavel: true, num: true },
    { chave: 'margem', rotulo: 'Margem de seg.', ordenavel: true, num: true, classe: 'col-margem' },
    { chave: 'veredito', rotulo: 'Comprar?', ordenavel: true, classe: 'col-veredito' },
  ];

  const usaModoLucro = () => estado.ativos.some((a) => (a.modo || 'lucro') === 'lucro');
  const colunasVisiveis = () => COLUNAS.filter((c) => !c.soModoLucro || usaModoLucro());

  /** Preço-teto com o preço de compra alvo embaixo, quando há margem mínima exigida. */
  function celulaTeto(m) {
    const margemMinima = parseNumero(estado.config.margemMinima) || 0;
    const alvo = margemMinima > 0 && m.precoAlvo !== null
      ? `<span class="sub">pagar até ${fmtMoeda(m.precoAlvo)}</span>`
      : '';
    return `${fmtMoeda(m.precoTeto)}${alvo}`;
  }

  function ordenar(linhas) {
    const { ordenarPor, ordemDecrescente } = estado.config;
    const valor = ({ ativo, metricas }) => {
      if (ordenarPor === 'ticker') return (ativo.ticker || '').toUpperCase();
      if (ordenarPor === 'veredito') return { sim: 2, nao: 1, incompleto: 0 }[metricas.veredito];
      const m = metricas[ordenarPor];
      return typeof m === 'number' && Number.isFinite(m) ? m : null;
    };
    return [...linhas].sort((a, b) => {
      const va = valor(a);
      const vb = valor(b);
      // Linhas sem dado vão sempre para o fim, independente da direção da ordenação.
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      const cmp = typeof va === 'string' ? va.localeCompare(vb, 'pt-BR') : va - vb;
      return ordemDecrescente ? -cmp : cmp;
    });
  }

  function filtrar(linhas) {
    const busca = (estado.config.busca || '').trim().toLowerCase();
    return linhas.filter(({ ativo, metricas }) => {
      if (estado.config.somenteComprar && metricas.veredito !== 'sim') return false;
      if (!busca) return true;
      return [ativo.ticker, ativo.nome, ativo.setor].some((c) => String(c || '').toLowerCase().includes(busca));
    });
  }

  function inputCelula(ativo, campo, extra = '') {
    return `<input class="cel-input" data-id="${ativo.id}" data-campo="${campo}" value="${escapar(ativo[campo] ?? '')}" ${extra}>`;
  }

  function celulasPremissas(ativo, m) {
    const modo = m.modo;
    const lucro = modo === 'lucro' ? inputCelula(ativo, 'lucroProjetado', 'placeholder="ex.: 5,1 bi"') : vazio;
    const qtd = modo === 'lucro' ? inputCelula(ativo, 'quantidadeAcoes', 'placeholder="ex.: 3 bi"') : vazio;
    // O cinza precisa ser o número que a conta usaria se a célula ficasse vazia:
    // mostrar o de mercado enquanto calc.js usa o padrão da carteira fazia a linha
    // exibir um payout e calcular com outro.
    const payoutPadrao = parseNumero(estado.config.payoutPadrao);
    const sugestaoPayout = payoutPadrao !== null
      ? fmt0.format(payoutPadrao)
      : m.payoutDeMercado !== null
        ? fmt0.format(m.payoutDeMercado)
        : 'ex.: 70';
    const notaPayout = m.origemPayout === 'mercado'
      ? `<span class="sub" title="Payout dos últimos 12 meses: dividendo pago ÷ LPA. Preencha o campo para usar sua própria premissa.">12m: ${fmt0.format(m.payoutDeMercado)}%</span>`
      : '';
    const payout = modo === 'dividendo'
      ? `<span data-saida="payoutImplicito">${m.payoutImplicito !== null ? `${fmt2.format(m.payoutImplicito)}%` : vazio}</span>`
      : `${inputCelula(ativo, 'payout', `placeholder="${escapar(sugestaoPayout)}"`)}${notaPayout}`;
    const lpa = modo === 'lpa'
      ? inputCelula(ativo, 'lpaInformado', 'placeholder="ex.: 3,67"')
      : `<span data-saida="lpa">${fmtMoeda(m.lpa)}</span>`;
    const notaProventos = m.dpaDeMercado !== null
      ? `<span class="sub" title="Proventos dos últimos 12 meses${ativo.fonteProventos ? ` (${ativo.fonteProventos})` : ''} e o yield que isso dá no preço de hoje. Yield muito baixo costuma indicar histórico incompleto na fonte.">12m ${fmtMoeda(m.dpaDeMercado)}${m.yieldDeMercado !== null ? ` · ${fmtPct(m.yieldDeMercado, 1).replace('+', '')}` : ''}</span>`
      : '';
    const dpa = modo === 'dividendo'
      ? `${inputCelula(ativo, 'dpaInformado', 'placeholder="ex.: 2,57"')}${notaProventos}`
      : `<span data-saida="dpa">${fmtMoeda(m.dpa)}</span>${notaProventos}`;
    return { lucro, qtd, payout, lpa, dpa };
  }

  function badgeVeredito(m) {
    if (m.veredito === 'sim') return '<span class="badge sim">SIM</span>';
    if (m.veredito === 'nao') return '<span class="badge nao">NÃO</span>';
    // Dizer QUAL premissa falta poupa o usuário de caçar a célula vazia.
    const resumo = m.faltando.length > 2 ? `${m.faltando.slice(0, 2).join(' + ')}…` : m.faltando.join(' + ');
    return `<span class="badge falta" title="Falta preencher: ${escapar(m.faltando.join(', '))}">falta ${escapar(resumo)}</span>`;
  }

  function linhaHtml({ ativo, metricas: m }) {
    const p = celulasPremissas(ativo, m);
    const celulasLucro = usaModoLucro()
      ? `<td data-rotulo="Lucro projetado" class="num">${p.lucro}</td>
        <td data-rotulo="Qtd. ações" class="num">${p.qtd}</td>`
      : '';
    const origem = ativo.erroAtualizacao
      ? `<span class="tag erro" title="${escapar(ativo.erroAtualizacao)}">erro</span>`
      : ativo.cotacaoAtualizadaEm
        ? `<span class="tag" title="Atualizado em ${new Date(ativo.cotacaoAtualizadaEm).toLocaleString('pt-BR')}">auto</span>`
        : '';
    return `
      <tr data-id="${ativo.id}">
        <td class="col-ticker">
          <div class="linha-ticker">
            <input class="cel-input ticker" data-id="${ativo.id}" data-campo="ticker" value="${escapar(ativo.ticker ?? '')}" placeholder="TICKER">
            <button class="remover" data-remover="${ativo.id}" title="Remover ativo" aria-label="Remover ativo">✕</button>
          </div>
          <span class="sub">${escapar(ativo.setor || ativo.nome || '')}</span>
        </td>
        <td data-rotulo="Base do cálculo">
          <select class="cel-input" data-id="${ativo.id}" data-campo="modo">
            <option value="lucro"${m.modo === 'lucro' ? ' selected' : ''}>Lucro proj.</option>
            <option value="lpa"${m.modo === 'lpa' ? ' selected' : ''}>LPA direto</option>
            <option value="dividendo"${m.modo === 'dividendo' ? ' selected' : ''}>Dividendo</option>
          </select>
        </td>
        <td data-rotulo="Cotação atual" class="num">${inputCelula(ativo, 'cotacao', 'placeholder="ex.: 30,50"')}${origem}</td>
        ${celulasLucro}
        <td data-rotulo="Payout (%)" class="num">${p.payout}</td>
        <td data-rotulo="Yield aceitável (%)" class="num">${inputCelula(ativo, 'yieldAceitavel', `placeholder="${fmt0.format(m.yieldAceitavel)}"`)}${
          m.yieldSuspeito
            ? '<span class="sub alerta" title="Yield fora do razoável. 6% se escreve 6, não 0,06 — com 0,06 o preço-teto sai 100 vezes maior e tudo vira SIM.">confira: % inteiro</span>'
            : m.yieldDoFallback
              ? '<span class="sub" title="Sem yield na linha e sem padrão na configuração: vale o corte clássico de 6% do método Bazin.">padrão 6%</span>'
              : ''
        }</td>
        <td data-rotulo="LPA" class="num">${p.lpa}</td>
        <td data-rotulo="DPA" class="num">${p.dpa}</td>
        <td data-rotulo="Preço-teto" class="num forte" data-saida="precoTeto">${celulaTeto(m)}</td>
        <td data-rotulo="Margem de segurança" class="num forte col-margem ${classeMargem(m.margem, m.veredito)}" data-saida="margem">${fmtPct(m.margem)}</td>
        <td data-rotulo="Comprar?" class="col-veredito" data-saida="veredito">${badgeVeredito(m)}</td>
      </tr>`;
  }

  function cabecalhoHtml() {
    const { ordenarPor, ordemDecrescente } = estado.config;
    return colunasVisiveis().map((c) => {
      const base = `${c.num ? 'num ' : ''}${c.classe || ''}`;
      if (!c.ordenavel) return `<th class="${base}">${c.rotulo}</th>`;
      const ativa = ordenarPor === c.chave;
      const seta = ativa ? (ordemDecrescente ? ' ↓' : ' ↑') : ' ⇅';
      return `<th class="${base} ordenavel${ativa ? ' ativa' : ''}" data-ordenar="${c.chave}">${c.rotulo}<span class="seta">${seta}</span></th>`;
    }).join('');
  }

  function render() {
    const { linhas, resumo } = avaliarCarteira(estado.ativos, estado.config);
    const visiveis = ordenar(filtrar(linhas));

    el('#resumo').innerHTML = `
      <div class="card"><span class="rotulo">Ativos acompanhados</span><strong>${resumo.total}</strong></div>
      <div class="card ok"><span class="rotulo">Dentro do preço-teto</span><strong>${resumo.comprar}</strong></div>
      <div class="card ruim"><span class="rotulo">Acima do teto (esperar)</span><strong>${resumo.aguardar}</strong></div>
      <div class="card"><span class="rotulo">Melhor margem</span><strong>${resumo.melhorMargem === null ? '—' : fmtPct(resumo.melhorMargem)}</strong></div>
      <div class="card alerta"><span class="rotulo">Premissas faltando</span><strong>${resumo.incompletos}</strong></div>`;

    el('#tabela thead tr').innerHTML = cabecalhoHtml();
    el('#tabela tbody').innerHTML = visiveis.length
      ? visiveis.map(linhaHtml).join('')
      : `<tr class="vazia"><td colspan="${colunasVisiveis().length}">Nenhum ativo para mostrar. Ajuste o filtro ou clique em “+ Ativo”.</td></tr>`;

    el('#contagem').textContent = `${visiveis.length} de ${resumo.total} ativo(s)`;
    // O rastreador mostra quem já está na carteira: tirar uma linha aqui muda lá.
    if (universo) renderRastreador();
    // Premissa alterada muda o DPA, e o DPA é a renda da posição.
    renderMinhaCarteira();
    salvar();
  }

  /** Atualiza só as células calculadas de uma linha — mantém o foco de quem digita. */
  function atualizarLinha(id) {
    // Escopo obrigatório: a tabela de posições usa os MESMOS data-id, e um
    // querySelector solto pegava a linha errada — a célula certa nunca era escrita.
    const tr = document.querySelector(`#tabela tbody tr[data-id="${id}"]`);
    const ativo = estado.ativos.find((a) => a.id === id);
    if (!tr || !ativo) return;
    const m = avaliarAtivo(ativo, estado.config);

    const escrever = (saida, html) => {
      const alvo = tr.querySelector(`[data-saida="${saida}"]`);
      if (alvo) alvo.innerHTML = html;
    };
    if (m.modo !== 'lpa') escrever('lpa', fmtMoeda(m.lpa));
    if (m.modo !== 'dividendo') escrever('dpa', fmtMoeda(m.dpa));
    if (m.modo === 'dividendo') escrever('payoutImplicito', m.payoutImplicito !== null ? `${fmt2.format(m.payoutImplicito)}%` : vazio);
    escrever('precoTeto', celulaTeto(m));
    escrever('margem', fmtPct(m.margem));
    escrever('veredito', badgeVeredito(m));

    const celMargem = tr.querySelector('[data-saida="margem"]');
    if (celMargem) celMargem.className = `num forte col-margem ${classeMargem(m.margem, m.veredito)}`;

    atualizarResumo();
    // Só a linha equivalente, não a tabela inteira: reconstruir a cada tecla fazia
    // a digitação engasgar em carteira grande (e roubava o foco de quem digitava).
    atualizarLinhaPosicao(id);
    salvar();
  }

  function atualizarResumo() {
    const { resumo } = avaliarCarteira(estado.ativos, estado.config);
    const cards = document.querySelectorAll('#resumo .card strong');
    if (cards.length < 5) return;
    cards[1].textContent = resumo.comprar;
    cards[2].textContent = resumo.aguardar;
    cards[3].innerHTML = resumo.melhorMargem === null ? '—' : fmtPct(resumo.melhorMargem);
    cards[4].textContent = resumo.incompletos;
  }

  // ------------------------------------------------------------------ cotações

  // Detecta uma única vez se o app está sendo servido por tools/servidor.mjs.
  let servidorDetectado = null;
  async function servidor() {
    if (servidorDetectado === null) servidorDetectado = await detectarServidor({});
    return servidorDetectado;
  }

  /**
   * Consulta pelo servidor local quando ele existe e, se ele não trouxer nada,
   * tenta direto do navegador — que funciona quando a página vem de http://localhost.
   */
  async function consultar(tickers, fundamentos) {
    const local = await servidor();
    const token = estado.config.token;

    if (local.disponivel) {
      // Se o servidor subiu sem BRAPI_TOKEN, repassa o token digitado na tela.
      const resultado = await buscarPeloServidor(tickers, {
        fundamentos,
        token: local.comToken ? '' : token,
      });
      if (Object.keys(resultado.dados).length) {
        return { ...resultado, via: ' (via servidor local)' };
      }

      const direto = await buscarCotacoes(tickers, { token, fundamentos });
      if (Object.keys(direto.dados).length) {
        return {
          ...direto,
          avisos: [...(direto.avisos || []), 'O servidor local não trouxe dados; a consulta saiu direto do navegador.'],
          via: ' (direto do navegador)',
        };
      }
      return { ...resultado, via: ' (via servidor local)' };
    }

    const direto = await buscarCotacoes(tickers, { token, fundamentos });
    return { ...direto, via: '' };
  }

  async function atualizarCotacoes() {
    const botao = el('#btn-cotacoes');
    const tickers = estado.ativos.map((a) => String(a.ticker || '').trim().toUpperCase()).filter((t) => TICKER_B3.test(t));
    if (!tickers.length) {
      status('Nenhum ticker da B3 reconhecido na lista (formato esperado: PETR4, TAEE11).', 'alerta');
      return;
    }

    botao.disabled = true;
    botao.textContent = 'Buscando…';
    status(`Consultando ${tickers.length} ticker(s) na brapi.dev…`);

    try {
      const fundamentos = !!estado.config.fundamentos;
      const { dados, erros, avisos, via: caminho } = await consultar(tickers, fundamentos);
      let atualizados = 0;
      let comFundamentosDaBolsai = 0;
      estado.ativos.forEach((ativo) => {
        const chave = String(ativo.ticker || '').toUpperCase();
        const info = dados[chave];
        // O resultado por ativo fica na própria linha: é onde o usuário olha.
        if (erros[chave]) ativo.erroAtualizacao = erros[chave];
        else if (info) delete ativo.erroAtualizacao;
        if (!info) return;
        // Resposta sem nada aproveitável era contada como sucesso: o app anunciava
        // "atualizado" e a cotação na tela continuava a mesma, sem explicação.
        if (!positivo(info.preco) && !finito(info.lpa) && !positivo(info.dpa12m)) {
          ativo.erroAtualizacao = 'A fonte respondeu sem preço para este ticker.';
          erros[chave] = erros[chave] || ativo.erroAtualizacao;
          return;
        }
        atualizados++;
        // A resposta vem de fora (API ou servidor): nunca escrever "0,00"/"NaN" por
        // causa de um campo ausente ou de tipo inesperado.
        if (positivo(info.preco)) {
          ativo.cotacao = fmt2.format(info.preco);
          ativo.cotacaoAtualizadaEm = typeof info.atualizadoEm === 'string' ? info.atualizadoEm : new Date().toISOString();
        }
        if (typeof info.nome === 'string' && info.nome && !ativo.nome) ativo.nome = info.nome;
        if (typeof info.setor === 'string' && info.setor && !ativo.setor) ativo.setor = info.setor;
        // LPA e DPA só entram se o campo ainda estiver vazio: premissa sua nunca é sobrescrita.
        // Campo vazio OU preenchido pela própria busca: o que o usuário digitou nunca
        // é tocado. Sem a marca de origem, o primeiro LPA buscado congelava para
        // sempre — a cotação atualizava, o fundamento não, e a margem escorregava.
        const podeEscrever = (campo, marca) => !String(ativo[campo] || '').trim() || ativo[marca];
        if (finito(info.lpa) && ativo.modo === 'lpa' && podeEscrever('lpaInformado', 'lpaAutomatico')) {
          ativo.lpaInformado = fmt2.format(info.lpa);
          ativo.lpaAutomatico = true;
        }
        // Guardar o provento pago vale para todos os modos: no modo dividendo ele
        // preenche o campo; nos demais, vira payout implícito e número de conferência.
        if (positivo(info.dpa12m)) {
          ativo.dpa12mMercado = info.dpa12m;
          ativo.fonteProventos = info.fonteProventos || null;
          if (ativo.modo === 'dividendo' && podeEscrever('dpaInformado', 'dpaAutomatico')) {
            ativo.dpaInformado = fmt2.format(info.dpa12m);
            ativo.dpaAutomatico = true;
          }
        }
        if (info.fonteFundamentos === 'bolsai' && (finito(info.lpa) || positivo(info.dpa12m))) {
          comFundamentosDaBolsai++;
        }
      });

      render();
      const listaErros = Object.entries(erros);
      const detalhes = [...(avisos || [])];
      if (comFundamentosDaBolsai) detalhes.push(`LPA e proventos de ${comFundamentosDaBolsai} ativo(s) vieram da bolsai.`);
      listaErros.forEach(([ticker, motivo]) => detalhes.push(`${ticker}: ${motivo}`));

      const quando = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      // Verde quando todo mundo atualizou: aviso sobre limite de plano ou fonte
      // usada é informação, não falha — pintar tudo de laranja parecia erro.
      const houveFalha = listaErros.length > 0;
      const resumo = houveFalha
        ? `${atualizados} de ${atualizados + listaErros.length} ativos atualizados às ${quando}${caminho}.`
        : `${atualizados} ativo(s) atualizados às ${quando}${caminho}.`;
      status(resumo, houveFalha ? 'alerta' : 'ok', detalhes);
    } catch (erro) {
      status(`Não foi possível buscar cotações: ${erro.message}. Digite os preços à mão.`, 'erro');
    } finally {
      botao.disabled = false;
      botao.textContent = '↻ Atualizar cotações';
    }
  }

  async function rodarDiagnostico() {
    const botao = el('#btn-diagnostico');
    const painel = el('#diagnostico');
    botao.disabled = true;
    botao.textContent = 'Testando…';
    painel.hidden = false;
    painel.innerHTML = '<p class="rodando">Testando a conexão com a brapi…</p>';

    try {
      const tickers = estado.ativos.map((a) => a.ticker);
      const etapas = await diagnosticar({ token: estado.config.token, tickers });
      const linhas = etapas.map((e) => {
        const marca = e.ok ? '✅' : e.bloqueado ? '🚫' : '❌';
        const detalhe = e.ok
          ? [e.preco !== null && e.preco !== undefined ? `preço R$ ${fmt2.format(e.preco)}` : null,
             e.lpa !== null && e.lpa !== undefined ? `LPA ${fmt2.format(e.lpa)}` : null]
            .filter(Boolean).join(', ') || 'respondeu sem dados'
          : `${e.status ? `HTTP ${e.status}` : 'sem resposta'} — ${escapar(e.detalhe || '')}`;
        return `<li>${marca} <strong>${escapar(e.rotulo)}</strong>: ${detalhe} <span class="ms">${e.ms} ms</span></li>`;
      });
      const versao = etapas.find((e) => e.versao)?.versao;
      painel.innerHTML = `
        <h2>Diagnóstico da conexão${versao?.sha ? ` <span class="versao">código ${escapar(versao.sha)}${versao.branch ? ` · ${escapar(versao.branch)}` : ''}</span>` : ''}</h2>
        <ul>${linhas.join('')}</ul>
        <p class="conclusao">${escapar(interpretar(etapas))}</p>
        ${estado.config.token ? '' : '<p class="dica">Sem token, só o teste de rede roda. Cole o token para testar a autenticação.</p>'}`;
    } catch (erro) {
      painel.innerHTML = `<p class="conclusao">Não foi possível rodar o diagnóstico: ${escapar(erro.message)}</p>`;
    } finally {
      botao.disabled = false;
      botao.textContent = '🔌 Testar conexão';
    }
  }

  /**
   * Mensagem de status. Os detalhes (limite de plano, fonte usada, ticker que
   * falhou) ficam recolhidos: em linha, viravam um parágrafo que parecia erro.
   * @param {string} texto resumo curto
   * @param {string} [tipo] 'ok' | 'alerta' | 'erro'
   * @param {string[]} [detalhes]
   * @param {string} [seletor] onde escrever ('#status' da carteira ou '#r-status' do rastreador)
   */
  function status(texto, tipo = '', detalhes = [], seletor = '#status') {
    const alvo = el(seletor);
    const lista = (detalhes || []).filter(Boolean);
    alvo.className = `status ${tipo}`;
    alvo.innerHTML = lista.length
      ? `${escapar(texto)} <button type="button" class="ver-detalhes" aria-expanded="false">${lista.length} aviso${lista.length > 1 ? 's' : ''}</button>
         <ul class="detalhes" hidden>${lista.map((d) => `<li>${escapar(d)}</li>`).join('')}</ul>`
      : escapar(texto);
  }

  // ------------------------------------------------------------------ rastreador

  const { rastrear: rastrearMercado } = window.Rastreador;

  // Universo = mercado inteiro vindo do servidor local. Fica em memória: filtrar e
  // reordenar não pode custar uma nova requisição.
  let universo = null;
  let buscandoUniverso = false;

  const filtros = () => ({ ...CONFIG_PADRAO.rastreador, ...(estado.config.rastreador || {}) });

  function salvarFiltro(mudanca) {
    estado.config.rastreador = { ...filtros(), ...mudanca };
    salvar();
  }

  const COLUNAS_RASTREADOR = [
    { chave: 'ticker', rotulo: 'Ticker', ordenavel: true },
    { chave: 'cotacao', rotulo: 'Cotação', ordenavel: true, num: true },
    { chave: 'dy', rotulo: 'DY 12m', ordenavel: true, num: true },
    { chave: 'dpa', rotulo: 'Provento 12m', ordenavel: true, num: true },
    { chave: 'precoTeto', rotulo: 'Preço-teto', ordenavel: true, num: true },
    { chave: 'margem', rotulo: 'Margem de seg.', ordenavel: true, num: true, classe: 'col-margem' },
    { chave: 'veredito', rotulo: 'Comprar?', classe: 'col-veredito' },
    { chave: 'pvp', rotulo: 'P/VP', ordenavel: true, num: true },
    { chave: 'liquidez', rotulo: 'Liquidez/dia', ordenavel: true, num: true },
    { chave: 'acao', rotulo: '' },
  ];

  function cabecalhoRastreador() {
    const { ordenarPor, decrescente } = filtros();
    return COLUNAS_RASTREADOR.map((c) => {
      const base = `${c.num ? 'num ' : ''}${c.classe || ''}`;
      if (!c.ordenavel) return `<th class="${base}">${c.rotulo}</th>`;
      const ativa = ordenarPor === c.chave;
      const seta = ativa ? (decrescente ? ' ↓' : ' ↑') : ' ⇅';
      return `<th class="${base} ordenavel${ativa ? ' ativa' : ''}" data-ordenar="${c.chave}">${c.rotulo}<span class="seta">${seta}</span></th>`;
    }).join('');
  }

  const naCarteira = (ticker) => estado.ativos.some((a) => String(a.ticker || '').toUpperCase() === ticker);

  function linhaRastreador({ item, metricas: m, alertas }) {
    const aviso = alertas.length
      ? `<span class="tag alerta" title="${escapar(alertas.join(' · '))}">!</span>`
      : '';
    const jaTem = naCarteira(item.ticker);
    return `
      <tr data-ticker="${escapar(item.ticker)}">
        <td class="col-ticker">
          <strong>${escapar(item.ticker)}</strong>${aviso}
          <span class="sub">${escapar(item.segmento || (item.tipo === 'fii' ? 'FII' : 'Ação'))}</span>
        </td>
        <td data-rotulo="Cotação" class="num">${fmtMoeda(m.cotacao)}</td>
        <td data-rotulo="DY 12m" class="num">${item.dy === null ? vazio : `${fmt2.format(item.dy)}%`}</td>
        <td data-rotulo="Provento 12m" class="num">${fmtMoeda(m.dpa)}</td>
        <td data-rotulo="Preço-teto" class="num forte">${fmtMoeda(m.precoTeto)}</td>
        <td data-rotulo="Margem de segurança" class="num forte col-margem ${classeMargem(m.margem, m.veredito)}">${fmtPct(m.margem)}</td>
        <td data-rotulo="Comprar?" class="col-veredito">${badgeVeredito(m)}</td>
        <td data-rotulo="P/VP" class="num">${item.pvp === null ? vazio : fmt2.format(item.pvp)}</td>
        <td data-rotulo="Liquidez por dia" class="num">${item.liquidez === null ? vazio : `R$ ${fmtQuantidade(item.liquidez)}`}</td>
        <td class="col-acao">
          <button class="adicionar" data-adicionar="${escapar(item.ticker)}"${jaTem ? ' disabled title="Já está na sua carteira"' : ''}>${jaTem ? 'na carteira' : '+ carteira'}</button>
        </td>
      </tr>`;
  }

  function renderRastreador() {
    if (!universo) return;
    const f = filtros();
    const { visiveis, resumo } = rastrearMercado(universo.ativos, estado.config, {
      ...f,
      limite: Number(f.limite) === 0 ? null : Number(f.limite),
    });

    el('#tabela-rastreador thead tr').innerHTML = cabecalhoRastreador();
    el('#tabela-rastreador tbody').innerHTML = visiveis.length
      ? visiveis.map(linhaRastreador).join('')
      : `<tr class="vazia"><td colspan="${COLUNAS_RASTREADOR.length}">Nenhum papel passou nos filtros. Afrouxe a liquidez mínima ou desmarque “só os que estão abaixo do teto”.</td></tr>`;

    const melhor = resumo.melhorMargem === null ? '—' : fmtPct(resumo.melhorMargem);
    el('#r-contagem').innerHTML = `Mostrando <strong>${resumo.mostrados}</strong> de ${resumo.filtrados} papéis filtrados · ${resumo.comprar} abaixo do teto · melhor margem ${melhor} · universo de ${resumo.universo} (${resumo.acoes} ações + ${resumo.fiis} FIIs)`;
  }

  function descreverFonte() {
    if (!universo) return '';
    const quando = new Date(universo.atualizadoEm);
    const idade = universo.idadeMinutos;
    const quandoTexto = Number.isFinite(quando.getTime())
      ? quando.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      : 'agora';
    return `Dados de ${quandoTexto}${idade > 0 ? ` (${idade} min atrás)` : ''}.`;
  }

  /**
   * Traz o mercado inteiro pelo servidor local. Sem servidor não há como: a página
   * publicada não consegue ler o Fundamentus por causa do CORS do navegador.
   * @param {boolean} forcar ignora o cache do servidor
   */
  async function carregarUniverso(forcar = false) {
    if (buscandoUniverso) return;
    const local = await servidor();
    if (!local.disponivel || !local.comUniverso) {
      status(
        local.disponivel
          ? 'Este servidor local é de uma versão anterior, sem o rastreador. Pare e rode de novo: node tools/servidor.mjs'
          : 'O rastreador precisa do servidor local (é ele que lê a fonte dos dados). No terminal, dentro da pasta do projeto: npm start — depois abra http://localhost:8787',
        'alerta', [], '#r-status',
      );
      return;
    }

    buscandoUniverso = true;
    const botao = el('#btn-rastrear-recarregar');
    botao.disabled = true;
    status(forcar ? 'Buscando a bolsa inteira na fonte…' : 'Carregando a bolsa inteira…', '', [], '#r-status');
    try {
      const resposta = await fetch(`/api/universo${forcar ? '?forcar=1' : ''}`, { headers: { Accept: 'application/json' } });
      const corpo = await resposta.json().catch(() => null);
      if (!resposta.ok || !corpo || !Array.isArray(corpo.ativos)) {
        throw new Error(corpo?.erro || `o servidor respondeu HTTP ${resposta.status}`);
      }
      universo = corpo;
      el('#universo-info').textContent = descreverFonte();
      renderRastreador();
      const detalhes = [...(corpo.erros || [])];
      if (corpo.doCache) detalhes.push('Dados guardados no servidor; use “Recarregar” para buscar de novo na fonte.');
      status(`${corpo.ativos.length} papéis calculados.`, corpo.erros?.length ? 'alerta' : 'ok', detalhes, '#r-status');
    } catch (erro) {
      status(`Não foi possível carregar a bolsa: ${erro.message}`, 'erro', [], '#r-status');
    } finally {
      buscandoUniverso = false;
      botao.disabled = false;
    }
  }

  function abrirRastreador(abrir) {
    estado.config.rastreadorAberto = abrir;
    el('#rastreador').hidden = !abrir;
    salvar();
    if (abrir && !universo) carregarUniverso(false);
    else if (abrir) renderRastreador();
  }

  /** Leva um papel do rastreador para a carteira, já no modo dividendo. */
  function adicionarDoRastreador(ticker) {
    if (!universo || naCarteira(ticker)) return;
    const item = universo.ativos.find((a) => a.ticker === ticker);
    if (!item) return;
    estado.ativos.unshift({
      id: novoId(),
      ticker,
      modo: 'dividendo',
      setor: item.segmento || (item.tipo === 'fii' ? 'FII' : ''),
      cotacao: item.cotacao === null ? '' : fmt2.format(item.cotacao),
      dpaInformado: item.dpa12m === null ? '' : fmt2.format(item.dpa12m),
      dpa12mMercado: item.dpa12m,
      fonteProventos: 'fundamentus',
    });
    render();
    renderRastreador();
    status(`${ticker} entrou na carteira com o provento de 12 meses já preenchido. Ajuste a premissa se quiser projetar outro dividendo.`, 'ok');
  }

  function exportarRastreadorCsv() {
    if (!universo) return;
    const f = filtros();
    const { visiveis } = rastrearMercado(universo.ativos, estado.config, { ...f, limite: null });
    const dec = (n) => (n === null || n === undefined || !Number.isFinite(n) ? '' : String(n).replace('.', ','));
    const cabecalho = ['Ticker', 'Tipo', 'Segmento', 'Cotacao', 'DY 12m (%)', 'Provento 12m', 'Preco-teto', 'Preco de compra', 'Margem (%)', 'Comprar', 'P/VP', 'Liquidez'];
    const corpo = visiveis.map(({ item, metricas: m }) => [
      item.ticker, item.tipo === 'fii' ? 'FII' : 'Acao', item.segmento || '',
      dec(m.cotacao), dec(item.dy), dec(m.dpa), dec(m.precoTeto), dec(m.precoAlvo),
      dec(m.margem === null ? null : m.margem * 100),
      { sim: 'SIM', nao: 'NAO', incompleto: 'FALTA DADO' }[m.veredito],
      dec(item.pvp), dec(item.liquidez),
    ]);
    const csv = [cabecalho, ...corpo].map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n');
    baixar(`rastreador-b3-${hoje()}.csv`, `\ufeff${csv}`, 'text/csv;charset=utf-8');
    status(`${corpo.length} papéis exportados.`, 'ok', [], '#r-status');
  }

  function ligarEventosDoRastreador() {
    el('#btn-rastrear').addEventListener('click', () => abrirRastreador(el('#rastreador').hidden));
    el('#btn-rastrear-fechar').addEventListener('click', () => abrirRastreador(false));
    el('#btn-rastrear-recarregar').addEventListener('click', () => carregarUniverso(true));
    el('#btn-rastrear-csv').addEventListener('click', exportarRastreadorCsv);

    el('#tabela-rastreador thead').addEventListener('click', (evento) => {
      const th = evento.target.closest('[data-ordenar]');
      if (!th) return;
      const f = filtros();
      salvarFiltro(f.ordenarPor === th.dataset.ordenar
        ? { decrescente: !f.decrescente }
        : { ordenarPor: th.dataset.ordenar, decrescente: true });
      renderRastreador();
    });

    el('#tabela-rastreador tbody').addEventListener('click', (evento) => {
      const botao = evento.target.closest('[data-adicionar]');
      if (botao) adicionarDoRastreador(botao.dataset.adicionar);
    });

    el('#r-status').addEventListener('click', (evento) => {
      const botao = evento.target.closest('.ver-detalhes');
      if (!botao) return;
      const lista = el('#r-status .detalhes');
      const aberto = !lista.hidden;
      lista.hidden = aberto;
      botao.setAttribute('aria-expanded', String(!aberto));
    });

    const campos = [
      ['#r-tipo', 'change', (e) => ({ tipo: e.target.value })],
      ['#r-limite', 'change', (e) => ({ limite: Number(e.target.value) })],
      ['#r-liquidez', 'input', (e) => ({ liquidezMinima: e.target.value })],
      ['#r-busca', 'input', (e) => ({ busca: e.target.value })],
      ['#r-so-sim', 'change', (e) => ({ somenteSim: e.target.checked })],
      ['#r-sem-provento', 'change', (e) => ({ ocultarSemProvento: !e.target.checked })],
    ];
    campos.forEach(([sel, evt, ler]) => el(sel).addEventListener(evt, (evento) => {
      salvarFiltro(ler(evento));
      renderRastreador();
    }));
  }

  function sincronizarRastreador() {
    const f = filtros();
    el('#r-tipo').value = f.tipo;
    el('#r-limite').value = String(f.limite);
    el('#r-liquidez').value = f.liquidezMinima ?? '';
    el('#r-busca').value = f.busca ?? '';
    el('#r-so-sim').checked = !!f.somenteSim;
    el('#r-sem-provento').checked = !f.ocultarSemProvento;
    el('#rastreador').hidden = estado.config.rastreadorAberto === false;
  }

  // ------------------------------------------------------------------ minha carteira

  const { projetar, porAno } = window.Projecao;
  const Graficos = window.Graficos;

  // Yield não tem sinal: fmtPct põe "+" e o "+8,5%" num yield sugere variação.
  const fmtTaxa = (fracao, casas = 2) => (fracao === null || !Number.isFinite(fracao)
    ? vazio
    : `${nf(casas, casas).format(fracao * 100)}%`);

  const opcoesDaProjecao = () => ({ ...CONFIG_PADRAO.projecao, ...(estado.config.projecao || {}) });

  function salvarProjecao(mudanca) {
    estado.config.projecao = { ...opcoesDaProjecao(), ...mudanca };
    salvar();
  }

  const COLUNAS_POSICAO = [
    { rotulo: 'Ticker' },
    { rotulo: 'Qtd. que tenho', num: true },
    { rotulo: 'Preço médio', num: true },
    { rotulo: 'Valor hoje', num: true },
    { rotulo: 'Resultado', num: true },
    { rotulo: 'Renda média/mês', num: true },
    { rotulo: 'Yield s/ custo', num: true },
  ];
  const COLUNA_SIMULACAO = { rotulo: 'Simular ±', num: true };

  const simulando = () => !!estado.config.simulando;
  const colunasDaPosicao = () => (simulando() ? [...COLUNAS_POSICAO, COLUNA_SIMULACAO] : COLUNAS_POSICAO);

  /** Verde/vermelho aqui significam ganho/perda — nunca "abaixo/acima do teto". */
  const classeResultado = (v) => (v === null || !Number.isFinite(v) ? 'neutro' : v >= 0 ? 'positivo' : 'negativo');

  function celulaResultado(m) {
    if (m.resultado === null) {
      return m.posicaoIncompleta && m.precoMedio === null
        ? `<span class="sub" title="Informe o preço médio para o app calcular ganho ou perda.">falta preço médio</span>`
        : vazio;
    }
    return `${fmtMoeda(m.resultado)}<span class="sub">${fmtPct(m.resultadoPct)}</span>`;
  }

  /**
   * Texto que o parseNumero não entende ("300 ações") não pode passar por campo
   * vazio: a linha ficaria sem renda e sem ninguém explicar por quê.
   */
  function avisoDeNumero(ativo, campo) {
    const cru = String(ativo[campo] ?? '').trim();
    if (!cru) return '';
    const numero = parseNumero(cru);
    if (numero === null) {
      return '<span class="tag alerta" title="Não entendi esse número. Escreva só o número, ex.: 300 ou 28,40.">?</span>';
    }
    // Zero ou negativo apagava a posição inteira em silêncio.
    if (numero <= 0) {
      return '<span class="tag alerta" title="Precisa ser maior que zero. Para registrar que vendeu tudo, apague o campo.">?</span>';
    }
    return '';
  }

  function linhaPosicaoHtml({ ativo, metricas: m }) {
    const alerta = (campo) => `<span data-aviso="${campo}">${avisoDeNumero(ativo, campo)}</span>`;
    const simulacao = simulando()
      ? `<td data-rotulo="Simular ±" class="num">${inputCelula(ativo, 'simulacaoQtd', 'placeholder="ex.: 300"')}</td>`
      : '';
    return `
      <tr data-id="${ativo.id}">
        <td class="col-ticker"><strong>${escapar(ativo.ticker || '—')}</strong><span class="sub">${escapar(ativo.setor || ativo.nome || '')}</span></td>
        <td data-rotulo="Quantidade" class="num">${inputCelula(ativo, 'quantidade', 'placeholder="ex.: 300"')}${alerta('quantidade')}</td>
        <td data-rotulo="Preço médio" class="num">${inputCelula(ativo, 'precoMedio', 'placeholder="ex.: 28,40"')}${alerta('precoMedio')}</td>
        <td data-rotulo="Valor hoje" class="num forte" data-saida="valorAtual">${fmtMoeda(m.valorAtual)}</td>
        <td data-rotulo="Resultado" class="num ${classeResultado(m.resultado)}" data-saida="resultado">${celulaResultado(m)}</td>
        <td data-rotulo="Renda média por mês" class="num forte" data-saida="rendaMensal">${fmtMoeda(m.rendaMensal)}</td>
        <td data-rotulo="Yield sobre o custo" class="num" data-saida="yieldOnCost">${fmtTaxa(m.yieldOnCost)}</td>
        ${simulacao}
      </tr>`;
  }

  function cartoesDaCarteira(c) {
    const resultado = c.resultado === null
      ? vazio
      : `<strong class="${classeResultado(c.resultado)}">${fmtMoeda(c.resultado)}</strong><span class="rotulo">${fmtPct(c.resultadoPct)}</span>`;
    return `
      <div class="card"><span class="rotulo">Investido (o que saiu do bolso)</span><strong>${fmtMoeda(c.valorInvestido)}</strong></div>
      <div class="card"><span class="rotulo">Valor hoje</span><strong>${fmtMoeda(c.valorAtual)}</strong></div>
      <div class="card"><span class="rotulo">Ganho ou perda</span>${resultado}</div>
      <div class="card ok"><span class="rotulo">Renda média por mês</span><strong>${fmtMoeda(c.rendaMensal)}</strong><span class="rotulo">${c.rendaAnual === null ? '' : `${fmtMoeda(c.rendaAnual)} no ano`}</span></div>
      <div class="card"><span class="rotulo">Yield sobre o custo</span><strong>${fmtTaxa(c.yieldOnCost)}</strong></div>`;
  }

  /** Diz de onde o número saiu e o que falta — sem isso o "—" vira mistério. */
  function notaDosTotais(c) {
    if (!c.ativos) {
      return 'Nenhuma posição informada ainda. Preencha <strong>Qtd. que tenho</strong> (e o preço médio, se lembrar) para ver o quanto a carteira vale e quanto ela paga por mês.';
    }
    const partes = [`${c.ativos} ativo(s) com posição informada`,
      'renda calculada com o provento (DPA) de cada linha da tabela de premissas'];
    if (c.semPrecoMedio) partes.push(`${c.semPrecoMedio} sem preço médio (fora do ganho/perda e do yield sobre o custo)`);
    if (c.semCotacao) partes.push(`${c.semCotacao} sem cotação (clique em “Atualizar cotações”)`);
    if (c.semProvento) partes.push(`${c.semProvento} sem provento definido (não entra na renda)`);
    return escapar(partes.join(' · '));
  }

  let redesenhoAgendado = null;

  /**
   * Guarda quem estava sendo digitado antes de refazer a tabela e devolve o foco
   * depois: a atualização de cotações acontece enquanto a pessoa preenche a
   * posição, e o cursor pulava fora do campo no meio da digitação.
   */
  function preservandoFoco(refazer) {
    const ativo = document.activeElement;
    const dentro = ativo && ativo.closest && ativo.closest('#tabela-posicoes');
    const marca = dentro ? { id: ativo.dataset.id, campo: ativo.dataset.campo, cursor: ativo.selectionStart } : null;
    refazer();
    if (!marca || !marca.id) return;
    const alvo = document.querySelector(`#tabela-posicoes tr[data-id="${marca.id}"] [data-campo="${marca.campo}"]`);
    if (!alvo) return;
    alvo.focus();
    try {
      if (marca.cursor !== null && marca.cursor !== undefined) alvo.setSelectionRange(marca.cursor, marca.cursor);
    } catch {
      // input que não aceita seleção (number, select): o foco já basta.
    }
  }

  function renderMinhaCarteira() {
    const secao = el('#minha-carteira');
    if (!secao || secao.hidden) return;
    const { linhas, resumo } = avaliarCarteira(estado.ativos, estado.config);

    el('#totais').innerHTML = cartoesDaCarteira(resumo.carteira);
    el('#totais-nota').innerHTML = notaDosTotais(resumo.carteira);

    preservandoFoco(() => {
      el('#tabela-posicoes thead tr').innerHTML = colunasDaPosicao()
        .map((c) => `<th class="${c.num ? 'num' : ''}">${c.rotulo}</th>`).join('');
      el('#tabela-posicoes tbody').innerHTML = linhas.length
        ? linhas.map(linhaPosicaoHtml).join('')
        : `<tr class="vazia"><td colspan="${colunasDaPosicao().length}">Sua carteira está vazia. Use o rastreador ou “+ Ativo” para incluir papéis.</td></tr>`;
    });

    renderSimulacao(resumo.carteira);
    agendarGraficos();
  }

  /** Atualiza só as células calculadas — quem está digitando não perde o foco. */
  function atualizarLinhaPosicao(id) {
    const secao = el('#minha-carteira');
    if (!secao || secao.hidden) return;
    const tr = document.querySelector(`#tabela-posicoes tr[data-id="${id}"]`);
    const ativo = estado.ativos.find((a) => a.id === id);
    // Linha ainda não desenhada (ativo recém-criado): refaz a tabela uma vez só.
    if (!ativo) return;
    if (!tr) {
      renderMinhaCarteira();
      return;
    }
    const m = avaliarAtivo(ativo, estado.config);
    const escrever = (saida, html, classe) => {
      const alvo = tr.querySelector(`[data-saida="${saida}"]`);
      if (!alvo) return;
      alvo.innerHTML = html;
      if (classe) alvo.className = classe;
    };
    ['quantidade', 'precoMedio'].forEach((campo) => {
      const aviso = tr.querySelector(`[data-aviso="${campo}"]`);
      if (aviso) aviso.innerHTML = avisoDeNumero(ativo, campo);
    });
    escrever('valorAtual', fmtMoeda(m.valorAtual));
    escrever('resultado', celulaResultado(m), `num ${classeResultado(m.resultado)}`);
    escrever('rendaMensal', fmtMoeda(m.rendaMensal));
    escrever('yieldOnCost', fmtTaxa(m.yieldOnCost));

    const { resumo } = avaliarCarteira(estado.ativos, estado.config);
    el('#totais').innerHTML = cartoesDaCarteira(resumo.carteira);
    el('#totais-nota').innerHTML = notaDosTotais(resumo.carteira);
    renderSimulacao(resumo.carteira);
    agendarGraficos();
  }

  /** Antes → depois da compra simulada, que é a pergunta "vale a pena comprar?". */
  function renderSimulacao(carteiraAtual) {
    const painel = el('#simulacao-resumo');
    if (!simulando()) {
      painel.hidden = true;
      return;
    }
    const { ativos: simulados, custo, caixa, compras, semCotacao } = Calc.simularCompras(estado.ativos);
    if (!compras) {
      painel.hidden = false;
      painel.innerHTML = '<p class="sub">Digite na coluna <strong>Simular ±</strong> quantas ações você pensa em comprar (ou use número negativo para vender). A compra é somada ao que você já tem, pelo preço de hoje.</p>';
      return;
    }
    const depois = avaliarCarteira(simulados, estado.config).resumo.carteira;
    const diferencaRenda = depois.rendaMensal !== null && carteiraAtual.rendaMensal !== null
      ? depois.rendaMensal - carteiraAtual.rendaMensal
      : depois.rendaMensal;

    const linha = (rotulo, antes, agora, formatar) => `
      <div class="comparacao">
        <span class="rotulo">${rotulo}</span>
        <span class="antes">${formatar(antes)}</span>
        <span class="seta">→</span>
        <strong>${formatar(agora)}</strong>
      </div>`;

    painel.hidden = false;
    painel.innerHTML = `
      <h3>Se você fizer essa compra</h3>
      <div class="comparacoes">
        ${custo !== null ? `<div class="comparacao"><span class="rotulo">Custo da compra</span><strong>${fmtMoeda(custo)}</strong></div>` : ''}
        ${caixa !== null ? `<div class="comparacao"><span class="rotulo">Entra da venda</span><strong>${fmtMoeda(caixa)}</strong></div>` : ''}
        ${linha('Renda por mês', carteiraAtual.rendaMensal, depois.rendaMensal, fmtMoeda)}
        ${linha('Valor da carteira', carteiraAtual.valorAtual, depois.valorAtual, fmtMoeda)}
        ${linha('Yield sobre o custo', carteiraAtual.yieldOnCost, depois.yieldOnCost, (v) => fmtTaxa(v))}
      </div>
      <p class="sub">${diferencaRenda === null ? '' : `Sua renda mensal muda em <strong>${fmtMoeda(diferencaRenda)}</strong>.`} Simulação a preço de hoje, sem corretagem e sem imposto; nada é gravado na sua posição real.</p>
      ${semCotacao.length ? `<p class="sub alerta">Sem cotação, não dá para simular: ${escapar(semCotacao.join(', '))}. Clique em “Atualizar cotações” ou digite o preço na tabela de premissas.</p>` : ''}`;
  }

  /** Redesenha no máximo a cada 150 ms: digitar não pode redesenhar 10 vezes. */
  function agendarGraficos() {
    clearTimeout(redesenhoAgendado);
    redesenhoAgendado = setTimeout(desenharGraficos, 150);
  }

  const larguraDe = (seletor) => {
    const alvo = el(seletor);
    const medida = alvo ? alvo.clientWidth : 0;
    // 1 unidade do viewBox = 1 pixel: assim o texto não encolhe nem estica. O teto
    // alto evita a faixa em branco dos dois lados no monitor largo.
    return Math.max(240, Math.min(1600, medida || 640));
  };

  function desenharGraficos() {
    const secao = el('#minha-carteira');
    if (!secao || secao.hidden) return;

    // A rosca e a projeção seguem a carteira REAL, igual aos cartões — mostrar a
    // hipotética sem dizer faria o desenho contradizer o número do lado.
    const { linhas: atuais, resumo } = avaliarCarteira(estado.ativos, estado.config);
    const simuladas = simulando() ? avaliarCarteira(Calc.simularCompras(estado.ativos).ativos, estado.config).linhas : atuais;
    const linhas = atuais;
    const carteira = resumo.carteira;

    const composicao = linhas
      .filter((l) => l.metricas.valorAtual !== null)
      .map((l) => ({ rotulo: l.ativo.ticker || '—', valor: l.metricas.valorAtual }));
    const maiorFatia = composicao.slice().sort((a, b) => b.valor - a.valor)[0];
    el('#g-composicao').innerHTML = Graficos.rosca(composicao, {
      largura: larguraDe('#g-composicao'),
      titulo: 'Composição da carteira por ativo',
      resumo: maiorFatia && carteira.valorAtual
        ? `${composicao.length} ativos; maior posição ${maiorFatia.rotulo}, ${fmtTaxa(maiorFatia.valor / carteira.valorAtual, 0)} da carteira.`
        : '',
    })
      || '<p class="sub">Preencha a quantidade (e atualize as cotações) para ver onde está o seu dinheiro.</p>';

    // A barra mostra a renda depois da simulação; o pedaço destacado é o que a
    // compra acrescenta. Numa VENDA a barra encolhe — antes ela ficava parada,
    // dizendo que o ativo vendido continuava pagando.
    const rendaPorAtivo = linhas.map((l, i) => {
      const atual = l.metricas.rendaMensal === null ? 0 : l.metricas.rendaMensal;
      const simulada = simuladas[i] && simuladas[i].metricas.rendaMensal !== null ? simuladas[i].metricas.rendaMensal : 0;
      const base = simulando() ? Math.min(atual, simulada) : atual;
      const extra = simulando() ? Math.max(0, simulada - atual) : 0;
      return { rotulo: l.ativo.ticker || '—', valor: base, extra };
    });
    el('#g-renda').innerHTML = Graficos.barras(rendaPorAtivo, {
      largura: larguraDe('#g-renda'),
      titulo: 'Renda mensal por ativo',
      resumo: carteira.rendaMensal === null ? '' : `Somam ${fmtMoeda(carteira.rendaMensal)} por mês.`,
    })
      || '<p class="sub">Sem provento informado ainda: preencha o DPA (ou atualize as cotações com os fundamentos ligados).</p>';

    desenharProjecao(carteira);
  }

  function desenharProjecao(carteira) {
    const opcoes = opcoesDaProjecao();
    const anos = Number(opcoes.anos) || 10;
    const semRenda = !carteira.rendaDeQuemTemCotacao || !carteira.valorQueRende;
    const { serie, resumo } = projetar({
      // Valor e renda do MESMO conjunto de ativos: usar o valor total com a renda
      // total inflaria o yield sempre que algum papel estivesse sem cotação.
      patrimonio: carteira.valorQueRende,
      rendaAnual: carteira.rendaDeQuemTemCotacao,
      aporteMensal: parseNumero(opcoes.aporteMensal) || 0,
      crescimentoAnual: parseNumero(opcoes.crescimentoAnual) || 0,
      reinvestir: opcoes.reinvestir !== false,
      meses: anos * 12,
    });
    const anual = porAno(serie);
    if (semRenda || anual.length < 2) {
      // Projetar renda zero desenharia uma linha reta no chão e um "R$ 0,00 por
      // mês" que parece resultado. Melhor dizer o que falta.
      el('#g-patrimonio').innerHTML = `<p class="sub">${semRenda && carteira.ativos
        ? 'Nenhum ativo com posição tem provento e cotação ao mesmo tempo. Atualize as cotações ou informe o DPA para o app projetar a renda.'
        : 'A projeção precisa de uma carteira com valor e provento: preencha as posições acima.'}</p>`;
      el('#g-renda-futura').innerHTML = '';
      el('#projecao-resumo').textContent = '';
      return;
    }

    el('#g-patrimonio').innerHTML = Graficos.areaEmpilhada(
      anual.map((p) => ({ x: p.ano, base: p.aportado, topo: Math.max(0, p.patrimonio - p.aportado) })),
      { largura: larguraDe('#g-patrimonio'), titulo: 'Patrimônio projetado', rotuloX: (v) => `${v} ano${v > 1 ? 's' : ''}` },
    );
    el('#g-renda-futura').innerHTML = Graficos.linha(
      anual.map((p) => ({ x: p.ano, y: p.rendaMensal })),
      {
        largura: larguraDe('#g-renda-futura'),
        titulo: 'Renda mensal projetada',
        rotuloX: (v) => `${v} ano${v > 1 ? 's' : ''}`,
        referencia: carteira.rendaMensal,
      },
    );
    const aportes = Math.max(0, resumo.aportado - carteira.valorQueRende);
    el('#projecao-resumo').innerHTML = `Em ${anos} anos: patrimônio de <strong>${fmtMoeda(resumo.patrimonioFinal)}</strong>, `
      + `renda de <strong>${fmtMoeda(resumo.rendaMensalFinal)}</strong> por mês. `
      + `Partindo dos ${fmtMoeda(carteira.valorQueRende)} de hoje, com ${fmtMoeda(aportes)} de aportes; `
      + `os proventos somaram ${fmtMoeda(resumo.recebido)}.`;
  }

  function abrirMinhaCarteira(abrir) {
    estado.config.carteiraAberta = abrir;
    el('#minha-carteira').hidden = !abrir;
    salvar();
    if (abrir) renderMinhaCarteira();
  }

  function exportarCarteiraCsv() {
    const { linhas, resumo } = avaliarCarteira(estado.ativos, estado.config);
    const dec = (n) => (n === null || n === undefined || !Number.isFinite(n) ? '' : String(n).replace('.', ','));
    const cabecalho = ['Ticker', 'Quantidade', 'Preco medio', 'Cotacao', 'Valor investido', 'Valor hoje',
      'Resultado', 'Resultado (%)', 'Provento anual por acao', 'Renda anual', 'Renda mensal', 'Yield sobre custo (%)'];
    const corpo = linhas
      .filter(({ metricas: m }) => m.posicao !== null)
      .map(({ ativo, metricas: m }) => [
        ativo.ticker || '', dec(m.posicao), dec(m.precoMedio), dec(m.cotacao),
        dec(m.valorInvestido), dec(m.valorAtual), dec(m.resultado),
        // Fração vira ponto percentual só aqui, na saída — a planilha espera 15,5.
        dec(m.resultadoPct === null ? null : m.resultadoPct * 100),
        dec(m.dpa), dec(m.rendaAnual), dec(m.rendaMensal),
        dec(m.yieldOnCost === null ? null : m.yieldOnCost * 100),
      ]);
    if (!corpo.length) {
      status('Nenhuma posição preenchida para exportar: informe a quantidade de pelo menos um ativo.', 'alerta');
      return;
    }
    const total = resumo.carteira;
    corpo.push(['TOTAL', '', '', '', dec(total.valorInvestido), dec(total.valorAtual), dec(total.resultado),
      dec(total.resultadoPct === null ? null : total.resultadoPct * 100), '', dec(total.rendaAnual), dec(total.rendaMensal),
      dec(total.yieldOnCost === null ? null : total.yieldOnCost * 100)]);
    const csv = [cabecalho, ...corpo].map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n');
    baixar(`minha-carteira-${hoje()}.csv`, `﻿${csv}`, 'text/csv;charset=utf-8');
    status(`${corpo.length - 1} posição(ões) exportadas.`, 'ok');
  }

  function ligarEventosDaCarteira() {
    el('#btn-carteira').addEventListener('click', () => abrirMinhaCarteira(el('#minha-carteira').hidden));
    el('#btn-carteira-fechar').addEventListener('click', () => abrirMinhaCarteira(false));
    el('#btn-carteira-csv').addEventListener('click', exportarCarteiraCsv);
    el('#btn-simular').addEventListener('click', () => {
      estado.config.simulando = !simulando();
      salvar();
      renderMinhaCarteira();
      sincronizarMinhaCarteira();
    });

    const corpo = el('#tabela-posicoes tbody');
    corpo.addEventListener('input', (evento) => {
      const alvo = evento.target.closest('.cel-input');
      if (!alvo) return;
      const ativo = estado.ativos.find((a) => a.id === alvo.dataset.id);
      if (!ativo) return;
      ativo[alvo.dataset.campo] = alvo.value;
      atualizarLinhaPosicao(ativo.id);
      salvar();
    });

    const conferirNumero = (seletor) => {
      // Aporte "1.000 reais" não é zero: é um número que o app não entendeu. Sem
      // aviso, a projeção sumia com R$ 190 mil e ninguém sabia por quê.
      const campo = el(seletor);
      const cru = String(campo.value || '').trim();
      const numero = parseNumero(cru);
      const ilegivel = !!cru && numero === null;
      // O crescimento do dividendo é limitado a ±50% ao ano; digitar 900 devolvia
      // o mesmo resultado de 50 sem nenhum sinal de que o número foi trocado.
      const foraDaFaixa = seletor === '#p-crescimento' && numero !== null && Math.abs(numero) > 50;
      campo.classList.toggle('nao-entendi', ilegivel || foraDaFaixa);
      campo.title = ilegivel
        ? 'Não entendi esse número: escreva só o valor, ex.: 1.000 ou 1 mil.'
        : foraDaFaixa
          ? 'A projeção limita o crescimento do dividendo a 50% ao ano — acima disso o resultado é o mesmo.'
          : '';
    };

    const campos = [
      ['#p-aporte', 'input', (e) => ({ aporteMensal: e.target.value })],
      ['#p-anos', 'change', (e) => ({ anos: Number(e.target.value) })],
      ['#p-crescimento', 'input', (e) => ({ crescimentoAnual: e.target.value })],
      ['#p-reinvestir', 'change', (e) => ({ reinvestir: e.target.checked })],
    ];
    campos.forEach(([sel, evt, ler]) => el(sel).addEventListener(evt, (evento) => {
      salvarProjecao(ler(evento));
      if (evento.target.tagName === 'INPUT' && evento.target.type !== 'checkbox') conferirNumero(sel);
      agendarGraficos();
    }));

    // Gráfico desenhado em pixels: mudou a largura da tela, redesenha.
    let redesenhoDeTela = null;
    window.addEventListener('resize', () => {
      clearTimeout(redesenhoDeTela);
      redesenhoDeTela = setTimeout(desenharGraficos, 200);
    });
  }

  function sincronizarMinhaCarteira() {
    const opcoes = opcoesDaProjecao();
    el('#p-aporte').value = opcoes.aporteMensal ?? '';
    el('#p-anos').value = String(opcoes.anos || 10);
    el('#p-crescimento').value = opcoes.crescimentoAnual ?? '';
    el('#p-reinvestir').checked = opcoes.reinvestir !== false;
    ['#p-aporte', '#p-crescimento'].forEach((seletor) => {
      const campo = el(seletor);
      const cru = String(campo.value || '').trim();
      const numero = parseNumero(cru);
      campo.classList.toggle('nao-entendi',
        (!!cru && numero === null) || (seletor === '#p-crescimento' && numero !== null && Math.abs(numero) > 50));
    });
    el('#minha-carteira').hidden = estado.config.carteiraAberta === false;
    el('#btn-simular').textContent = simulando() ? '🧮 Parar simulação' : '🧮 Simular compra';
    el('#btn-simular').classList.toggle('primario', simulando());
  }

  // ------------------------------------------------------------------ import/export

  function baixar(nome, conteudo, tipo) {
    const url = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
    const link = Object.assign(document.createElement('a'), { href: url, download: nome });
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  const hoje = () => new Date().toISOString().slice(0, 10);

  function exportarJson() {
    baixar(`carteira-preco-teto-${hoje()}.json`, JSON.stringify(estado, null, 2), 'application/json');
    status('Carteira exportada em JSON.', 'ok');
  }

  function exportarCsv() {
    const { linhas } = avaliarCarteira(estado.ativos, estado.config);
    const dec = (n) => (n === null || !Number.isFinite(n) ? '' : String(n).replace('.', ','));
    const cabecalho = ['Ticker', 'Setor', 'Base', 'Cotacao', 'LPA', 'DPA', 'Payout (%)', 'Yield aceitavel (%)', 'Preco-teto', 'Preco de compra', 'Margem de seguranca (%)', 'Comprar'];
    const corpo = ordenar(linhas).map(({ ativo, metricas: m }) => [
      ativo.ticker || '', ativo.setor || '', m.modo,
      dec(m.cotacao), dec(m.lpa), dec(m.dpa),
      // m.payout e não o texto da célula: com o payout vindo do padrão ou dos 12
      // meses, a coluna saía vazia e a planilha não reproduzia o preço-teto.
      dec(m.payout), dec(m.yieldAceitavel),
      dec(m.precoTeto), dec(m.precoAlvo), dec(m.margem === null ? null : m.margem * 100),
      { sim: 'SIM', nao: 'NAO', incompleto: 'FALTA DADO' }[m.veredito],
    ]);
    const csv = [cabecalho, ...corpo].map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n');
    baixar(`preco-teto-${hoje()}.csv`, `﻿${csv}`, 'text/csv;charset=utf-8');
    status('Planilha CSV exportada (abre direto no Excel).', 'ok');
  }

  function importarJson(arquivo) {
    const leitor = new FileReader();
    leitor.onload = () => {
      try {
        const dados = JSON.parse(leitor.result);
        if (!dados || !Array.isArray(dados.ativos)) throw new Error('arquivo sem a lista de ativos');
        estado = {
          config: { ...CONFIG_PADRAO, ...(dados.config || {}) },
          ativos: dados.ativos.map((a) => ({ ...a, id: a.id || novoId() })),
        };
        sincronizarConfig();
        sincronizarRastreador();
        sincronizarMinhaCarteira();
        render();
        status(`Carteira importada: ${estado.ativos.length} ativo(s).`, 'ok');
      } catch (erro) {
        status(`JSON inválido: ${erro.message}`, 'erro');
      }
    };
    leitor.readAsText(arquivo);
  }

  // ------------------------------------------------------------------ eventos

  function sincronizarConfig() {
    el('#yield-padrao').value = estado.config.yieldPadrao ?? '';
    el('#payout-padrao').value = estado.config.payoutPadrao ?? '';
    el('#margem-minima').value = estado.config.margemMinima ?? '';
    el('#token').value = estado.config.token ?? '';
    el('#busca').value = estado.config.busca ?? '';
    el('#somente-comprar').checked = !!estado.config.somenteComprar;
    el('#fundamentos').checked = !!estado.config.fundamentos;
    el('#auto-atualizar').checked = estado.config.autoAtualizar !== false;
  }

  function ligarEventos() {
    const tbody = el('#tabela tbody');

    tbody.addEventListener('input', (evento) => {
      const alvo = evento.target.closest('.cel-input');
      if (!alvo) return;
      const ativo = estado.ativos.find((a) => a.id === alvo.dataset.id);
      if (!ativo) return;
      const campo = alvo.dataset.campo;
      ativo[campo] = alvo.value;
      // Digitou por cima: vira premissa sua e a busca não sobrescreve mais.
      if (campo === 'lpaInformado') delete ativo.lpaAutomatico;
      if (campo === 'dpaInformado') delete ativo.dpaAutomatico;
      if (campo === 'ticker') {
        ativo.ticker = alvo.value.toUpperCase();
        // Ticker trocado invalida TUDO que veio do ticker anterior. Antes, só nome,
        // setor e carimbo saíam: o LPA e os proventos do papel antigo continuavam,
        // e a linha passava a mostrar preço de um ativo com fundamento de outro.
        delete ativo.nome;
        delete ativo.setor;
        delete ativo.cotacaoAtualizadaEm;
        delete ativo.erroAtualizacao;
        delete ativo.dpa12mMercado;
        delete ativo.fonteProventos;
        if (ativo.lpaAutomatico) {
          delete ativo.lpaInformado;
          delete ativo.lpaAutomatico;
        }
        if (ativo.dpaAutomatico) {
          delete ativo.dpaInformado;
          delete ativo.dpaAutomatico;
        }
      }
      if (campo === 'cotacao') {
        delete ativo.cotacaoAtualizadaEm;
        delete ativo.erroAtualizacao;
      }
      atualizarLinha(ativo.id);
    });

    tbody.addEventListener('change', (evento) => {
      const alvo = evento.target.closest('select.cel-input');
      if (!alvo) return;
      const ativo = estado.ativos.find((a) => a.id === alvo.dataset.id);
      if (!ativo) return;
      ativo.modo = alvo.value;
      render(); // trocar de modo muda quais células são editáveis
    });

    tbody.addEventListener('click', (evento) => {
      const botao = evento.target.closest('[data-remover]');
      if (!botao) return;
      estado.ativos = estado.ativos.filter((a) => a.id !== botao.dataset.remover);
      render();
    });

    el('#tabela thead').addEventListener('click', (evento) => {
      const th = evento.target.closest('[data-ordenar]');
      if (!th) return;
      const chave = th.dataset.ordenar;
      if (estado.config.ordenarPor === chave) estado.config.ordemDecrescente = !estado.config.ordemDecrescente;
      else Object.assign(estado.config, { ordenarPor: chave, ordemDecrescente: true });
      render();
    });

    el('#btn-adicionar').addEventListener('click', () => {
      const novo = { id: novoId(), ticker: '', modo: 'lpa' };
      estado.ativos.unshift(novo);
      // Linha nova não tem margem nem veredito: com filtro ligado ela nasceria
      // escondida, e o cursor ia parar no ticker de OUTRA linha.
      if (estado.config.busca || estado.config.somenteComprar) {
        Object.assign(estado.config, { busca: '', somenteComprar: false });
        sincronizarConfig();
        status('Filtros limpos para a linha nova aparecer.', '');
      }
      render();
      const campo = document.querySelector(`#tabela tbody tr[data-id="${novo.id}"] input.ticker`);
      if (campo) {
        campo.focus();
        campo.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    });

    el('#btn-cotacoes').addEventListener('click', atualizarCotacoes);
    el('#btn-diagnostico').addEventListener('click', rodarDiagnostico);
    el('#status').addEventListener('click', (evento) => {
      const botao = evento.target.closest('.ver-detalhes');
      if (!botao) return;
      const lista = el('#status .detalhes');
      const aberto = !lista.hidden;
      lista.hidden = aberto;
      botao.setAttribute('aria-expanded', String(!aberto));
    });
    el('#btn-json').addEventListener('click', exportarJson);
    el('#btn-csv').addEventListener('click', exportarCsv);
    el('#btn-importar').addEventListener('click', () => el('#arquivo').click());
    el('#arquivo').addEventListener('change', (evento) => {
      const arquivo = evento.target.files[0];
      if (arquivo) importarJson(arquivo);
      evento.target.value = '';
    });

    el('#btn-zerar').addEventListener('click', () => {
      if (!confirm('Apagar todos os ativos e voltar à lista inicial? Exporte antes se quiser guardar.')) return;
      localStorage.removeItem(CHAVE_STORAGE);
      estado = carregar();
      localStorage.removeItem(`${CHAVE_STORAGE}.ilegivel`);
      sincronizarConfig();
      sincronizarRastreador();
      sincronizarMinhaCarteira();
      render();
      status('Carteira restaurada para a lista inicial.', '');
    });

    const camposDeConfig = {
      'yield-padrao': 'yieldPadrao',
      'payout-padrao': 'payoutPadrao',
      'margem-minima': 'margemMinima',
    };
    Object.entries(camposDeConfig).forEach(([id, chave]) => {
      el(`#${id}`).addEventListener('input', (evento) => {
        estado.config[chave] = evento.target.value;
        render();
      });
    });
    el('#token').addEventListener('input', (evento) => {
      estado.config.token = evento.target.value.trim();
      salvar();
    });
    el('#busca').addEventListener('input', (evento) => {
      estado.config.busca = evento.target.value;
      render();
    });
    el('#somente-comprar').addEventListener('change', (evento) => {
      estado.config.somenteComprar = evento.target.checked;
      render();
    });
    el('#fundamentos').addEventListener('change', (evento) => {
      estado.config.fundamentos = evento.target.checked;
      salvar();
    });
    el('#auto-atualizar').addEventListener('change', (evento) => {
      estado.config.autoAtualizar = evento.target.checked;
      salvar();
    });
  }

  /**
   * Atualiza sozinho ao abrir, para a tabela já aparecer com preço de hoje.
   * Só roda quando há por onde consultar (servidor local ou token) e quando há
   * ticker válido — assim a página publicada não tenta e falha a cada abertura.
   */
  async function atualizarAoAbrir() {
    if (estado.config.autoAtualizar === false) return;
    const temTicker = estado.ativos.some((a) => TICKER_B3.test(String(a.ticker || '').trim().toUpperCase()));
    if (!temTicker) return;
    const local = await servidor();
    if (!local.disponivel && !String(estado.config.token || '').trim()) return;
    await atualizarCotacoes();
  }

  if (avisoDeCarregamento) {
    // Precisa ser dito: a carteira do usuário não pode sumir caladamente.
    setTimeout(() => status(avisoDeCarregamento, 'alerta', [
      `A cópia ficou salva no navegador na chave "${CHAVE_STORAGE}.ilegivel".`,
    ]), 0);
  }

  sincronizarConfig();
  sincronizarRastreador();
  sincronizarMinhaCarteira();
  ligarEventos();
  ligarEventosDoRastreador();
  ligarEventosDaCarteira();
  render();
  atualizarAoAbrir();
  if (estado.config.rastreadorAberto !== false) carregarUniverso(false);
})();
