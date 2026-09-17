/** Configuração e carteira iniciais. Tudo editável na tela e salvo no navegador. */
(function (root) {
  'use strict';

  // Yield de 6% a.a. é o corte clássico do método Bazin; margem mínima 0% replica
  // a planilha de referência (compra sempre que a cotação estiver abaixo do teto).
  const CONFIG_PADRAO = {
    yieldPadrao: 6,
    margemMinima: 0,
    token: '',
    // Fundamentos (LPA e dividendos) são de plano pago na brapi; desligado por padrão.
    fundamentos: false,
    ordenarPor: 'margem',
    ordemDecrescente: true,
    somenteComprar: false,
    busca: '',
  };

  // Tickers apenas como ponto de partida — nenhuma premissa vem preenchida, porque
  // payout e lucro projetado são a SUA leitura do ativo, não um dado de mercado.
  // Clique em "Atualizar cotações" para o app trazer preço, LPA e setor de cada um.
  const CARTEIRA_INICIAL = [
    { ticker: 'BBAS3', modo: 'lpa' },
    { ticker: 'ITSA4', modo: 'lpa' },
    { ticker: 'TAEE11', modo: 'lpa' },
    { ticker: 'CPLE6', modo: 'lpa' },
    { ticker: 'VIVT3', modo: 'lpa' },
    { ticker: 'BBSE3', modo: 'lpa' },
    {
      // Linha de demonstração com os números da planilha de referência.
      // Teto = (5,102 bi / 3 bi x 85%) / 6% = R$ 24,09 -> margem de +17,2% sobre R$ 20,56.
      ticker: 'EXEMPLO',
      nome: 'Linha de exemplo — apague quando quiser',
      setor: 'Finance',
      modo: 'lucro',
      cotacao: '20,56',
      lucroProjetado: '5,102 bi',
      quantidadeAcoes: '3 bi',
      payout: '85',
      yieldAceitavel: '6',
    },
  ];

  root.Seed = { CONFIG_PADRAO, CARTEIRA_INICIAL };
})(typeof globalThis !== 'undefined' ? globalThis : this);
