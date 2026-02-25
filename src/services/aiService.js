const axios = require('axios');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

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
    const MAX_PRODUTOS_IA = Math.min(50, produtos.length);
    const produtosParaIA = produtos.slice(0, MAX_PRODUTOS_IA);
    const produtosRestantes = produtos.slice(MAX_PRODUTOS_IA);

    console.log(`[ETAPA 4] Enviando ${produtosParaIA.length} produtos para IA analisar`);

    const listaProdutos = produtosParaIA.map((p, idx) => ({
      index: idx,
      descricao: (p.descricao ?? "").substring(0, 150),
      principio_ativo: p.principioativo_nome ?? "",
      tipo_classificacao: p.tipo_classificacao_canonica ?? "DESCONHECIDO",
      relevancia_sql: p.relevancia_descricao || 0
    }));

    const prompt = `Analise os produtos farmacêuticos abaixo e ordene por relevância para a busca: "${termoBusca}"

Produtos (total: ${listaProdutos.length}):
${JSON.stringify(listaProdutos, null, 2)}

Critérios de relevância (por prioridade):
1. Correspondência exata do princípio ativo ou nome comercial
2. Correspondência da forma farmacêutica
3. Classificação desejável para contexto farmacêutico (REFERENCIA/GENERICO/SIMILAR), sem descartar as demais
4. Relevância SQL já calculada (relevancia_sql)
5. Correspondência parcial de palavras-chave

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
        temperature: 0.3,
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    let texto = response.data.choices[0].message.content.trim();
    texto = texto.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    const match = texto.match(/\[[\d,\s]+\]/);
    if (!match) {
      throw new Error("IA não retornou array JSON válido.");
    }

    const indices = JSON.parse(match[0]);

    if (indices.length !== produtosParaIA.length) {
      throw new Error(`Quantidade de índices incorreta`);
    }

    const produtosOrdenados = indices.map((idx, pos) => ({
      ...produtosParaIA[idx],
      relevancia_score: produtosParaIA.length - pos
    }));

    if (produtosRestantes.length > 0) {
      produtosRestantes.forEach(p => {
        produtosOrdenados.push({ ...p, relevancia_score: 0 });
      });
    }

    console.log(`[ETAPA 4] ✅ Produtos ordenados por IA`);

    return { produtos: produtosOrdenados, ordenado: true };
  } catch (error) {
    console.error(`[ETAPA 4] ⚠️ Erro na IA:`, error.message);
    console.log(`[ETAPA 4] Usando ordenação SQL existente`);
    return { produtos, ordenado: false };
  }
}

module.exports = { ordenarPorIA };
