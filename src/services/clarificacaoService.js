const { formasFarmaceuticas } = require('../../similarity');

const REGEX_CONCENTRACAO = /\b\d+(?:[.,]\d+)?\s?(?:mg|mcg|g|ui)(?:\s*\/\s*(?:\d+(?:[.,]\d+)?\s*)?(?:ml|g|ui))?/gi;
const REGEX_VOLUME = /\b\d+(?:[.,]\d+)?\s?(?:ml|g)\b/gi;
const REGEX_QUANTIDADE = /\b\d+\s?(?:cp|cps|comp|comprimidos?|caps|capsulas?|drg|drageas?)\b/gi;

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
  const volumes = extrairMatches(descricao, REGEX_VOLUME);
  const quantidades = extrairMatches(descricao, REGEX_QUANTIDADE);
  const formas = extrairFormas(descricao);
  const apresentacoes = [...new Set([...volumes, ...quantidades])];

  return {
    concentracoes,
    formas,
    apresentacoes
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
      pergunta: 'Encontrei mais de uma concentracao. Qual voce procura?',
      opcoes
    };
  }

  if (tipo === 'forma_farmaceutica') {
    return {
      tipo,
      pergunta: 'Encontrei mais de uma forma farmaceutica. Qual voce prefere?',
      opcoes
    };
  }

  return {
    tipo: 'apresentacao',
    pergunta: 'Encontrei mais de uma apresentacao (volume/quantidade). Qual voce prefere?',
    opcoes
  };
}

function analisarNecessidadeDeClarificacao({ query, produtos }) {
  if (!Array.isArray(produtos) || produtos.length < 2) {
    return {
      precisa_clarificar: false,
      tipo: null,
      pergunta: null,
      opcoes: []
    };
  }

  const queryTexto = String(query || '');
  const queryConcentracoes = extrairMatches(queryTexto, REGEX_CONCENTRACAO);
  const queryFormas = extrairFormas(queryTexto);
  const queryApresentacoes = [...new Set([
    ...extrairMatches(queryTexto, REGEX_VOLUME),
    ...extrairMatches(queryTexto, REGEX_QUANTIDADE)
  ])];

  const produtosEnriquecidos = produtos.map(produto => ({
    ...produto,
    atributos_busca: extrairAtributosProduto(produto)
  }));

  const concentracoes = contarOcorrencias(produtosEnriquecidos, p => p.atributos_busca.concentracoes);
  const formas = contarOcorrencias(produtosEnriquecidos, p => p.atributos_busca.formas);
  const apresentacoes = contarOcorrencias(produtosEnriquecidos, p => p.atributos_busca.apresentacoes);

  if (concentracoes.length > 1 && queryConcentracoes.length === 0) {
    return {
      precisa_clarificar: true,
      ...resumoClarificacao('concentracao', concentracoes.slice(0, 5))
    };
  }

  if (formas.length > 1 && queryFormas.length === 0) {
    return {
      precisa_clarificar: true,
      ...resumoClarificacao('forma_farmaceutica', formas.slice(0, 5))
    };
  }

  if (apresentacoes.length > 1 && queryApresentacoes.length === 0) {
    return {
      precisa_clarificar: true,
      ...resumoClarificacao('apresentacao', apresentacoes.slice(0, 5))
    };
  }

  return {
    precisa_clarificar: false,
    tipo: null,
    pergunta: null,
    opcoes: []
  };
}

module.exports = {
  analisarNecessidadeDeClarificacao
};
