const axios = require('axios');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const MAX_PRODUTOS_IA = 20;
const REGEX_TERMO_COMPOSTO = /\b(composto|composta|associado|associada|combinado|combinada|plus)\b/i;

function scoreBase(produto) {
  const score = Number(produto?.relevancia_descricao ?? 0);
  return Number.isFinite(score) ? score : 0;
}

function compactarTexto(valor, limite = 120) {
  return String(valor || '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, limite);
}

function normalizarTexto(valor) {
  return String(valor || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9+\s/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function descreverProdutoParaLog(produto) {
  if (!produto) {
    return 'produto indefinido';
  }

  return [
    `id=${produto.id ?? 'n/a'}`,
    `emb=${produto.embalagem_id ?? 'n/a'}`,
    `sql=${scoreBase(produto)}`,
    `origem=${produto.origem ?? 'n/a'}`,
    String(produto.descricao || '').substring(0, 90)
  ].join(' | ');
}

function logResumoProdutos(etapa, produtos, limite = 5) {
  const lista = Array.isArray(produtos) ? produtos : [];
  console.log(`[ETAPA 4] ${etapa} | total=${lista.length}`);

  if (lista.length === 0) {
    return;
  }

  lista.slice(0, limite).forEach((produto, idx) => {
    console.log(`         ${idx + 1}. ${descreverProdutoParaLog(produto)}`);
  });

  if (lista.length > limite) {
    console.log(`         ... +${lista.length - limite} produto(s)`);
  }
}

function selecionarProdutosParaIA(produtos) {
  const lista = Array.isArray(produtos) ? produtos : [];
  const produtosComScore = lista.filter(produto => scoreBase(produto) > 0);
  const base = lista;
  console.log(
    `[ETAPA 4] Selecionando lote para IA | total=${lista.length} | com_score=${produtosComScore.length} | base=${base.length}`
  );
  return base;
}

function dividirEmLotes(produtos, tamanhoLote) {
  const lotes = [];

  for (let idx = 0; idx < produtos.length; idx += tamanhoLote) {
    lotes.push(produtos.slice(idx, idx + tamanhoLote));
  }

  return lotes;
}

function criarListaProdutosCompacta(produtos) {
  return produtos.map((p, idx) => ({
    i: idx,
    d: compactarTexto(p.descricao, 120),
    pa: compactarTexto(p.principioativo_nome, 80),
    t: compactarTexto(p.tipo_classificacao_canonica ?? 'DESCONHECIDO', 30),
    o: compactarTexto(p.origem ?? 'desconhecida', 20),
    s: scoreBase(p)
  }));
}

function extrairArrayJSON(texto) {
  const textoLimpo = String(texto || '')
    .replace(/```json\s*/g, '')
    .replace(/```\s*/g, '')
    .trim();

  const inicio = textoLimpo.indexOf('[');
  const fim = textoLimpo.lastIndexOf(']');

  if (inicio === -1 || fim === -1 || fim < inicio) {
    throw new Error('IA nao retornou array JSON valido.');
  }

  return JSON.parse(textoLimpo.slice(inicio, fim + 1));
}

function extrairDecisoes(texto, tamanhoEsperado) {
  const decisoes = extrairArrayJSON(texto);

  if (!Array.isArray(decisoes) || decisoes.length !== tamanhoEsperado) {
    throw new Error('Quantidade de decisoes incorreta.');
  }

  const normalizadas = decisoes.map(item => ({
    i: Number(item?.i),
    ok: item?.ok === true
  }));

  const indices = new Set(normalizadas.map(item => item.i));
  const indicesEsperados = new Set(Array.from({ length: tamanhoEsperado }, (_, idx) => idx));

  if (indices.size !== tamanhoEsperado) {
    throw new Error('IA retornou indices duplicados ou ausentes.');
  }

  for (const indice of indicesEsperados) {
    if (!indices.has(indice)) {
      throw new Error('IA nao avaliou todos os produtos.');
    }
  }

  return normalizadas.sort((a, b) => a.i - b.i);
}

function logPayloadCompacto(listaProdutos, limite = 5) {
  const payloadJson = JSON.stringify(listaProdutos);
  console.log(
    `[ETAPA 4] Payload compacto pronto | itens=${listaProdutos.length} | caracteres_aprox=${payloadJson.length}`
  );

  listaProdutos.slice(0, limite).forEach(item => {
    console.log(`         payload i=${item.i} | s=${item.s} | d=${item.d}`);
  });

  if (listaProdutos.length > limite) {
    console.log(`         ... +${listaProdutos.length - limite} item(ns) no payload`);
  }
}

function logDecisoesIA(produtos, decisoes, limite = 5) {
  const aprovados = [];
  const rejeitados = [];

  decisoes.forEach(decisao => {
    const produto = produtos[decisao.i];
    if (decisao.ok) {
      aprovados.push(produto);
    } else {
      rejeitados.push(produto);
    }
  });

  console.log(
    `[ETAPA 4] Decisoes da IA | aprovados=${aprovados.length} | rejeitados=${rejeitados.length}`
  );

  aprovados.slice(0, limite).forEach((produto, idx) => {
    console.log(`         aprovado ${idx + 1}. ${descreverProdutoParaLog(produto)}`);
  });

  if (aprovados.length > limite) {
    console.log(`         ... +${aprovados.length - limite} aprovado(s)`);
  }

  rejeitados.slice(0, limite).forEach((produto, idx) => {
    console.log(`         rejeitado ${idx + 1}. ${descreverProdutoParaLog(produto)}`);
  });

  if (rejeitados.length > limite) {
    console.log(`         ... +${rejeitados.length - limite} rejeitado(s)`);
  }
}

function ehBuscaComposta(termoBusca) {
  return REGEX_TERMO_COMPOSTO.test(String(termoBusca || ''));
}

function produtoTemMultiplosPrincipios(produto) {
  const principioAtivo = normalizarTexto(produto?.principioativo_nome);
  if (!principioAtivo) {
    return false;
  }

  return principioAtivo.includes('+') || /\b e \b/.test(principioAtivo);
}

function produtoCombinaComPrincipioSimples(produto, principioAtivoBusca, termoBusca) {
  const principioBusca = normalizarTexto(principioAtivoBusca);
  if (!principioBusca) {
    return true;
  }

  const principioProduto = normalizarTexto(produto?.principioativo_nome);
  const descricaoProduto = normalizarTexto(produto?.descricao);
  const buscaComposta = ehBuscaComposta(termoBusca);

  if (!principioProduto && !descricaoProduto) {
    return true;
  }

  const contemPrincipioBusca = principioProduto.includes(principioBusca) || descricaoProduto.includes(principioBusca);
  if (!contemPrincipioBusca) {
    return false;
  }

  if (!buscaComposta && produtoTemMultiplosPrincipios(produto)) {
    return false;
  }

  return true;
}

function aplicarRegrasDeterministicas(produto, contextoBusca) {
  const { principioAtivoBusca, termoBusca } = contextoBusca || {};
  const relacionadoAtual = produto?.relacionado_busca;

  if (relacionadoAtual !== true) {
    return produto;
  }

  if (!produtoCombinaComPrincipioSimples(produto, principioAtivoBusca, termoBusca)) {
    console.log(
      `[ETAPA 4] Override deterministico: produto marcado como nao relacionado ` +
      `| motivo=principio_ativo_composto_ou_divergente | ${descreverProdutoParaLog(produto)}`
    );
    return {
      ...produto,
      relacionado_busca: false
    };
  }

  return produto;
}

function aplicarFlagRelacaoBusca(produtos, decisoes, contextoBusca) {
  return produtos.map((produto, idx) => {
    const decisao = decisoes.find(item => item.i === idx);
    const produtoMarcado = {
      ...produto,
      relacionado_busca: decisao ? decisao.ok === true : null
    };

    return aplicarRegrasDeterministicas(produtoMarcado, contextoBusca);
  });
}

async function marcarProdutosComIA(produtos, contextoBusca) {
  const termoBusca = contextoBusca?.termoBusca || '';
  if (!Array.isArray(produtos) || produtos.length <= 1) {
    const produtosMarcados = (produtos || []).map(produto => ({
      ...produto,
      relacionado_busca: produtoCombinaComPrincipioSimples(
        { ...produto, relacionado_busca: true },
        contextoBusca?.principioAtivoBusca,
        termoBusca
      )
    }));

    return {
      produtosMarcados,
      aprovados: produtosMarcados.filter(produto => produto.relacionado_busca === true).length,
      rejeitados: produtosMarcados.filter(produto => produto.relacionado_busca === false).length
    };
  }

  const listaProdutos = criarListaProdutosCompacta(produtos);
  logResumoProdutos('Lote recebido para marcacao', produtos);
  logPayloadCompacto(listaProdutos);
  const prompt = `Analise a busca farmacêutica "${termoBusca}" e marque se cada item tem relacao direta com a busca.

Contexto extraido da busca:
- principio_ativo: ${contextoBusca?.principioAtivoBusca || 'nao identificado'}
- forma_farmaceutica: ${contextoBusca?.formaFarmaceutica || 'nao identificada'}

Produtos (total: ${listaProdutos.length}):
${JSON.stringify(listaProdutos, null, 2)}

Cada objeto possui:
- i: indice do item
- d: descricao
- pa: principio ativo
- t: tipo/classificacao
- o: origem da busca
- s: score SQL atual

Marque ok=true apenas quando o produto tiver relacao direta com a busca.
Marque ok=false quando o item for generico demais, vier de match fraco, ou contrariar algo explicito da busca como forma/concentracao/nome distintivo.
Se a busca mencionar apenas um principio ativo simples, nao marque como relacionado um produto composto com outros principios ativos, a menos que a busca diga "composto" ou equivalente.

IMPORTANTE:
- Retorne APENAS um array JSON de objetos
- Formato exato: [{"i":0,"ok":true},{"i":1,"ok":false}]
- Todos os ${listaProdutos.length} itens devem estar presentes uma unica vez
- Sem texto, explicacoes ou markdown`;

  const response = await axios.post(
    OPENAI_API_URL,
    {
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'Voce e um especialista em classificacao de medicamentos. Responda APENAS com um array JSON de objetos com i e ok.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.2
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    }
  );

  const texto = response.data.choices[0].message.content;
  console.log(`[ETAPA 4] Resposta bruta da IA: ${String(texto || '').substring(0, 500)}`);
  const decisoes = extrairDecisoes(texto, produtos.length);
  logDecisoesIA(produtos, decisoes);
  const produtosMarcados = aplicarFlagRelacaoBusca(produtos, decisoes, contextoBusca);

  return {
    produtosMarcados,
    aprovados: produtosMarcados.filter(produto => produto.relacionado_busca === true).length,
    rejeitados: produtosMarcados.filter(produto => produto.relacionado_busca === false).length
  };
}

async function ordenarPorIA(produtos, contextoBusca) {
  const termoBusca = contextoBusca?.termoBusca || '';
  console.log(`\n[ETAPA 4] Marcando ${produtos.length} produtos por RELEVANCIA com IA...`);

  if (!OPENAI_API_KEY || OPENAI_API_KEY === 'sua-chave-aqui') {
    console.log(`[ETAPA 4] ⚠️ IA nao configurada - retornando lista SQL sem marcacao`);
    return {
      produtos: produtos.map(produto => ({ ...produto, relacionado_busca: null })),
      ordenado: false,
      filtrado: false,
      avaliado: false,
      estatisticasIA: { aprovados: 0, rejeitados: 0, analisados: 0 }
    };
  }

  if (produtos.length <= 1) {
    console.log(`[ETAPA 4] ⚠️ Apenas ${produtos.length} produto(s) - marcacao trivial`);
    return {
      produtos: produtos.map(produto => ({ ...produto, relacionado_busca: true })),
      ordenado: false,
      filtrado: false,
      avaliado: true,
      estatisticasIA: { aprovados: produtos.length, rejeitados: 0, analisados: produtos.length }
    };
  }

  try {
    const produtosParaIA = selecionarProdutosParaIA(produtos);
    const lotes = dividirEmLotes(produtosParaIA, MAX_PRODUTOS_IA);

    if (produtosParaIA.length <= 1) {
      console.log(`[ETAPA 4] ⚠️ Menos de 2 produtos relevantes para marcar com IA`);
      return {
        produtos: produtos.map(produto => ({ ...produto, relacionado_busca: true })),
        ordenado: false,
        filtrado: false,
        avaliado: true,
        estatisticasIA: { aprovados: produtos.length, rejeitados: 0, analisados: produtos.length }
      };
    }

    console.log(
      `[ETAPA 4] Enviando ${produtosParaIA.length} produtos para IA marcar em ${lotes.length} lote(s)`
    );
    logResumoProdutos('Candidatos selecionados para a IA', produtosParaIA);

    const produtosMarcados = [];
    let aprovados = 0;
    let rejeitados = 0;

    for (const [indiceLote, lote] of lotes.entries()) {
      console.log(
        `[ETAPA 4] Processando lote ${indiceLote + 1}/${lotes.length} | itens=${lote.length}`
      );
      const resultadoLote = await marcarProdutosComIA(lote, contextoBusca);
      produtosMarcados.push(...resultadoLote.produtosMarcados);
      aprovados += resultadoLote.aprovados;
      rejeitados += resultadoLote.rejeitados;
    }

    const produtosComScore = produtosMarcados.map((produto, pos, lista) => ({
      ...produto,
      relevancia_score: produto.relacionado_busca === true
        ? lista.length - pos
        : produto.relevancia_score ?? produto.relevancia_descricao ?? 0
    }));

    console.log(
      `[ETAPA 4] ✅ IA marcou ${aprovados} relacionado(s) e ${rejeitados} nao relacionado(s) em ${produtosParaIA.length} produto(s)`
    );
    logResumoProdutos('Produtos marcados pela IA', produtosComScore);

    return {
      produtos: produtosComScore,
      ordenado: false,
      filtrado: false,
      avaliado: true,
      estatisticasIA: { aprovados, rejeitados, analisados: produtosParaIA.length }
    };
  } catch (error) {
    console.error(`[ETAPA 4] ⚠️ Erro na IA:`, error.message);
    console.log(`[ETAPA 4] Usando lista SQL existente`);
    return {
      produtos: produtos.map(produto => ({ ...produto, relacionado_busca: null })),
      ordenado: false,
      filtrado: false,
      avaliado: false,
      estatisticasIA: { aprovados: 0, rejeitados: 0, analisados: 0 }
    };
  }
}

module.exports = { ordenarPorIA };
