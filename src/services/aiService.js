const axios = require('axios');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const MAX_PRODUTOS_IA = 20;

function scoreBase(produto) {
  const score = Number(produto?.relevancia_descricao ?? 0);
  return Number.isFinite(score) ? score : 0;
}

function selecionarProdutosParaIA(produtos) {
  const lista = Array.isArray(produtos) ? produtos : [];
  const produtosComScore = lista.filter(produto => scoreBase(produto) > 0);
  const base = produtosComScore.length >= 2 ? produtosComScore : lista;
  const produtosParaIA = base.slice(0, MAX_PRODUTOS_IA);
  const chavesSelecionadas = new Set(produtosParaIA.map(produto => `${produto.id}:${produto.embalagem_id}`));
  const produtosRestantes = lista.filter(produto => !chavesSelecionadas.has(`${produto.id}:${produto.embalagem_id}`));

  return { produtosParaIA, produtosRestantes };
}

function criarListaProdutos(produtos) {
  return produtos.map((p, idx) => ({
    index: idx,
    descricao: (p.descricao ?? '').substring(0, 150),
    principio_ativo: p.principioativo_nome ?? '',
    tipo_classificacao: p.tipo_classificacao_canonica ?? 'DESCONHECIDO',
    relevancia_sql: scoreBase(p),
    origem_busca: p.origem ?? 'desconhecida'
  }));
}

function extrairIndicesOrdenados(texto, tamanhoEsperado) {
  const textoLimpo = String(texto || '')
    .replace(/```json\s*/g, '')
    .replace(/```\s*/g, '')
    .trim();

  const match = textoLimpo.match(/\[[\d,\s]+\]/);
  if (!match) {
    throw new Error('IA não retornou array JSON válido.');
  }

  const indices = JSON.parse(match[0]);
  if (indices.length !== tamanhoEsperado) {
    throw new Error('Quantidade de índices incorreta');
  }

  return indices;
}

async function ordenarGrupoComIA(grupo, termoBusca, scoreGrupo) {
  if (!Array.isArray(grupo) || grupo.length <= 1) {
    return grupo || [];
  }

  const listaProdutos = criarListaProdutos(grupo);
  const prompt = `Analise os produtos farmacêuticos abaixo e ordene por relevância para a busca: "${termoBusca}"

Produtos (total: ${listaProdutos.length}):
${JSON.stringify(listaProdutos, null, 2)}

Todos os produtos deste lote possuem a mesma faixa de relevância SQL (${scoreGrupo}).
Sua tarefa é apenas desempatar este grupo, sem considerar produtos fora dele.

Critérios de relevância (por prioridade):
1. Correspondência textual exata ou quase exata entre a busca e a descricao do produto
2. Correspondência de princípio ativo e forma farmacêutica, quando aplicável
3. Correspondência de palavras-chave raras ou distintivas da busca
4. Classificação canônica apenas como critério de desempate final

IMPORTANTE:
- Retorne APENAS um array JSON com os ${listaProdutos.length} índices ordenados
- Formato: [5,2,0,1,3,4,...]
- Sem texto, explicações ou markdown
- Todos os ${listaProdutos.length} índices devem estar presentes (0 a ${listaProdutos.length - 1})`;

  const response = await axios.post(
    OPENAI_API_URL,
    {
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'Você é um especialista em classificação de medicamentos. Responda APENAS com um array JSON de números inteiros.'
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
  const indices = extrairIndicesOrdenados(texto, grupo.length);
  return indices.map(idx => grupo[idx]);
}

async function ordenarPorIA(produtos, termoBusca) {
  console.log(`\n[ETAPA 4] Ordenando ${produtos.length} produtos por RELEVÂNCIA com IA...`);

  if (!OPENAI_API_KEY || OPENAI_API_KEY === 'sua-chave-aqui') {
    console.log(`[ETAPA 4] ⚠️ IA não configurada - usando ordenação SQL`);
    return { produtos, ordenado: false };
  }

  if (produtos.length <= 1) {
    console.log(`[ETAPA 4] ⚠️ Apenas ${produtos.length} produto(s) - ordenação desnecessária`);
    return { produtos, ordenado: false };
  }

  try {
    const { produtosParaIA, produtosRestantes } = selecionarProdutosParaIA(produtos);

    if (produtosParaIA.length <= 1) {
      console.log(`[ETAPA 4] ⚠️ Menos de 2 produtos relevantes para ordenar com IA`);
      return { produtos, ordenado: false };
    }

    console.log(
      `[ETAPA 4] Enviando ${produtosParaIA.length} produtos para IA analisar ` +
      `| Restantes preservados na ordem SQL: ${produtosRestantes.length}`
    );

    const gruposPorScore = new Map();
    produtosParaIA.forEach(produto => {
      const score = scoreBase(produto);
      if (!gruposPorScore.has(score)) {
        gruposPorScore.set(score, []);
      }
      gruposPorScore.get(score).push(produto);
    });

    const scoresOrdenados = [...gruposPorScore.keys()].sort((a, b) => b - a);
    const produtosOrdenadosIA = [];

    for (const score of scoresOrdenados) {
      const grupo = gruposPorScore.get(score) || [];

      if (grupo.length > 1) {
        console.log(`[ETAPA 4] Desempatando ${grupo.length} produto(s) na faixa SQL ${score}`);
      }

      const grupoOrdenado = await ordenarGrupoComIA(grupo, termoBusca, score);
      produtosOrdenadosIA.push(...grupoOrdenado);
    }

    const produtosOrdenados = [...produtosOrdenadosIA, ...produtosRestantes].map((produto, pos, lista) => ({
      ...produto,
      relevancia_score: lista.length - pos
    }));

    console.log(`[ETAPA 4] ✅ Produtos ordenados por IA`);

    return { produtos: produtosOrdenados, ordenado: true };
  } catch (error) {
    console.error(`[ETAPA 4] ⚠️ Erro na IA:`, error.message);
    console.log(`[ETAPA 4] Usando ordenação SQL existente`);
    return { produtos, ordenado: false };
  }
}

module.exports = { ordenarPorIA };
