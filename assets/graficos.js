/**
 * Gráficos em SVG escrito à mão — sem biblioteca, sem CDN, sem build.
 *
 * Cada função devolve o SVG como STRING. Duas razões: a tela só faz
 * `elemento.innerHTML = Graficos.barras(...)`, e o teste em Node puro consegue
 * conferir a GEOMETRIA com expressão regular (a barra do dobro do valor tem o
 * dobro da largura), que é o que prova que o desenho representa o dado.
 *
 * Regras de casa:
 *   - largura em pixels vem de fora (a tela mede o container), para 1 unidade do
 *     viewBox valer 1 pixel e o texto não encolher no celular;
 *   - todo número passa por uma guarda: x="NaN" some sem erro no console;
 *   - todo texto passa por escape — ticker é digitado pelo usuário;
 *   - sem dado, devolve string vazia: quem chama escreve a frase explicando.
 *   - verde e vermelho só significam ganho e perda, como no resto do app; para
 *     distinguir ativos existe uma paleta própria.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Graficos = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Tons bem separados, legíveis no tema escuro e distinguíveis por quem não
  // enxerga cor: a ordem também é a ordem de tamanho, e cada fatia leva rótulo.
  const PALETA = [
    'hsl(217 90% 62%)', 'hsl(41 92% 56%)', 'hsl(174 62% 48%)', 'hsl(280 70% 66%)',
    'hsl(12 82% 62%)', 'hsl(142 55% 52%)', 'hsl(199 85% 55%)', 'hsl(330 65% 62%)',
  ];
  const CINZA = 'hsl(220 12% 45%)';

  const n = (v, padrao = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : padrao);
  const arredondar = (v) => Math.round(n(v) * 100) / 100;
  const escapar = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const fmtReais = (v) => `R$ ${new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n(v))}`;
  const fmtPct = (fracao) => `${new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n(fracao) * 100)}%`;
  /**
   * Eixo com número curto ("R$ 804.545,98" espremido na lateral não se lê). A
   * unidade vem do MAIOR valor do eixo e vale para todas as marcas: misturar
   * "R$ 1,8 mil" em cima com "R$ 881,4" no meio faz comparar coisas diferentes.
   */
  const fmtEixo = (v, referencia = v) => {
    const valor = n(v);
    const escala = Math.abs(n(referencia));
    const curto = (x, sufixo) => `R$ ${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(x)}${sufixo}`;
    if (valor === 0) return 'R$ 0';
    if (escala >= 1e6) return curto(valor / 1e6, ' mi');
    if (escala >= 1e3) return curto(valor / 1e3, ' mil');
    return curto(valor, '');
  };

  const abrirSvg = (largura, altura, titulo, resumo = '') => `<svg viewBox="0 0 ${arredondar(largura)} ${arredondar(altura)}" width="100%" height="${arredondar(altura)}" preserveAspectRatio="xMinYMin meet" role="img" aria-label="${escapar(resumo ? `${titulo}. ${resumo}` : titulo)}">`;

  /** Marcas do eixo X espaçadas pelo que cabe na largura disponível. */
  function marcasDoEixo(pontos, larguraUtil) {
    const cabem = Math.max(2, Math.floor(larguraUtil / 64));
    const passo = Math.max(1, Math.ceil(pontos.length / cabem));
    const escolhidos = pontos.filter((_, i) => i % passo === 0);
    const ultimo = pontos[pontos.length - 1];
    if (escolhidos[escolhidos.length - 1] !== ultimo) {
      // O último ano é o que interessa: se o passo não o pegou, troca o anterior.
      if (escolhidos.length > 1 && pontos.length - 1 - pontos.indexOf(escolhidos[escolhidos.length - 1]) < passo / 2) escolhidos.pop();
      escolhidos.push(ultimo);
    }
    return escolhidos;
  }

  /**
   * Rosca de composição: quanto cada ativo pesa no total.
   * @param {{rotulo: string, valor: number}[]} fatias
   * @param {{largura?: number, titulo?: string, maximoFatias?: number}} [opcoes]
   */
  function rosca(fatias, opcoes = {}) {
    const { largura = 640, titulo = 'Composição da carteira', maximoFatias = 8, resumo = '' } = opcoes;
    const validas = (fatias || [])
      .map((f) => ({ rotulo: String(f.rotulo || ''), valor: n(f.valor) }))
      .filter((f) => f.valor > 0)
      .sort((a, b) => b.valor - a.valor);
    if (!validas.length) return '';

    // Agrupar a cauda evita uma rosca de 40 fatias ilegíveis.
    const principais = validas.slice(0, maximoFatias);
    const cauda = validas.slice(maximoFatias);
    if (cauda.length) {
      principais.push({ rotulo: `Outros (${cauda.length})`, valor: cauda.reduce((s, f) => s + f.valor, 0), cauda: true });
    }
    const total = principais.reduce((s, f) => s + f.valor, 0);

    // Em painel estreito (celular, ou duas colunas no desktop) a legenda ao lado da
    // rosca colide com os valores. Abaixo de 520px ela vai para baixo do anel.
    const estreito = largura < 520;
    const raio = estreito ? 62 : 78;
    const espessura = estreito ? 26 : 30;
    const alturaAnel = raio * 2 + 30;
    const alturaLegenda = principais.length * 21 + 8;
    const altura = estreito
      ? alturaAnel + alturaLegenda
      : Math.max(alturaAnel, 26 + principais.length * 22);
    const centroX = estreito ? largura / 2 : raio + 32;
    const centroY = estreito ? alturaAnel / 2 : altura / 2;
    const circunferencia = 2 * Math.PI * raio;

    let acumulado = 0;
    const aneis = principais.map((fatia, i) => {
      const fracao = fatia.valor / total;
      // Cada fatia é um círculo com tracejado do tamanho do arco: sem trigonometria
      // e sem erro de fechamento — o resto do traço fica transparente.
      const arco = circunferencia * fracao;
      const inicio = -circunferencia * acumulado;
      acumulado += fracao;
      const cor = fatia.cauda ? CINZA : PALETA[i % PALETA.length];
      return `<circle cx="${arredondar(centroX)}" cy="${arredondar(centroY)}" r="${raio}" fill="none" stroke="${cor}" stroke-width="${espessura}"`
        + ` stroke-dasharray="${arredondar(arco)} ${arredondar(circunferencia - arco)}" stroke-dashoffset="${arredondar(inicio)}"`
        + ` transform="rotate(-90 ${arredondar(centroX)} ${arredondar(centroY)})" data-valor="${arredondar(fatia.valor)}" data-fracao="${arredondar(fracao * 1000) / 1000}">`
        + `<title>${escapar(fatia.rotulo)}: ${fmtReais(fatia.valor)} (${fmtPct(fracao)})</title></circle>`;
    }).join('');

    const legenda = principais.map((fatia, i) => {
      const y = estreito ? alturaAnel + 14 + i * 21 : 20 + i * 22;
      const xChave = estreito ? 6 : centroX + raio + 26;
      const cor = fatia.cauda ? CINZA : PALETA[i % PALETA.length];
      return `<rect x="${arredondar(xChave)}" y="${arredondar(y - 9)}" width="11" height="11" rx="2" fill="${cor}"></rect>`
        + `<text class="rotulo" x="${arredondar(xChave + 18)}" y="${arredondar(y)}">${escapar(fatia.rotulo)}</text>`
        + `<text class="valor" x="${arredondar(largura - 8)}" y="${arredondar(y)}" text-anchor="end">${fmtReais(fatia.valor)} · ${fmtPct(fatia.valor / total)}</text>`;
    }).join('');

    const centro = `<text class="centro" x="${arredondar(centroX)}" y="${arredondar(centroY - 2)}" text-anchor="middle">${fmtEixo(total)}</text>`
      + `<text class="rotulo" x="${arredondar(centroX)}" y="${arredondar(centroY + 16)}" text-anchor="middle">total</text>`;

    return `${abrirSvg(largura, altura, titulo, resumo)}${aneis}${centro}${legenda}</svg>`;
  }

  /**
   * Barras horizontais. Cada item pode ter uma parte simulada, empilhada em
   * outra cor — é assim que "se eu comprar 300 ações" aparece no desenho.
   * @param {{rotulo: string, valor: number, extra?: number, cor?: string}[]} itens
   * @param {{largura?: number, titulo?: string, formatar?: Function, maximo?: number}} [opcoes]
   */
  function barras(itens, opcoes = {}) {
    const { largura = 640, titulo = 'Valores por ativo', formatar = fmtReais, maximoItens = 12, cor = 'var(--acento)', corExtra = 'hsl(41 92% 56%)', resumo = '' } = opcoes;
    const ordenados = (itens || [])
      .map((i) => ({ rotulo: String(i.rotulo || ''), valor: n(i.valor), extra: Math.max(0, n(i.extra)) }))
      .filter((i) => i.valor > 0 || i.extra > 0)
      .sort((a, b) => (b.valor + b.extra) - (a.valor + a.extra));
    if (!ordenados.length) return '';

    // A cauda vira "Outros": cortada em silêncio, a soma das barras deixava de
    // bater com o total mostrado no cartão.
    const validos = ordenados.slice(0, maximoItens);
    const cauda = ordenados.slice(maximoItens);
    if (cauda.length) {
      validos.push({
        rotulo: `Outros (${cauda.length})`,
        valor: cauda.reduce((soma, i) => soma + i.valor, 0),
        extra: cauda.reduce((soma, i) => soma + i.extra, 0),
        cauda: true,
      });
    }

    const alturaLinha = 26;
    const altura = validos.length * alturaLinha + 12;
    const esquerda = 82;
    const direita = 118;
    const util = Math.max(40, largura - esquerda - direita);
    const teto = Math.max(...validos.map((i) => i.valor + i.extra));

    const linhas = validos.map((item, i) => {
      const y = 8 + i * alturaLinha;
      const larguraBase = teto > 0 ? (item.valor / teto) * util : 0;
      const larguraExtra = teto > 0 ? (item.extra / teto) * util : 0;
      const total = item.valor + item.extra;
      const barraExtra = item.extra > 0
        ? `<rect x="${arredondar(esquerda + larguraBase)}" y="${y}" width="${arredondar(larguraExtra)}" height="15" rx="3" fill="${corExtra}" data-extra="${arredondar(item.extra)}"><title>simulação: +${escapar(formatar(item.extra))}</title></rect>`
        : '';
      // Espaço do rótulo é fixo: texto maior é cortado com reticência em vez de
      // passar por baixo da barra.
      const limite = Math.max(6, Math.floor((esquerda - 6) / 7));
      const rotulo = item.rotulo.length > limite ? `${item.rotulo.slice(0, limite - 1)}…` : item.rotulo;
      return `<text class="rotulo" x="0" y="${y + 12}"><title>${escapar(item.rotulo)}</title>${escapar(rotulo)}</text>`
        + `<rect x="${esquerda}" y="${y}" width="${arredondar(larguraBase)}" height="15" rx="3" fill="${item.cauda ? CINZA : cor}" data-valor="${arredondar(item.valor)}">`
        + `<title>${escapar(item.rotulo)}: ${escapar(formatar(item.valor))}</title></rect>`
        + barraExtra
        + `<text class="valor" x="${arredondar(largura - 8)}" y="${y + 12}" text-anchor="end">${escapar(formatar(total))}</text>`;
    }).join('');

    return `${abrirSvg(largura, altura, titulo, resumo)}${linhas}</svg>`;
  }

  /**
   * Duas camadas empilhadas ao longo do tempo: o que saiu do bolso e o que veio
   * de provento reinvestido. É a imagem que faz o juro composto parar de ser
   * abstrato — a faixa de cima começa fininha e engorda sozinha.
   * @param {{x: number, base: number, topo: number}[]} pontos
   */
  function areaEmpilhada(pontos, opcoes = {}) {
    const { largura = 640, altura = 220, titulo = 'Patrimônio projetado', rotuloX = (v) => `${v}a` } = opcoes;
    const validos = (pontos || []).map((p) => ({ x: n(p.x), base: Math.max(0, n(p.base)), topo: Math.max(0, n(p.topo)) }));
    if (validos.length < 2) return '';

    const margem = { esquerda: 58, direita: 12, topo: 12, baixo: 24 };
    const util = { largura: Math.max(40, largura - margem.esquerda - margem.direita), altura: Math.max(40, altura - margem.topo - margem.baixo) };
    const teto = Math.max(...validos.map((p) => p.base + p.topo)) || 1;
    const primeiroX = validos[0].x;
    const ultimoX = validos[validos.length - 1].x;
    const escalaX = (x) => margem.esquerda + (ultimoX === primeiroX ? 0 : ((x - primeiroX) / (ultimoX - primeiroX)) * util.largura);
    const escalaY = (v) => margem.topo + util.altura - (v / teto) * util.altura;

    const caminho = (pegar) => validos.map((p, i) => `${i ? 'L' : 'M'}${arredondar(escalaX(p.x))} ${arredondar(escalaY(pegar(p)))}`).join(' ');
    const base = `${caminho((p) => p.base)} L${arredondar(escalaX(ultimoX))} ${arredondar(escalaY(0))} L${arredondar(escalaX(primeiroX))} ${arredondar(escalaY(0))} Z`;
    const total = `${caminho((p) => p.base + p.topo)} ${validos.slice().reverse().map((p) => `L${arredondar(escalaX(p.x))} ${arredondar(escalaY(p.base))}`).join(' ')} Z`;

    const grade = [0, 0.5, 1].map((f) => {
      const y = escalaY(teto * f);
      return `<line class="grade" x1="${margem.esquerda}" y1="${arredondar(y)}" x2="${arredondar(largura - margem.direita)}" y2="${arredondar(y)}"></line>`
        + `<text class="valor" x="${margem.esquerda - 6}" y="${arredondar(y + 4)}" text-anchor="end">${fmtEixo(teto * f, teto)}</text>`;
    }).join('');

    // Quantas marcas cabem sem os rótulos se encostarem — no celular, "1 ano" e
    // "2 anos" viravam uma palavra só.
    const marcas = marcasDoEixo(validos, util.largura)
      .map((p) => `<text class="rotulo" x="${arredondar(escalaX(p.x))}" y="${arredondar(altura - 6)}" text-anchor="middle">${escapar(rotuloX(p.x))}</text>`)
      .join('');

    return `${abrirSvg(largura, altura, titulo)}${grade}`
      + `<path d="${total}" fill="var(--verde-fundo)" stroke="var(--verde)" stroke-width="1.5" data-camada="reinvestido"></path>`
      + `<path d="${base}" fill="rgba(79,140,255,.25)" stroke="var(--acento)" stroke-width="1.5" data-camada="aportado"></path>`
      + `${marcas}</svg>`;
  }

  /**
   * Linha simples com marcas — usada para a renda mensal projetada.
   * @param {{x: number, y: number}[]} pontos
   */
  function linha(pontos, opcoes = {}) {
    const { largura = 640, altura = 190, titulo = 'Renda mensal projetada', rotuloX = (v) => `${v}a`, referencia = null } = opcoes;
    const validos = (pontos || []).map((p) => ({ x: n(p.x), y: Math.max(0, n(p.y)) }));
    if (validos.length < 2) return '';

    const margem = { esquerda: 58, direita: 12, topo: 12, baixo: 24 };
    const util = { largura: Math.max(40, largura - margem.esquerda - margem.direita), altura: Math.max(40, altura - margem.topo - margem.baixo) };
    const teto = Math.max(...validos.map((p) => p.y)) || 1;
    const primeiroX = validos[0].x;
    const ultimoX = validos[validos.length - 1].x;
    const escalaX = (x) => margem.esquerda + (ultimoX === primeiroX ? 0 : ((x - primeiroX) / (ultimoX - primeiroX)) * util.largura);
    const escalaY = (v) => margem.topo + util.altura - (v / teto) * util.altura;

    const grade = [0, 0.5, 1].map((f) => {
      const y = escalaY(teto * f);
      return `<line class="grade" x1="${margem.esquerda}" y1="${arredondar(y)}" x2="${arredondar(largura - margem.direita)}" y2="${arredondar(y)}"></line>`
        + `<text class="valor" x="${margem.esquerda - 6}" y="${arredondar(y + 4)}" text-anchor="end">${fmtEixo(teto * f, teto)}</text>`;
    }).join('');

    const traco = validos.map((p, i) => `${i ? 'L' : 'M'}${arredondar(escalaX(p.x))} ${arredondar(escalaY(p.y))}`).join(' ');
    const bolinhas = validos.map((p) => `<circle cx="${arredondar(escalaX(p.x))}" cy="${arredondar(escalaY(p.y))}" r="3" fill="var(--verde)" data-y="${arredondar(p.y)}">`
      + `<title>${escapar(rotuloX(p.x))}: ${fmtReais(p.y)} por mês</title></circle>`).join('');
    // Linha de onde ele partiu: sem ela, o crescimento não tem referência.
    const hoje = referencia !== null && Number.isFinite(referencia)
      ? `<line class="referencia" x1="${margem.esquerda}" y1="${arredondar(escalaY(referencia))}" x2="${arredondar(largura - margem.direita)}" y2="${arredondar(escalaY(referencia))}" stroke-dasharray="4 4"></line>`
      : '';
    // Quantas marcas cabem sem os rótulos se encostarem — no celular, "1 ano" e
    // "2 anos" viravam uma palavra só.
    const marcas = marcasDoEixo(validos, util.largura)
      .map((p) => `<text class="rotulo" x="${arredondar(escalaX(p.x))}" y="${arredondar(altura - 6)}" text-anchor="middle">${escapar(rotuloX(p.x))}</text>`)
      .join('');

    return `${abrirSvg(largura, altura, titulo)}${grade}${hoje}`
      + `<path d="${traco}" fill="none" stroke="var(--verde)" stroke-width="2"></path>${bolinhas}${marcas}</svg>`;
  }

  return { rosca, barras, areaEmpilhada, linha, PALETA, fmtReais, fmtPct, fmtEixo };
});
