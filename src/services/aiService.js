const axios = require('axios');
const { classificarRelacaoBuscaDeterministica } = require('../utils/searchUtils');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const MAX_PRODUTOS_IA = 20;
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

function chaveProduto(produto) {
  return `${produto?.id ?? 'sem_id'}:${produto?.embalagem_id ?? 'sem_emb'}`;
}

function prioridadeRelacao(produto) {
  if (produto?.relacionado_busca === true) {
    return 0;
  }

  if (produto?.relacionado_busca === null || produto?.relacionado_busca === undefined) {
    return 1;
  }

  return 2;
}

function reordenarProdutosMarcados(produtos) {
  return [...(Array.isArray(produtos) ? produtos : [])]
    .sort((a, b) => prioridadeRelacao(a) - prioridadeRelacao(b));
}

function houveMudancaDeOrdem(produtosOriginais, produtosReordenados) {
  const antes = Array.isArray(produtosOriginais) ? produtosOriginais.map(chaveProduto) : [];
  const depois = Array.isArray(produtosReordenados) ? produtosReordenados.map(chaveProduto) : [];

  if (antes.length !== depois.length) {
    return true;
  }

  return antes.some((chave, idx) => chave !== depois[idx]);
}

function aplicarRegrasDeterministicas(produto, contextoBusca) {
  const regraDeterministica = classificarRelacaoBuscaDeterministica(produto, contextoBusca);
  if (!regraDeterministica) {
    return {
      ...produto,
      tipo_relacao_busca: produto?.tipo_relacao_busca || (
        produto?.relacionado_busca === true
          ? 'relacionado_ia'
          : produto?.relacionado_busca === false
            ? 'nao_relacionado_ia'
            : null
      ),
      motivo_relacao_busca: produto?.motivo_relacao_busca || null
    };
  }

  const houveOverride = (
    produto?.relacionado_busca !== regraDeterministica.relacionado_busca ||
    produto?.tipo_relacao_busca !== regraDeterministica.tipo_relacao_busca
  );

  if (houveOverride) {
    console.log(
      `[ETAPA 4] Override deterministico: produto reclassificado ` +
      `| motivo=${regraDeterministica.motivo_relacao_busca} ` +
      `| relacionado=${regraDeterministica.relacionado_busca ? 'sim' : 'nao'} ` +
      `| tipo=${regraDeterministica.tipo_relacao_busca} | ${descreverProdutoParaLog(produto)}`
    );
  }

  return {
    ...produto,
    ...regraDeterministica
  };
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

function marcarProdutosSemIA(produtos, contextoBusca) {
  return (produtos || []).map(produto => aplicarRegrasDeterministicas({
    ...produto,
    relacionado_busca: produto?.relacionado_busca ?? null
  }, contextoBusca));
}

function resumirMarcacao(produtosMarcados) {
  return {
    aprovados: produtosMarcados.filter(produto => produto.relacionado_busca === true).length,
    rejeitados: produtosMarcados.filter(produto => produto.relacionado_busca === false).length
  };
}

async function marcarProdutosComIA(produtos, contextoBusca) {
  const termoBusca = contextoBusca?.termoBusca || '';
  if (!Array.isArray(produtos) || produtos.length <= 1) {
    const produtosMarcados = marcarProdutosSemIA(produtos, contextoBusca);
    const resumo = resumirMarcacao(produtosMarcados);

    return {
      produtosMarcados,
      aprovados: resumo.aprovados,
      rejeitados: resumo.rejeitados
    };
  }

  const listaProdutos = criarListaProdutosCompacta(produtos);
  logResumoProdutos('Lote recebido para marcacao', produtos);
  logPayloadCompacto(listaProdutos);
  const prompt = `Analise a busca farmacêutica "${termoBusca}" e marque se cada item tem relacao direta com a busca.

Contexto extraido da busca:
- tipo_busca: ${contextoBusca?.tipoBusca || 'indefinido'}
- termo_nuclear: ${contextoBusca?.termoNominalBusca || contextoBusca?.principioAtivoBusca || termoBusca}
- principio_ativo: ${String(contextoBusca?.tipoBusca || '').startsWith('principio_ativo')
    ? (contextoBusca?.principioAtivoBusca || 'nao identificado')
    : 'nao se aplica'}
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
Se tipo_busca=marca, itens com o nome buscado explicitamente na descricao sao relacionados; itens apenas do mesmo principio ativo, mas com outro nome comercial, nao sao relacionados diretos.
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
    console.log(`[ETAPA 4] ⚠️ IA nao configurada - aplicando apenas regras deterministicas`);
    const produtosMarcados = marcarProdutosSemIA(produtos, contextoBusca);
    const resumo = resumirMarcacao(produtosMarcados);
    return {
      produtos: produtosMarcados,
      ordenado: false,
      filtrado: resumo.rejeitados > 0,
      avaliado: false,
      estatisticasIA: { aprovados: resumo.aprovados, rejeitados: resumo.rejeitados, analisados: produtosMarcados.length }
    };
  }

  if (produtos.length <= 1) {
    console.log(`[ETAPA 4] ⚠️ Apenas ${produtos.length} produto(s) - marcacao trivial`);
    const resultadoTrivial = await marcarProdutosComIA(produtos, contextoBusca);
    const produtosMarcados = resultadoTrivial.produtosMarcados;
    const filtrado = resultadoTrivial.rejeitados > 0;

    return {
      produtos: produtosMarcados,
      ordenado: false,
      filtrado,
      avaliado: true,
      estatisticasIA: {
        aprovados: resultadoTrivial.aprovados,
        rejeitados: resultadoTrivial.rejeitados,
        analisados: produtosMarcados.length
      }
    };
  }

  try {
    const produtosParaIA = selecionarProdutosParaIA(produtos);
    const lotes = dividirEmLotes(produtosParaIA, MAX_PRODUTOS_IA);

    if (produtosParaIA.length <= 1) {
      console.log(`[ETAPA 4] ⚠️ Menos de 2 produtos relevantes para marcar com IA`);
      const resultadoTrivial = await marcarProdutosComIA(produtos, contextoBusca);
      const produtosMarcados = resultadoTrivial.produtosMarcados;
      const filtrado = resultadoTrivial.rejeitados > 0;

      return {
        produtos: produtosMarcados,
        ordenado: false,
        filtrado,
        avaliado: true,
        estatisticasIA: {
          aprovados: resultadoTrivial.aprovados,
          rejeitados: resultadoTrivial.rejeitados,
          analisados: produtosMarcados.length
        }
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

    const filtrado = rejeitados > 0;
    const produtosReordenados = reordenarProdutosMarcados(produtosMarcados);
    const ordenado = houveMudancaDeOrdem(produtosMarcados, produtosReordenados);
    const produtosComScore = produtosReordenados.map((produto, pos, lista) => ({
      ...produto,
      relevancia_score: produto.relacionado_busca === true
        ? lista.length - pos
        : produto.relevancia_score ?? produto.relevancia_descricao ?? 0
    }));

    console.log(
      `[ETAPA 4] ✅ IA marcou ${aprovados} relacionado(s) e ${rejeitados} nao relacionado(s) em ${produtosParaIA.length} produto(s)`
    );
    console.log(
      `[ETAPA 4] Flags calculadas | ordenado=${ordenado ? 'sim' : 'nao'} | filtrado=${filtrado ? 'sim' : 'nao'}`
    );
    logResumoProdutos('Produtos marcados pela IA', produtosComScore);

    return {
      produtos: produtosComScore,
      ordenado,
      filtrado,
      avaliado: true,
      estatisticasIA: { aprovados, rejeitados, analisados: produtosParaIA.length }
    };
  } catch (error) {
    console.error(`[ETAPA 4] ⚠️ Erro na IA:`, error.message);
    console.log(`[ETAPA 4] Usando apenas regras deterministicas`);
    const produtosMarcados = marcarProdutosSemIA(produtos, contextoBusca);
    const resumo = resumirMarcacao(produtosMarcados);
    return {
      produtos: produtosMarcados,
      ordenado: false,
      filtrado: resumo.rejeitados > 0,
      avaliado: false,
      estatisticasIA: { aprovados: resumo.aprovados, rejeitados: resumo.rejeitados, analisados: produtosMarcados.length }
    };
  }
}

module.exports = { ordenarPorIA };
