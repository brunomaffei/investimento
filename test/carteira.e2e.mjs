/**
 * Prova a tela "Minha carteira": posição, renda, gráficos e simulação de compra.
 * Roda sobre file:// com Chromium real — não depende de rede nem de servidor.
 *
 *   npm i -D playwright-core && node test/carteira.e2e.mjs
 */
import { existsSync, globSync } from 'node:fs';

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.log('playwright-core não instalado — pule com: npm i -D playwright-core');
  process.exit(0);
}
const acharChromium = () => process.env.CHROMIUM_PATH
  || globSync('/opt/pw-browsers/chromium-*/chrome-linux/chrome').find((c) => existsSync(c));

let falhas = 0;
const ok = (c, m) => { console.log(`${c ? '  ok   ' : '  FALHA'} ${m}`); if (!c) falhas++; };

const APP = new URL('../index.html', import.meta.url).href;

// Carteira de teste com números redondos, conferíveis na mão:
//   BBAS3  300 x 23,10 = 6.930   custo 300 x 20,00 = 6.000   renda 300 x 2,18 / 12 = 54,50
//   XPLG11  50 x 95,50 = 4.775   sem preço médio             renda  50 x 8,77 / 12 = 36,54
//   TAEE11 200 x 35,40 = 7.080   custo 200 x 33,00 = 6.600   DPA = 2,94 x 90% = 2,646 -> 44,10
const CARTEIRA = [
  { id: 'a1', ticker: 'BBAS3', setor: 'Bancos', modo: 'dividendo', cotacao: '23,10', dpaInformado: '2,18', quantidade: '300', precoMedio: '20,00' },
  { id: 'a2', ticker: 'XPLG11', setor: 'Logística', modo: 'dividendo', cotacao: '95,50', dpaInformado: '8,77', quantidade: '50' },
  { id: 'a3', ticker: 'TAEE11', setor: 'Energia', modo: 'lpa', cotacao: '35,40', lpaInformado: '2,94', payout: '90', quantidade: '200', precoMedio: '33,00' },
  { id: 'a4', ticker: 'VIVT3', setor: 'Telecom', modo: 'lpa', cotacao: '26,00', lpaInformado: '2,10', payout: '60' },
];

const browser = await chromium.launch({ executablePath: acharChromium() });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const erros = [];
page.on('pageerror', (e) => erros.push(String(e)));

const cartao = async (i) => (await page.locator('#totais .card').nth(i).innerText()).replace(/\n/g, ' ');
const celula = async (id, rotulo) => (await page.locator(`#tabela-posicoes tr[data-id="${id}"] td[data-rotulo="${rotulo}"]`).innerText()).trim();

try {
  await page.goto(APP);
  await page.waitForSelector('#tabela tbody tr');
  await page.evaluate((ativos) => {
    const estado = JSON.parse(localStorage.getItem('precoteto.v1'));
    estado.config.rastreadorAberto = false;
    estado.config.autoAtualizar = false;
    estado.config.projecao = { aporteMensal: '', anos: 10, crescimentoAnual: '', reinvestir: true };
    estado.ativos = ativos;
    localStorage.setItem('precoteto.v1', JSON.stringify(estado));
  }, CARTEIRA);
  await page.reload();
  await page.waitForSelector('#tabela-posicoes tbody tr');
  await page.waitForTimeout(400);

  // 1. Totais
  ok((await cartao(0)).includes('R$ 12.600,00'), `investido só de quem tem preço médio: ${await cartao(0)}`);
  ok((await cartao(1)).includes('R$ 18.785,00'), `valor de hoje inclui quem não tem preço médio: ${await cartao(1)}`);
  ok((await cartao(2)).includes('R$ 1.410,00'), `ganho sobre o mesmo subconjunto: ${await cartao(2)}`);
  ok((await cartao(3)).includes('R$ 135,14'), `renda média mensal: ${await cartao(3)}`);
  // (654 + 529,20) de renda anual sobre 12.600 de custo = 9,39%.
  ok((await cartao(4)).includes('9,39%'), `yield sobre o custo agregado: ${await cartao(4)}`);
  const nota = await page.locator('#totais-nota').innerText();
  ok(/3 ativo/.test(nota) && /1 sem preço médio/.test(nota), `a nota explica o recorte: "${nota}"`);

  // 2. Linha a linha
  ok((await celula('a1', 'Valor hoje')) === 'R$ 6.930,00', `valor de BBAS3: ${await celula('a1', 'Valor hoje')}`);
  ok((await celula('a1', 'Renda por mês')) === 'R$ 54,50', `renda de BBAS3: ${await celula('a1', 'Renda por mês')}`);
  ok((await celula('a1', 'Yield sobre o custo')) === '10,90%', `YoC de BBAS3: ${await celula('a1', 'Yield sobre o custo')}`);
  ok((await celula('a3', 'Renda por mês')) === 'R$ 44,10', `renda vinda de LPA x payout: ${await celula('a3', 'Renda por mês')}`);
  ok(/falta preço médio/.test(await celula('a2', 'Resultado')), `quem não tem preço médio é avisado: ${await celula('a2', 'Resultado')}`);
  ok((await celula('a4', 'Valor hoje')) === '—', 'ativo sem posição não vira R$ 0,00');

  // 3. Digitar quantidade recalcula na hora, sem recarregar
  await page.fill('#tabela-posicoes tr[data-id="a4"] input[data-campo="quantidade"]', '100');
  await page.waitForTimeout(250);
  ok((await celula('a4', 'Valor hoje')) === 'R$ 2.600,00', `posição nova entra na hora: ${await celula('a4', 'Valor hoje')}`);
  ok((await cartao(1)).includes('R$ 21.385,00'), `o total acompanha: ${await cartao(1)}`);
  ok((await page.locator('#tabela-posicoes tr[data-id="a4"] input[data-campo="quantidade"]').inputValue()) === '100', 'o campo não perde o que foi digitado');

  // 4. Texto que não é número é apontado, não ignorado
  await page.fill('#tabela-posicoes tr[data-id="a4"] input[data-campo="quantidade"]', '100 ações');
  await page.waitForTimeout(250);
  ok(await page.locator('#tabela-posicoes tr[data-id="a4"] .tag.alerta').count() > 0, 'número que o app não entende ganha aviso');
  await page.fill('#tabela-posicoes tr[data-id="a4"] input[data-campo="quantidade"]', '');
  await page.waitForTimeout(250);

  // 5. Gráficos
  const fatias = await page.locator('#g-composicao svg circle[data-fracao]').count();
  ok(fatias === 3, `a rosca tem uma fatia por posição: ${fatias}`);
  const barras = await page.locator('#g-renda svg rect[data-valor]').count();
  ok(barras === 3, `uma barra de renda por ativo que paga: ${barras}`);
  const larguras = await page.locator('#g-renda svg rect[data-valor]').evaluateAll((rs) => rs.map((r) => ({
    largura: Number(r.getAttribute('width')), valor: Number(r.dataset.valor),
  })));
  const proporcional = Math.abs((larguras[0].largura / larguras[1].largura) - (larguras[0].valor / larguras[1].valor)) < 0.02;
  ok(proporcional, `a barra é proporcional à renda: ${JSON.stringify(larguras.slice(0, 2))}`);

  // 6. Projeção
  await page.fill('#p-aporte', '1.000');
  await page.selectOption('#p-anos', '10');
  await page.waitForTimeout(400);
  const projecao = await page.locator('#projecao-resumo').innerText();
  ok(/Em 10 anos/.test(projecao) && /por mês/.test(projecao), `a projeção se resume em palavras: "${projecao.slice(0, 90)}…"`);
  ok(await page.locator('#g-patrimonio svg path[data-camada="aportado"]').count() === 1, 'o patrimônio separa o que saiu do bolso');
  const pontos = await page.locator('#g-renda-futura svg circle').count();
  ok(pontos === 10, `um ponto por ano na renda projetada: ${pontos}`);
  await page.uncheck('#p-reinvestir');
  await page.waitForTimeout(400);
  const semReinvestir = await page.locator('#projecao-resumo').innerText();
  ok(semReinvestir !== projecao, 'desligar o reinvestimento muda a projeção');
  await page.check('#p-reinvestir');
  await page.waitForTimeout(300);

  // 7. Simulação de compra: soma ao que já existe, não substitui
  await page.click('#btn-simular');
  await page.waitForTimeout(200);
  await page.fill('#tabela-posicoes tr[data-id="a1"] input[data-campo="simulacaoQtd"]', '300');
  await page.waitForTimeout(400);
  const simulacao = (await page.locator('#simulacao-resumo').innerText()).replace(/\n+/g, ' ');
  ok(/R\$ 6\.930,00/.test(simulacao), `custo da compra a preço de hoje: "${simulacao.slice(0, 120)}"`);
  ok(/R\$ 135,14.*R\$ 189,64/s.test(simulacao), `renda antes → depois: "${simulacao}"`);
  ok(/muda em <?\s?R\$ 54,50/.test(simulacao) || /R\$ 54,50/.test(simulacao), 'a diferença aparece em reais');
  ok((await page.locator('#tabela-posicoes tr[data-id="a1"] input[data-campo="quantidade"]').inputValue()) === '300',
    'a posição real continua intacta durante a simulação');
  const extra = await page.locator('#g-renda svg rect[data-extra]').count();
  ok(extra === 1, `a compra simulada aparece empilhada no gráfico: ${extra}`);

  await page.click('#btn-simular');
  await page.waitForTimeout(200);
  ok(await page.locator('#simulacao-resumo').isHidden(), 'desligar a simulação some com o painel');

  // 8. Persistência e independência do preço-teto
  await page.reload();
  await page.waitForSelector('#tabela-posicoes tbody tr');
  await page.waitForTimeout(300);
  ok((await page.locator('#tabela-posicoes tr[data-id="a1"] input[data-campo="quantidade"]').inputValue()) === '300',
    'a posição continua salva depois de recarregar');
  const vereditos = await page.locator('#tabela tbody [data-saida="veredito"]').allInnerTexts();
  ok(vereditos.every((v) => /SIM|NÃO/.test(v)), `a tabela de premissas não foi afetada: ${vereditos.join(', ')}`);

  // 9. Carteira sem nenhuma posição: convida em vez de mostrar R$ 0,00
  await page.evaluate(() => {
    const estado = JSON.parse(localStorage.getItem('precoteto.v1'));
    estado.ativos = estado.ativos.map(({ quantidade, precoMedio, simulacaoQtd, ...resto }) => resto);
    localStorage.setItem('precoteto.v1', JSON.stringify(estado));
  });
  await page.reload();
  await page.waitForSelector('#tabela-posicoes tbody tr');
  await page.waitForTimeout(300);
  ok((await cartao(1)).includes('—'), `sem posição, valor de hoje é travessão e não R$ 0,00: ${await cartao(1)}`);
  ok(/Nenhuma posição informada/.test(await page.locator('#totais-nota').innerText()), 'a tela explica o que fazer');
  ok(/Preencha a quantidade/.test(await page.locator('#g-composicao').innerText()), 'o gráfico vazio convida em vez de desenhar nada');

  ok(erros.length === 0, `sem erros de JS (${erros.join(' | ') || 'nenhum'})`);
  await page.screenshot({ path: process.env.SCREENSHOT_DIR ? `${process.env.SCREENSHOT_DIR}/carteira.png` : '/tmp/carteira-e2e.png' });
} finally {
  await browser.close();
}

console.log(falhas ? `\n${falhas} verificação(ões) falharam` : '\nA tela "Minha carteira" funciona de ponta a ponta');
process.exit(falhas ? 1 : 0);
