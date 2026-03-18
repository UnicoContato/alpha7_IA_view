const { formasFarmaceuticas } = require('../../similarity');

const REGEX_CONCENTRACAO = /\b\d+(?:[.,]\d+)?\s?(?:mg|mcg|g|ui)(?:\s*\/\s*(?:\d+(?:[.,]\d+)?\s*)?(?:ml|g|ui))?/gi;
const MAX_PERGUNTAS = 2;
const MAX_PRODUTOS_ANALISADOS = 12;

function normalizarTexto(valor) {
  return String(valor || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizarOpcao(valor) {
  return String(valor || '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function extrairMatches(texto, regex) {
  const entrada = String(texto || '');
  const matches = entrada.match(regex) || [];
  return [...new Set(matches.map(normalizarOpcao).filter(Boolean))];
}

function criarLookupFormas() {
  const lookup = [];

  Object.entries(formasFarmaceuticas || {}).forEach(([formaCanonica, variacoes]) => {
    const forma = normalizarTexto(formaCanonica);
    if (forma) {
      lookup.push({ token: forma, formaCanonica: formaCanonica.toUpperCase() });
    }

    (variacoes || []).forEach(variacao => {
      const token = normalizarTexto(variacao);
      if (token && token.length > 1) {
        lookup.push({ token, formaCanonica: formaCanonica.toUpperCase() });
      }
    });
  });

  return lookup;
}

const FORMAS_LOOKUP = criarLookupFormas();

function extrairFormas(texto) {
  const descricao = normalizarTexto(texto);
  if (!descricao) return [];

  const formas = new Set();
  FORMAS_LOOKUP.forEach(item => {
    const regex = new RegExp(`(^|\\s)${item.token}(\\s|$)`, 'i');
    if (regex.test(descricao)) {
      formas.add(item.formaCanonica);
    }
  });

  return [...formas];
}

function extrairAtributosProduto(produto) {
  const descricao = produto?.descricao || '';

  const concentracoes = extrairMatches(descricao, REGEX_CONCENTRACAO);
  const formas = extrairFormas(descricao);

  return {
    concentracoes,
    formas
  };
}

function contarOcorrencias(produtos, seletor) {
  const contador = new Map();

  produtos.forEach(produto => {
    const valores = seletor(produto);
    valores.forEach(valor => {
      contador.set(valor, (contador.get(valor) || 0) + 1);
    });
  });

  return [...contador.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([valor]) => valor);
}

function resumoClarificacao(tipo, opcoes) {
  if (tipo === 'concentracao') {
    return {
      tipo,
      label: 'Concentracao',
      pergunta: 'Encontrei mais de uma concentracao. Qual voce procura?',
      opcoes
    };
  }

  return {
    tipo: 'forma_farmaceutica',
    label: 'Forma farmaceutica',
    pergunta: 'Encontrei mais de uma forma farmaceutica. Qual voce prefere?',
    opcoes
  };
}

function montarPerguntaComposta(perguntas) {
  if (perguntas.length === 1) {
    return perguntas[0].pergunta;
  }

  const linhas = ['Para te indicar com precisao, preciso de 2 confirmacoes:'];
  perguntas.forEach((pergunta, index) => {
    linhas.push(`${index + 1}) ${pergunta.pergunta}`);
    pergunta.opcoes.forEach(opcao => {
      linhas.push(`- ${pergunta.label}: ${opcao}`);
    });
  });

  return linhas.join('\n');
}

function scoreDeRelevancia(produto) {
  const score = Number(produto?.relevancia_score ?? produto?.relevancia_descricao ?? 0);
  return Number.isFinite(score) ? score : 0;
}

function selecionarProdutosParaClarificacao(produtos) {
  const lista = Array.isArray(produtos) ? produtos : [];
  const produtosComScore = lista.filter(produto => scoreDeRelevancia(produto) > 0);

  if (produtosComScore.length >= 2) {
    return produtosComScore.slice(0, MAX_PRODUTOS_ANALISADOS);
  }

  return lista.slice(0, MAX_PRODUTOS_ANALISADOS);
}

function analisarNecessidadeDeClarificacao({ query, produtos }) {
  const produtosBase = selecionarProdutosParaClarificacao(produtos);

  if (produtosBase.length < 2) {
    return {
      precisa_clarificar: false,
      tipo: null,
      pergunta: null,
      opcoes: [],
      total_produtos_analisados: produtosBase.length
    };
  }

  const queryTexto = String(query || '');
  const queryConcentracoes = extrairMatches(queryTexto, REGEX_CONCENTRACAO);
  const queryFormas = extrairFormas(queryTexto);

  const produtosEnriquecidos = produtosBase.map(produto => ({
    ...produto,
    atributos_busca: extrairAtributosProduto(produto)
  }));

  const concentracoes = contarOcorrencias(produtosEnriquecidos, p => p.atributos_busca.concentracoes);
  const formas = contarOcorrencias(produtosEnriquecidos, p => p.atributos_busca.formas);

  const perguntasPendentes = [];

  if (formas.length > 1 && queryFormas.length === 0) {
    perguntasPendentes.push(resumoClarificacao('forma_farmaceutica', formas.slice(0, 5)));
  }

  if (concentracoes.length > 1 && queryConcentracoes.length === 0) {
    perguntasPendentes.push(resumoClarificacao('concentracao', concentracoes.slice(0, 5)));
  }

  const perguntas = perguntasPendentes.slice(0, MAX_PERGUNTAS);
  if (perguntas.length > 0) {
    const opcoesCompostas = [];
    perguntas.forEach(pergunta => {
      pergunta.opcoes.forEach(opcao => {
        opcoesCompostas.push(`${pergunta.label}: ${opcao}`);
      });
    });

    return {
      precisa_clarificar: true,
      tipo: perguntas[0].tipo,
      pergunta: montarPerguntaComposta(perguntas),
      opcoes: opcoesCompostas,
      perguntas,
      total_perguntas: perguntas.length,
      total_produtos_analisados: produtosBase.length
    };
  }

  return {
    precisa_clarificar: false,
    tipo: null,
    pergunta: null,
    opcoes: [],
    perguntas: [],
    total_perguntas: 0,
    total_produtos_analisados: produtosBase.length
  };
}

module.exports = {
  analisarNecessidadeDeClarificacao
};
