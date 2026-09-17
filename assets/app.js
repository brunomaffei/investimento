/** Interface: tabela editável, resumo, cotações automáticas e import/export. */
(function () {
  'use strict';

  const { parseNumero, avaliarCarteira, avaliarAtivo } = window.Calc;
  const {
    buscarCotacoes, buscarPeloServidor, detectarServidor, diagnosticar, interpretar, TICKER_B3,
  } = window.Quotes;
  const { CONFIG_PADRAO, CARTEIRA_INICIAL } = window.Seed;

  const CHAVE_STORAGE = 'precoteto.v1';

  const el = (sel) => document.querySelector(sel);
  const novoId = () => `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

  let estado = carregar();

  // ---------------------------------------------------------------- persistência

  function carregar() {
    try {
      const salvo = JSON.parse(localStorage.getItem(CHAVE_STORAGE) || 'null');
      if (salvo && Array.isArray(salvo.ativos)) {
        return {
          config: { ...CONFIG_PADRAO, ...(salvo.config || {}) },
          ativos: salvo.ativos.map((a) => ({ ...a, id: a.id || novoId() })),
        };
      }
    } catch (erro) {
      console.warn('Não foi possível ler os dados salvos:', erro);
    }
    return {
      config: { ...CONFIG_PADRAO },
      ativos: CARTEIRA_INICIAL.map((a) => ({ ...a, id: novoId() })),
    };
  }

  function salvar() {
    try {
      localStorage.setItem(CHAVE_STORAGE, JSON.stringify(estado));
    } catch (erro) {
      console.warn('Não foi possível salvar:', erro);
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
    const payout = modo === 'dividendo'
      ? `<span data-saida="payoutImplicito">${m.payoutImplicito !== null ? `${fmt2.format(m.payoutImplicito)}%` : vazio}</span>`
      : inputCelula(ativo, 'payout', 'placeholder="ex.: 70"');
    const lpa = modo === 'lpa'
      ? inputCelula(ativo, 'lpaInformado', 'placeholder="ex.: 3,67"')
      : `<span data-saida="lpa">${fmtMoeda(m.lpa)}</span>`;
    const dpa = modo === 'dividendo'
      ? inputCelula(ativo, 'dpaInformado', 'placeholder="ex.: 2,57"')
      : `<span data-saida="dpa">${fmtMoeda(m.dpa)}</span>`;
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
    const origem = ativo.cotacaoAtualizadaEm
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
        <td data-rotulo="Cotação atual" class="num">${inputCelula(ativo, 'cotacao', 'placeholder="0,00"')}${origem}</td>
        <td data-rotulo="Lucro projetado" class="num">${p.lucro}</td>
        <td data-rotulo="Qtd. ações/units" class="num">${p.qtd}</td>
        <td data-rotulo="Payout (%)" class="num">${p.payout}</td>
        <td data-rotulo="Yield aceitável (%)" class="num">${inputCelula(ativo, 'yieldAceitavel', `placeholder="${fmt0.format(parseNumero(estado.config.yieldPadrao) || 6)}"`)}</td>
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
    salvar();
  }

  /** Atualiza só as células calculadas de uma linha — mantém o foco de quem digita. */
  function atualizarLinha(id) {
    const tr = document.querySelector(`tr[data-id="${id}"]`);
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
      estado.ativos.forEach((ativo) => {
        const info = dados[String(ativo.ticker || '').toUpperCase()];
        if (!info) return;
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
        if (finito(info.lpa) && ativo.modo === 'lpa' && !String(ativo.lpaInformado || '').trim()) {
          ativo.lpaInformado = fmt2.format(info.lpa);
        }
        if (positivo(info.dpa12m) && ativo.modo === 'dividendo' && !String(ativo.dpaInformado || '').trim()) {
          ativo.dpaInformado = fmt2.format(info.dpa12m);
        }
      });

      render();
      const listaErros = Object.entries(erros);
      const extra = (avisos || []).join(' ');
      if (!listaErros.length) {
        const quando = new Date().toLocaleString('pt-BR');
        status(`${atualizados} ativo(s) atualizados em ${quando}${caminho}. ${extra}`.trim(), extra ? 'alerta' : 'ok');
      } else {
        const resumoErros = [...new Set(listaErros.map(([, motivo]) => motivo))].join(' ');
        status(`${atualizados} atualizados. ${listaErros.length} com problema: ${resumoErros} ${extra}`.trim(), 'alerta');
      }
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
      status('Diagnóstico concluído.', '');
    } catch (erro) {
      painel.innerHTML = `<p class="conclusao">Não foi possível rodar o diagnóstico: ${escapar(erro.message)}</p>`;
    } finally {
      botao.disabled = false;
      botao.textContent = '🔌 Testar conexão';
    }
  }

  function status(texto, tipo = '') {
    const alvo = el('#status');
    alvo.textContent = texto;
    alvo.className = `status ${tipo}`;
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
      dec(parseNumero(ativo.payout)), dec(m.yieldAceitavel),
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
    el('#margem-minima').value = estado.config.margemMinima ?? '';
    el('#token').value = estado.config.token ?? '';
    el('#busca').value = estado.config.busca ?? '';
    el('#somente-comprar').checked = !!estado.config.somenteComprar;
    el('#fundamentos').checked = !!estado.config.fundamentos;
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
      if (campo === 'ticker') {
        ativo.ticker = alvo.value.toUpperCase();
        // Ticker trocado invalida nome/setor/carimbo da cotação antiga.
        delete ativo.nome;
        delete ativo.setor;
        delete ativo.cotacaoAtualizadaEm;
      }
      if (campo === 'cotacao') delete ativo.cotacaoAtualizadaEm;
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
      estado.ativos.unshift({ id: novoId(), ticker: '', modo: 'lpa' });
      render();
      const primeiro = document.querySelector('#tabela tbody input.ticker');
      if (primeiro) primeiro.focus();
    });

    el('#btn-cotacoes').addEventListener('click', atualizarCotacoes);
    el('#btn-diagnostico').addEventListener('click', rodarDiagnostico);
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
      sincronizarConfig();
      render();
      status('Carteira restaurada para a lista inicial.', '');
    });

    ['yield-padrao', 'margem-minima'].forEach((id) => {
      el(`#${id}`).addEventListener('input', (evento) => {
        estado.config[id === 'yield-padrao' ? 'yieldPadrao' : 'margemMinima'] = evento.target.value;
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
  }

  sincronizarConfig();
  ligarEventos();
  render();
})();
