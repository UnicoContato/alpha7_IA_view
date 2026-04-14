const { formasFarmaceuticas } = require('../../similarity');

const STOPWORDS_COMPARACAO = new Set([
  'com',
  'da',
  'das',
  'de',
  'do',
  'dos',
  'e',
  'em',
  'na',
  'nas',
  'no',
  'nos',
  'para',
  'por'
]);
const REGEX_TERMO_COMPOSTO = /\b(composto|composta|associado|associada|combinado|combinada|plus)\b/i;

function normalizarTexto(valor) {
  return String(valor || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9+\s/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(valor) {
  return String(valor || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function montarRegexFrase(termo) {
  const termoNormalizado = normalizarTexto(termo);
  if (!termoNormalizado) {
    return null;
  }

  const fragmento = escapeRegex(termoNormalizado).replace(/\s+/g, '\\s+');
  return new RegExp(`(^|\\s)${fragmento}(\\s|$)`, 'i');
}

function contemFrase(texto, termo) {
  const regex = montarRegexFrase(termo);
  if (!regex) {
    return false;
  }

  return regex.test(normalizarTexto(texto));
}

function tokenizarComparacao(valor) {
  return normalizarTexto(valor)
    .replace(/[+/]/g, ' ')
    .split(' ')
    .filter(Boolean)
    .filter(token => !STOPWORDS_COMPARACAO.has(token));
}

function ehBuscaComposta(termo) {
  const texto = String(termo || '');
  return REGEX_TERMO_COMPOSTO.test(texto) || /[+/]/.test(texto);
}

function extrairFormaFarmaceutica(termo) {
  let principioAtivoBusca = termo;
  let formaFarmaceutica = null;
  let variacoesForma = [];

  for (const [forma, variacoes] of Object.entries(formasFarmaceuticas)) {
    for (const variacao of variacoes) {
      const regex = new RegExp(`\\b${escapeRegex(variacao)}\\b`, 'i');
      if (regex.test(termo)) {
        formaFarmaceutica = forma;
        variacoesForma = variacoes;
        principioAtivoBusca = termo.replace(regex, '').trim();

        principioAtivoBusca = principioAtivoBusca
          .replace(/\b(em|de|da|do|das|dos|na|no|nas|nos|com|para|por)\b/gi, '')
          .replace(/\s+/g, ' ')
          .trim();

        break;
      }
    }
    if (formaFarmaceutica) break;
  }

  return { principioAtivoBusca: principioAtivoBusca || termo, formaFarmaceutica, variacoesForma };
}

function descricaoCombinaComTermoBusca(descricao, termoBusca) {
  return contemFrase(descricao, termoBusca);
}

function principioAtivoCombinaComBusca(principioAtivo, termoBusca) {
  const tokensBusca = tokenizarComparacao(termoBusca);
  const tokensPrincipio = tokenizarComparacao(principioAtivo);

  if (tokensBusca.length === 0 || tokensPrincipio.length === 0) {
    return false;
  }

  return contemFrase(principioAtivo, termoBusca) || tokensBusca.every(token => tokensPrincipio.includes(token));
}

function classificarTipoBusca({ termoBusca, principioAtivoBusca, produtosDescricao, principiosEncontrados }) {
  const termoReferencia = principioAtivoBusca || termoBusca;
  const listaDescricao = Array.isArray(produtosDescricao) ? produtosDescricao : [];
  const listaPrincipios = Array.isArray(principiosEncontrados) ? principiosEncontrados : [];

  if (listaPrincipios.some(principio => principioAtivoCombinaComBusca(principio?.nome, termoReferencia))) {
    return ehBuscaComposta(termoReferencia) ? 'principio_ativo_composto' : 'principio_ativo_simples';
  }

  if (listaDescricao.some(produto => descricaoCombinaComTermoBusca(produto?.descricao, termoReferencia))) {
    return 'marca';
  }

  if (ehBuscaComposta(termoReferencia)) {
    return 'principio_ativo_composto';
  }

  return 'indefinido';
}

function produtoTemMultiplosPrincipios(produto) {
  const principioAtivo = normalizarTexto(produto?.principioativo_nome);
  if (!principioAtivo) {
    return false;
  }

  return principioAtivo.includes('+') || /\b e \b/.test(principioAtivo);
}

function produtoCombinaComPrincipioSimples(produto, principioAtivoBusca, termoBusca) {
  const principioBusca = principioAtivoBusca || termoBusca;
  if (!normalizarTexto(principioBusca)) {
    return true;
  }

  const contemPrincipioBusca = principioAtivoCombinaComBusca(produto?.principioativo_nome, principioBusca);
  const contemDescricaoBusca = descricaoCombinaComTermoBusca(produto?.descricao, principioBusca);
  const buscaComposta = ehBuscaComposta(termoBusca || principioBusca);

  if (!contemPrincipioBusca && !contemDescricaoBusca) {
    return false;
  }

  if (!buscaComposta && produtoTemMultiplosPrincipios(produto)) {
    return false;
  }

  return true;
}

function classificarRelacaoBuscaDeterministica(produto, contextoBusca) {
  const tipoBusca = contextoBusca?.tipoBusca || 'indefinido';
  const termoNominalBusca = contextoBusca?.termoNominalBusca || contextoBusca?.principioAtivoBusca || contextoBusca?.termoBusca || '';
  const principioAtivoBusca = contextoBusca?.principioAtivoBusca || termoNominalBusca;
  const matchDescricao = descricaoCombinaComTermoBusca(produto?.descricao, termoNominalBusca);
  const matchPrincipio = principioAtivoCombinaComBusca(produto?.principioativo_nome, principioAtivoBusca);

  if (tipoBusca === 'marca') {
    if (matchDescricao) {
      return {
        relacionado_busca: true,
        tipo_relacao_busca: 'marca_direta',
        motivo_relacao_busca: 'match_exato_descricao'
      };
    }

    if (produto?.origem === 'principio_ativo') {
      return {
        relacionado_busca: false,
        tipo_relacao_busca: 'alternativa_mesmo_principio_ativo',
        motivo_relacao_busca: 'expandido_por_principio_ativo'
      };
    }

    return {
      relacionado_busca: false,
      tipo_relacao_busca: 'nao_relacionado',
      motivo_relacao_busca: 'marca_sem_match_textual'
    };
  }

  if (tipoBusca === 'principio_ativo_simples') {
    if (!produtoCombinaComPrincipioSimples(produto, principioAtivoBusca, termoNominalBusca)) {
      return {
        relacionado_busca: false,
        tipo_relacao_busca: 'nao_relacionado_composto',
        motivo_relacao_busca: 'principio_ativo_composto_ou_divergente'
      };
    }

    if (matchPrincipio || descricaoCombinaComTermoBusca(produto?.descricao, principioAtivoBusca)) {
      return {
        relacionado_busca: true,
        tipo_relacao_busca: 'principio_ativo_direto',
        motivo_relacao_busca: 'match_principio_ativo'
      };
    }
  }

  if (tipoBusca === 'principio_ativo_composto') {
    if (matchPrincipio || descricaoCombinaComTermoBusca(produto?.descricao, principioAtivoBusca)) {
      return {
        relacionado_busca: true,
        tipo_relacao_busca: 'principio_ativo_direto',
        motivo_relacao_busca: 'match_principio_ativo_composto'
      };
    }
  }

  if (matchDescricao) {
    return {
      relacionado_busca: true,
      tipo_relacao_busca: 'descricao_direta',
      motivo_relacao_busca: 'match_descricao'
    };
  }

  return null;
}

module.exports = {
  classificarRelacaoBuscaDeterministica,
  classificarTipoBusca,
  descricaoCombinaComTermoBusca,
  ehBuscaComposta,
  extrairFormaFarmaceutica,
  normalizarTexto,
  principioAtivoCombinaComBusca,
  produtoCombinaComPrincipioSimples,
  produtoTemMultiplosPrincipios
};
