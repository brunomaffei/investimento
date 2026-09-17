# Preço-teto e margem de segurança (B3)

Ferramenta de uso próprio para responder, em poucos minutos por mês, uma pergunta só:
**o preço de hoje está abaixo do preço máximo que eu aceito pagar por esse ativo?**

Roda como página estática: sem servidor, sem build, sem dependência. Abra o
`index.html` no navegador (duplo clique já funciona) e tudo fica salvo na
própria máquina, no `localStorage`.

![Tela do app](docs/tela.png)

## A conta

| Passo | Fórmula | Exemplo |
| --- | --- | --- |
| LPA (lucro por ação) | lucro projetado ÷ quantidade de ações | 4,233 bi ÷ 1.152.254.440 = **R$ 3,67** |
| DPA (dividendo por ação) | LPA × payout | 3,67 × 70% = **R$ 2,57** |
| Preço-teto | DPA ÷ yield aceitável | 2,57 ÷ 6% = **R$ 42,86** |
| Margem de segurança | (preço-teto ÷ cotação) − 1 | 42,86 ÷ 45,14 − 1 = **−5,05%** |
| Comprar? | margem ≥ margem mínima exigida | −5,05% < 0% → **NÃO** |

É o método de Décio Bazin: se o dividendo esperado por ação não paga o yield
que você exige, o papel está caro para você — por melhor que a empresa seja.

### Três formas de chegar ao dividendo

Escolha por ativo, na coluna **Base**:

- **Lucro projetado** — lucro do ano + quantidade de ações + payout. É o caminho
  mais trabalhoso e o mais transparente: cada premissa fica à vista.
- **LPA direto** — você já tem o lucro por ação; informe LPA e payout. O botão
  *Atualizar cotações* preenche o LPA (últimos 12 meses) automaticamente.
- **Dividendo (DPA)** — informe o provento anual direto. É o modo indicado para
  FIIs (dividendo mensal × 12) e mostra o payout implícito quando há LPA.

### Os dois botões de decisão

- **Yield aceitável padrão** — o retorno em dividendos que você exige. 6% a.a. é o
  corte clássico do Bazin; use valores próprios por ativo quando o risco mudar.
- **Margem de segurança mínima** — exige um desconto adicional sobre o teto.
  Com 20%, um ativo de teto R$ 110 só recebe **SIM** abaixo de R$ 91,67
  (o app mostra esse "pagar até" embaixo do preço-teto).

## Rotina mensal sugerida

1. Clique em **↻ Atualizar cotações** (preço, setor e LPA vêm da [brapi.dev](https://brapi.dev)).
2. Revise payout e lucro projetado dos ativos que divulgaram balanço no mês.
3. Ordene pela coluna **Margem de seg.** e marque *mostrar só os SIM*.
4. Exporte o **CSV** se quiser guardar o histórico da decisão daquele mês.

## Cotação automática

A busca acontece no seu navegador, direto na brapi.dev. O plano gratuito pede um
token: crie em [brapi.dev/dashboard](https://brapi.dev/dashboard) e cole no campo
*Token brapi.dev*. Ele fica salvo somente no seu navegador e nunca é enviado para
outro lugar.

Regras da atualização automática:

- a **cotação** é sempre sobrescrita (é dado de mercado);
- **LPA, DPA, nome e setor** só são preenchidos se o campo estiver vazio — uma
  premissa sua nunca é apagada pela API;
- tickers fora do padrão da B3 (`PETR4`, `TAEE11`) são ignorados na consulta,
  então a linha `EXEMPLO` não gera erro.

Sem token, sem internet ou fora do horário de mercado, digite o preço à mão: o
campo *Cotação* é editável e a etiqueta `auto` desaparece quando você edita.

Se preferir o terminal, exporte o JSON e rode:

```bash
node tools/atualizar-cotacoes.mjs carteira-preco-teto-2026-09-17.json --token SEU_TOKEN
# ou: BRAPI_TOKEN=... node tools/atualizar-cotacoes.mjs carteira.json
```

Depois importe o arquivo de volta pelo botão **⬆ Importar**.

## Formatos aceitos nos campos

Digite como for mais natural — o app entende formato brasileiro e atalhos de escala:

`5.102.000.000,00` · `5,102 bi` · `22bi` · `340 mi` · `1.152.254.440` · `20,56` · `85%`

## Testes

```bash
npm test          # 20 testes do núcleo de cálculo (node puro, sem dependências)
npm run test:ui   # 34 verificações na interface com Chromium (precisa de playwright-core)
```

Os testes de cálculo conferem as linhas da planilha que serviu de referência,
reproduzindo preço-teto e margem na casa do centavo (−5,05%, +23,82%, +8,67%).

## Publicar (opcional)

Como é só HTML/CSS/JS estático, dá para servir no GitHub Pages: em
*Settings → Pages*, escolha a branch e a pasta raiz. Nenhum dado seu vai para o
repositório — a carteira mora no `localStorage` do navegador.

## Estrutura

```
index.html                    página única
assets/calc.js                LPA, DPA, preço-teto, margem, veredito (testado)
assets/quotes.js              integração com a brapi.dev
assets/app.js                 tabela editável, ordenação, import/export
assets/seed.js                carteira e configuração iniciais
assets/styles.css             tema escuro, responsivo
tools/atualizar-cotacoes.mjs  atualizador de preços por linha de comando
tools/captura.mjs             gera a captura de tela do README
test/                         testes de cálculo e de interface
```

## Aviso

Isto é uma calculadora, não uma recomendação de investimento. O resultado vale
exatamente o que valem as premissas que você digitou: lucro projetado, payout e
yield aceitável são escolhas suas, e preço-teto não diz nada sobre a qualidade ou
o risco do negócio.
