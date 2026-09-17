# Preço-teto e margem de segurança (B3)

Ferramenta de uso próprio para responder, em poucos minutos por mês, uma pergunta só:
**o preço de hoje está abaixo do preço máximo que eu aceito pagar por esse ativo?**

Duas formas de rodar, sem build e sem dependência:

```bash
npm start   # http://localhost:8787 — recomendado: cotação automática funciona
```

ou abra o `index.html` direto no navegador (duplo clique), que faz tudo menos a
busca automática de cotações. Em ambos os casos os dados ficam salvos na sua
máquina, no `localStorage` do navegador.

O `npm start` sobe `tools/servidor.mjs`, que entrega o app **e** consulta a brapi
pelo lado do servidor. Isso existe por um motivo concreto: chamada à brapi feita
de dentro do navegador é barrada por CORS quando a página vem de `file://` e
também na página publicada como artifact, que não tem permissão de rede. Do
servidor, a chamada sai normalmente — e o token fica na variável de ambiente, sem
nunca chegar ao navegador:

```bash
BRAPI_TOKEN=seu_token npm start
```

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

A busca acontece no seu navegador, direto na [brapi.dev](https://brapi.dev). O que
cada plano cobre muda o que o botão consegue preencher:

| Dado | Plano gratuito da brapi |
| --- | --- |
| Cotação | ✅ sim (15.000 requisições/mês, com token) |
| Nome e setor | ✅ sim |
| LPA (`defaultKeyStatistics`) | ❌ plano pago |
| Histórico de dividendos | ❌ plano pago |
| Tudo, em PETR4, MGLU3, VALE3 e ITUB4 | ✅ sim, e sem token — servem para testar |

Por isso a caixa **buscar também LPA e dividendos** vem desmarcada. Quando marcada e
o plano não cobrir, o app **refaz a chamada só com o preço**, atualiza a cotação e
avisa na tela — pedir módulo pago derrubaria a requisição inteira, cotação incluída.

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
# com fundamentos (plano pago): acrescente --fundamentos
# ou: BRAPI_TOKEN=... node tools/atualizar-cotacoes.mjs carteira.json
```

Depois importe o arquivo de volta pelo botão **⬆ Importar**.

## Não está atualizando? Rode o diagnóstico

O botão **🔌 Testar conexão** faz quatro chamadas e diz exatamente onde parou
(o token nunca aparece no relatório):

| Etapa | O que isola |
| --- | --- |
| Servidor local | se o app está sendo servido por `npm start` (aí nem precisa do resto) |
| Rede: PETR4 sem token | se a chamada consegue sair do navegador |
| Token na URL (`?token=`) | se o token é aceito como parâmetro |
| Token no header (`Bearer`) | se o token é aceito como cabeçalho |
| Fundamentos | se o plano cobre LPA e dividendos |

Causas mais comuns, em ordem:

1. **🚫 na linha de rede: o navegador barrou a chamada antes de sair.** Acontece na
   página publicada (as capacidades de um artifact são `artifact`, `assets`,
   `comments`, `db`, `downloads`, `mcp`, `room`, `sample`, `self` e `user` —
   **nenhuma é acesso HTTP livre**) e também com `file://`, quando o CORS da API
   recusa a origem. **Solução:** `npm start` e abra `http://localhost:8787`; aí a
   consulta sai do servidor e o app mostra "via servidor local" no status.
2. **Forma de autenticação.** A brapi documenta `Authorization: Bearer SEU_TOKEN`,
   mas o parâmetro `?token=` também funciona e não dispara preflight de CORS. O app
   tenta a URL primeiro e, se levar 401, **repete a chamada com o header** — e avisa
   qual caminho funcionou.
3. **Plano sem fundamentos.** HTTP 403 só na quarta etapa: cotação atualiza, LPA e
   dividendos não.
4. **Ticker fora do padrão da B3.** Só `AAAA9`/`AAAA11` entram na consulta; a linha
   `EXEMPLO` é ignorada de propósito.

## De onde vêm os dados "corretos"

Cada coluna tem um grau diferente de disponibilidade pública:

| Informação | Onde obter | Situação |
| --- | --- | --- |
| Cotação | brapi (grátis), HG Brasil, bolsai | resolvido |
| LPA / lucro dos últimos 12 meses | CVM (fonte oficial), bolsai, brapi pago, Partnr | disponível, exige plano ou processar CSV |
| Nº de ações e proventos pagos | CVM (composição do capital), B3, bolsai | disponível |
| Payout | derivável: proventos ÷ lucro do mesmo período | calculável, não é campo de API |
| **Lucro projetado** | consenso de analistas (Refinitiv, Bloomberg, corretoras) | **não existe grátis — é premissa sua** |

A fonte primária e gratuita de tudo que é histórico é a própria CVM
([dados.cvm.gov.br](https://dados.cvm.gov.br/dataset/cia_aberta-doc-dfp) — DFP e ITR
em CSV, com lucro líquido e composição do capital). As APIs comerciais desta tabela
são, na prática, essa base da CVM já limpa e indexada por ticker.

O Yahoo Finance não serve para este app: a API é não oficial e exige cookie/crumb,
o que não funciona a partir do navegador ([referência](https://github.com/gadicc/yahoo-finance2/issues/764)).

## Formatos aceitos nos campos

Digite como for mais natural — o app entende formato brasileiro e atalhos de escala:

`5.102.000.000,00` · `5,102 bi` · `22bi` · `340 mi` · `1.152.254.440` · `20,56` · `85%`

## Testes

```bash
npm test          # 55 testes de cálculo, cotação e servidor (node puro, sem dependências)
npm run test:ui   # 48 verificações de interface (inclui o fluxo pelo servidor) com Chromium (precisa de playwright-core)
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
tools/servidor.mjs            servidor local + proxy da brapi (npm start)
tools/atualizar-cotacoes.mjs  atualizador de preços por linha de comando
tools/captura.mjs             gera a captura de tela do README
test/                         testes de cálculo, de cotação e de interface
```

## Aviso

Isto é uma calculadora, não uma recomendação de investimento. O resultado vale
exatamente o que valem as premissas que você digitou: lucro projetado, payout e
yield aceitável são escolhas suas, e preço-teto não diz nada sobre a qualidade ou
o risco do negócio.
