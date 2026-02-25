const TERMOS_REFERENCIA = /\b(referencia|referencia|etico|etica|marca)\b/i;
const TERMOS_GENERICO = /\b(generico|genericos|gen)\b/i;
const TERMOS_SIMILAR = /\b(similar|similares)\b/i;
const TERMOS_PERFUMARIA = /\b(shampoo|condicionador|sabonete|hidratante|desodorante|perfume|creme|protetor|fralda|absorvente|escova|pasta)\b/i;

function formatarMoeda(valor) {
  if (valor === null || valor === undefined || Number.isNaN(Number(valor))) {
    return null;
  }

  return Number(valor).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  });
}

function extrairPrecos(produto) {
  const precoPor =
    produto?.precos?.preco_final_venda ??
    produto?.precos?.preco_com_desconto ??
    produto?.precos?.preco_venda_loja ??
    produto?.precos?.preco_venda_geral ??
    null;

  const precoDe =
    produto?.precos?.preco_sem_desconto ??
    produto?.precos?.preco_venda_geral ??
    produto?.precos?.preco_referencial_geral ??
    null;

  let desconto = null;
  if (precoDe && precoPor && Number(precoDe) > Number(precoPor)) {
    desconto = Math.round(((Number(precoDe) - Number(precoPor)) / Number(precoDe)) * 100);
  }

  return {
    precoDe,
    precoPor,
    desconto,
    precoDeFormatado: formatarMoeda(precoDe),
    precoPorFormatado: formatarMoeda(precoPor)
  };
}

function getProdutoPrincipal(produtos, tipo) {
  return produtos.find(p => p.tipo_classificacao === tipo);
}

function getTopProdutos(produtos, tipo, limite) {
  return produtos.filter(p => p.tipo_classificacao === tipo).slice(0, limite);
}

function detectarIntencao(query) {
  const texto = String(query || '').toLowerCase();

  return {
    querReferencia: TERMOS_REFERENCIA.test(texto),
    querGenerico: TERMOS_GENERICO.test(texto),
    querSimilar: TERMOS_SIMILAR.test(texto),
    querPerfumaria: TERMOS_PERFUMARIA.test(texto)
  };
}

function ehPerfumaria(produtos, query) {
  if (detectarIntencao(query).querPerfumaria) {
    return true;
  }

  if (!produtos.length) {
    return false;
  }

  const semClassificacao = produtos.every(p => !p.tipo_classificacao);
  const semPrincipioAtivo = produtos.every(p => !p.principio_ativo);
  return semClassificacao && semPrincipioAtivo;
}

function montarCenario1(produtos) {
  const referencia = getProdutoPrincipal(produtos, 'REFERENCIA') || produtos[0];
  const genericos = getTopProdutos(produtos, 'GENERICO', 2);
  const precos = extrairPrecos(referencia);

  const mensagem = [
    `Ola! Verifiquei no sistema e temos o *${referencia.descricao} (Referencia)* disponivel.`,
    `${precos.precoPorFormatado ? `Preco especial: de ~~${precos.precoDeFormatado || precos.precoPorFormatado}~~ por *${precos.precoPorFormatado}*${precos.desconto ? ` (${precos.desconto}% de desconto)` : ''}.` : ''}`,
    'Além do referencia, voce gostaria de ver opcoes de Genericos ou Similares? Eles costumam ser mais economicos.'
  ].filter(Boolean).join('\n');

  return {
    scenario_id: 'SC1_REFERENCIA_ETICO',
    mensagem,
    follow_up_sim: genericos.length > 0
      ? `Otimo! Temos estas opcoes:\n${genericos.map(g => {
        const p = extrairPrecos(g);
        return `*${g.descricao}:* de ~~${p.precoDeFormatado || p.precoPorFormatado || '-'}~~ por *${p.precoPorFormatado || '-'}*`;
      }).join('\n')}`
      : 'Otimo! Posso te mostrar as opcoes de generico e similar disponiveis agora.',
    follow_up_nao: 'Entendido! Mantemos o de referencia. Deseja fechar o pedido ou precisa de mais alguma coisa?'
  };
}

function montarCenario2(produtos, termoBusca) {
  const referencia = getProdutoPrincipal(produtos, 'REFERENCIA');
  const genericos = getTopProdutos(produtos, 'GENERICO', 2);

  const linhasReferencia = referencia
    ? [`Opcao de referencia:`, `*${referencia.descricao}:* ${extrairPrecos(referencia).precoPorFormatado || '-'}`]
    : ['Opcao de referencia: indisponivel no momento.'];

  const linhasGenericos = genericos.length > 0
    ? genericos.map(g => {
      const p = extrairPrecos(g);
      return `*${g.descricao}:* de ~~${p.precoDeFormatado || p.precoPorFormatado || '-'}~~ por *${p.precoPorFormatado || '-'}*`;
    })
    : ['Nao localizei genericos com estoque no momento.'];

  return {
    scenario_id: 'SC2_PRINCIPIO_ATIVO_OU_GENERICO',
    mensagem: [
      `Temos sim! Localizei opcoes para *${termoBusca}*:`,
      ...linhasReferencia,
      '',
      'Opcoes genericas (mais economicas):',
      ...linhasGenericos,
      '',
      'Qual opcao eu separo para voce?'
    ].join('\n')
  };
}

function montarCenario3(produtos) {
  const similar = getProdutoPrincipal(produtos, 'SIMILAR') || produtos[0];
  const p = extrairPrecos(similar);

  return {
    scenario_id: 'SC3_SIMILAR_NOME_ESPECIFICO',
    mensagem: [
      `Verifiquei agora e temos o *${similar.descricao}* em estoque.`,
      `${p.precoDeFormatado ? `De: ${p.precoDeFormatado}` : ''}`,
      `${p.precoPorFormatado ? `Por: *${p.precoPorFormatado}*` : ''}`,
      `${p.desconto ? `(Voce economiza ${p.desconto}% hoje.)` : ''}`,
      'Posso adicionar este item ao seu pedido?'
    ].filter(Boolean).join('\n')
  };
}

function montarCenario4(produtos, termoBusca) {
  const principal = produtos[0];
  const opcoes = produtos.slice(1, 3);
  const p = extrairPrecos(principal);

  return {
    scenario_id: 'SC4_PERFUMARIA',
    mensagem: [
      `Temos *${principal?.descricao || termoBusca}* disponivel!`,
      `${p.precoPorFormatado ? `Sai de ~~${p.precoDeFormatado || p.precoPorFormatado}~~ por *${p.precoPorFormatado}*.` : ''}`,
      'Tambem separei outras opcoes dessa categoria:',
      ...opcoes.map(o => `*${o.descricao}:* ${extrairPrecos(o).precoPorFormatado || '-'}`),
      'Algum destes te interessa?'
    ].filter(Boolean).join('\n')
  };
}

function determinarScenario(query, produtos) {
  const intencao = detectarIntencao(query);

  if (ehPerfumaria(produtos, query)) {
    return 'SC4_PERFUMARIA';
  }

  const temReferencia = produtos.some(p => p.tipo_classificacao === 'REFERENCIA');
  const temSimilar = produtos.some(p => p.tipo_classificacao === 'SIMILAR');

  if (intencao.querSimilar && temSimilar) {
    return 'SC3_SIMILAR_NOME_ESPECIFICO';
  }

  if (intencao.querReferencia && temReferencia) {
    return 'SC1_REFERENCIA_ETICO';
  }

  if (intencao.querGenerico || !intencao.querReferencia) {
    return 'SC2_PRINCIPIO_ATIVO_OU_GENERICO';
  }

  return 'SC2_PRINCIPIO_ATIVO_OU_GENERICO';
}

function gerarMensagemAtendimento({ query, produtos }) {
  if (!produtos || produtos.length === 0) {
    return {
      scenario_id: 'SEM_RESULTADO',
      mensagem: 'Nao encontrei itens com estoque para essa busca agora. Posso verificar alternativas com o mesmo principio ativo?'
    };
  }

  const scenarioId = determinarScenario(query, produtos);

  if (scenarioId === 'SC1_REFERENCIA_ETICO') {
    return montarCenario1(produtos);
  }

  if (scenarioId === 'SC3_SIMILAR_NOME_ESPECIFICO') {
    return montarCenario3(produtos);
  }

  if (scenarioId === 'SC4_PERFUMARIA') {
    return montarCenario4(produtos, query);
  }

  return montarCenario2(produtos, query);
}

module.exports = {
  gerarMensagemAtendimento
};
