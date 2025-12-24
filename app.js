// app.js - BUSCA CORRIGIDA COM RANKING SQL
const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const { formasFarmaceuticas } = require('./similarity');
const { expandirAbreviacoes, gerarCondicoesBuscaComRanking } = require('./abreviacoes');
require('dotenv').config();

const app = express();
app.use(express.json());

// Configuração da OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD
});

const UNIDADE_NEGOCIO_ID_PADRAO = parseInt(process.env.UNIDADE_NEGOCIO_ID || '65984');

// ============================================================
// UTILITÁRIOS
// ============================================================

function extrairFormaFarmaceutica(termo) {
  let principioAtivoBusca = termo;
  let formaFarmaceutica = null;
  let variacoesForma = [];

  for (const [forma, variacoes] of Object.entries(formasFarmaceuticas)) {
    for (const variacao of variacoes) {
      const regex = new RegExp(`\\b${variacao}\\b`, 'i');
      if (regex.test(termo)) {
        formaFarmaceutica = forma;
        variacoesForma = variacoes;
        principioAtivoBusca = termo.replace(regex, '').trim();
        
        // Remove preposições e artigos que sobram
        principioAtivoBusca = principioAtivoBusca
          .replace(/\b(em|de|da|do|das|dos|na|no|nas|nos|com|para|por)\b/gi, '')
          .replace(/\s+/g, ' ')
          .trim();
        
        break;
      }
    }
    if (formaFarmaceutica) break;
  }

  return { principioAtivoBusca, formaFarmaceutica, variacoesForma };
}

// ============================================================
// ETAPA 1: BUSCAR POR DESCRIÇÃO (NOVA VERSÃO COM RANKING)
// ============================================================

async function buscarPorDescricao(termoBusca) {
  console.log(`\n[ETAPA 1] Buscando por DESCRIÇÃO: "${termoBusca}"`);
  
  try {
    // Expandir termo para incluir variações com abreviações
    const variacoes = expandirAbreviacoes(termoBusca);
    
    console.log(`[ETAPA 1] 🔍 Variações geradas: ${variacoes.length}`);
    variacoes.forEach((v, idx) => {
      console.log(`         ${idx + 1}. "${v}"`);
    });
    
    // ✅ USANDO NOVA FUNÇÃO COM RANKING
    const { condicoes, parametros, relevanciaSQL, orderBy } = gerarCondicoesBuscaComRanking(variacoes);
    
    const query = `
      SELECT 
        p.id,
        p.codigo,
        p.descricao,
        p.status,
        p.registroms,
        p.fabricanteid,
        pa.id as principioativo_id,
        pa.nome as principioativo_nome,
        em.id as embalagem_id,
        em.descricao as embalagem_descricao,
        em.codigobarras,
        ${relevanciaSQL} as relevancia_descricao
      FROM produto p
      LEFT JOIN principioativo pa ON p.principioativoid = pa.id
      INNER JOIN embalagem em ON em.produtoid = p.id
      WHERE (${condicoes})
        AND p.status = 'A'
      ORDER BY ${orderBy}
      LIMIT 100
    `;
    
    const resultado = await pool.query(query, parametros);

    if (resultado.rows.length > 0) {
      console.log(`[ETAPA 1] ✅ Encontrados ${resultado.rows.length} produtos`);
      console.log(`[ETAPA 1] Top 3 por relevância:`);
      resultado.rows.slice(0, 3).forEach((p, idx) => {
        console.log(`         ${idx + 1}. [${p.relevancia_descricao}pts] ${p.descricao.substring(0, 60)}`);
      });
      
      return {
        encontrado: true,
        produtos: resultado.rows,
        metodo: 'descricao',
        variacoes_usadas: variacoes
      };
    } else {
      console.log(`[ETAPA 1] ❌ Nenhum produto encontrado`);
      return {
        encontrado: false,
        produtos: [],
        metodo: 'descricao',
        variacoes_usadas: variacoes
      };
    }
  } catch (error) {
    console.error(`[ETAPA 1] ⚠️ Erro:`, error.message);
    throw error;
  }
}

// ============================================================
// ETAPA 2: BUSCAR POR PRINCÍPIO ATIVO
// ============================================================

async function buscarPorPrincipioAtivo(principioAtivo, formaFarmaceutica, variacoesForma) {
  console.log(`\n[ETAPA 2] Buscando por PRINCÍPIO ATIVO: "${principioAtivo}"`);
  
  try {
    // 2.1: Encontrar princípios ativos
    const resultadoPrincipios = await pool.query(`
      SELECT DISTINCT id, nome 
      FROM principioativo 
      WHERE nome ILIKE $1
      ORDER BY nome
    `, [`%${principioAtivo}%`]);

    if (resultadoPrincipios.rows.length === 0) {
      console.log(`[ETAPA 2] ❌ Nenhum princípio ativo encontrado`);
      return {
        encontrado: false,
        produtos: [],
        principiosEncontrados: [],
        metodo: 'principio_ativo'
      };
    }

    console.log(`[ETAPA 2] 📋 Encontrados ${resultadoPrincipios.rows.length} princípios ativos`);
    const principiosEncontrados = resultadoPrincipios.rows;

    // 2.2: Buscar produtos com esses princípios ativos
    const principioIds = principiosEncontrados.map(p => p.id);
    const principioPlaceholders = principioIds.map((_, idx) => `$${idx + 1}`).join(',');
    
    let queryProdutos = `
      SELECT 
        p.id,
        p.codigo,
        p.descricao,
        p.status,
        p.registroms,
        p.fabricanteid,
        pa.id as principioativo_id,
        pa.nome as principioativo_nome,
        em.id as embalagem_id,
        em.descricao as embalagem_descricao,
        em.codigobarras
      FROM produto p
      INNER JOIN principioativo pa ON p.principioativoid = pa.id
      INNER JOIN embalagem em ON em.produtoid = p.id
      WHERE pa.id IN (${principioPlaceholders})
        AND p.status = 'A'
    `;
    
    let params = [...principioIds];

    // Filtrar por forma farmacêutica se houver
    if (formaFarmaceutica && variacoesForma.length > 0) {
      const startIdx = principioIds.length + 1;
      const formaPlaceholders = variacoesForma.map((_, idx) => `p.descricao ILIKE $${startIdx + idx}`).join(' OR ');
      queryProdutos += ` AND (${formaPlaceholders})`;
      params.push(...variacoesForma.map(v => `%${v}%`));
      console.log(`[ETAPA 2] 🔍 Filtrando por formas: ${variacoesForma.join(', ')}`);
    }

    queryProdutos += ` ORDER BY p.descricao LIMIT 100`;

    const resultadoProdutos = await pool.query(queryProdutos, params);

    // 2.3: Fallback sem forma farmacêutica
    if (resultadoProdutos.rows.length === 0 && formaFarmaceutica) {
      console.log(`[ETAPA 2] 🔄 Tentando sem filtro de forma...`);
      
      const querySemForma = `
        SELECT 
          p.id,
          p.codigo,
          p.descricao,
          p.status,
          p.registroms,
          p.fabricanteid,
          pa.id as principioativo_id,
          pa.nome as principioativo_nome,
          em.id as embalagem_id,
          em.descricao as embalagem_descricao,
          em.codigobarras
        FROM produto p
        INNER JOIN principioativo pa ON p.principioativoid = pa.id
        INNER JOIN embalagem em ON em.produtoid = p.id
        WHERE pa.id IN (${principioPlaceholders})
          AND p.status = 'A'
        ORDER BY p.descricao
        LIMIT 100
      `;
      
      const resultadoSemForma = await pool.query(querySemForma, principioIds);
      
      if (resultadoSemForma.rows.length > 0) {
        console.log(`[ETAPA 2] ✅ Encontrados ${resultadoSemForma.rows.length} produtos (sem forma)`);
        return {
          encontrado: true,
          produtos: resultadoSemForma.rows,
          principiosEncontrados,
          metodo: 'principio_ativo_sem_forma'
        };
      }
    } else if (resultadoProdutos.rows.length > 0) {
      console.log(`[ETAPA 2] ✅ Encontrados ${resultadoProdutos.rows.length} produtos`);
      return {
        encontrado: true,
        produtos: resultadoProdutos.rows,
        principiosEncontrados,
        metodo: 'principio_ativo'
      };
    }

    console.log(`[ETAPA 2] ❌ Nenhum produto encontrado`);
    return {
      encontrado: false,
      produtos: [],
      principiosEncontrados,
      metodo: 'principio_ativo'
    };

  } catch (error) {
    console.error(`[ETAPA 2] ⚠️ Erro:`, error.message);
    throw error;
  }
}

// ============================================================
// ETAPA 3: VERIFICAR DISPONIBILIDADE
// ============================================================

async function verificarDisponibilidade(produtos, unidadeNegocioId) {
  console.log(`\n[ETAPA 3] Verificando DISPONIBILIDADE de ${produtos.length} produtos...`);
  
  if (produtos.length === 0) {
    console.log(`[ETAPA 3] ⚠️ Nenhum produto para verificar`);
    return [];
  }

  try {
    const embalagemIds = produtos.map(p => p.embalagem_id);
    const placeholders = embalagemIds.map((_, idx) => `$${idx + 1}`).join(',');
    
    const resultado = await pool.query(`
      SELECT 
        embalagemid,
        COALESCE(estoque, 0) as estoque_disponivel
      FROM estoque
      WHERE embalagemid IN (${placeholders})
        AND unidadenegocioid = $${embalagemIds.length + 1}
    `, [...embalagemIds, unidadeNegocioId]);

    const estoqueMap = {};
    resultado.rows.forEach(row => {
      estoqueMap[row.embalagemid] = row.estoque_disponivel;
    });

    // Adicionar informação de estoque aos produtos
    produtos.forEach(produto => {
      produto.estoque_disponivel = estoqueMap[produto.embalagem_id] || 0;
      produto.tem_estoque = (estoqueMap[produto.embalagem_id] || 0) > 0;
    });

    const produtosComEstoque = produtos.filter(p => p.tem_estoque);
    const produtosSemEstoque = produtos.filter(p => !p.tem_estoque);

    console.log(`[ETAPA 3] ✅ ${produtosComEstoque.length} com estoque | ❌ ${produtosSemEstoque.length} sem estoque`);

    return produtosComEstoque;

  } catch (error) {
    console.error(`[ETAPA 3] ⚠️ Erro:`, error.message);
    throw error;
  }
}

// ============================================================
// ETAPA 4: ORDENAR POR IA
// ============================================================
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
      relevancia_sql: p.relevancia_descricao || 0
    }));

    const prompt = `Analise os produtos farmacêuticos abaixo e ordene por relevância para a busca: "${termoBusca}"

Produtos (total: ${listaProdutos.length}):
${JSON.stringify(listaProdutos, null, 2)}

Critérios de relevância (por prioridade):
1. Correspondência exata do princípio ativo ou nome comercial
2. Correspondência da forma farmacêutica
3. Relevância SQL já calculada (relevancia_sql)
4. Correspondência parcial de palavras-chave

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

// ============================================================
// ROTA PRINCIPAL
// ============================================================
app.post('/api/buscar-medicamentos', async (req, res) => {
  try {
    const { query, unidade_negocio_id } = req.body;

    if (!query || query.trim() === '') {
      return res.status(400).json({ erro: 'Query vazia' });
    }

    const unidadeNegocioId = unidade_negocio_id || UNIDADE_NEGOCIO_ID_PADRAO;
    const termoBusca = query.trim().toLowerCase();

    console.log(`\n========================================`);
    console.log(`[BUSCA] Termo: "${termoBusca}"`);
    console.log(`[BUSCA] Unidade Negócio ID: ${unidadeNegocioId}`);
    console.log(`========================================`);

    const { principioAtivoBusca, formaFarmaceutica, variacoesForma } = extrairFormaFarmaceutica(termoBusca);
    
    console.log(`[INFO] Princípio ativo extraído: "${principioAtivoBusca}"`);
    console.log(`[INFO] Forma farmacêutica: "${formaFarmaceutica || 'nenhuma'}"`);

    let produtosPrincipioAtivo = [];
    let produtosDescricao = [];
    let principiosEncontrados = [];
    let metodosUtilizados = [];

    // Buscar por ambos os métodos em paralelo
    const [resultadoPrincipioAtivo, resultadoDescricao] = await Promise.all([
      buscarPorPrincipioAtivo(principioAtivoBusca, formaFarmaceutica, variacoesForma),
      buscarPorDescricao(termoBusca)
    ]);

    if (resultadoPrincipioAtivo.encontrado) {
      produtosPrincipioAtivo = resultadoPrincipioAtivo.produtos;
      principiosEncontrados = resultadoPrincipioAtivo.principiosEncontrados || [];
      metodosUtilizados.push(resultadoPrincipioAtivo.metodo);
    }

    if (resultadoDescricao.produtos && resultadoDescricao.produtos.length > 0) {
      produtosDescricao = resultadoDescricao.produtos;
      metodosUtilizados.push(resultadoDescricao.metodo);
    }

    // Combinar e remover duplicatas
    const produtosMap = new Map();
    
    produtosPrincipioAtivo.forEach(p => {
      produtosMap.set(p.id, { ...p, origem: 'principio_ativo' });
    });
    
    produtosDescricao.forEach(p => {
      if (!produtosMap.has(p.id)) {
        produtosMap.set(p.id, { ...p, origem: 'descricao' });
      } else {
        const produto = produtosMap.get(p.id);
        produto.origem = 'ambos';
        // Manter o score de relevância da descrição
        produto.relevancia_descricao = p.relevancia_descricao;
        produtosMap.set(p.id, produto);
      }
    });

    let produtos = Array.from(produtosMap.values());
    
    // Ordenar por relevância SQL antes de verificar estoque
    produtos.sort((a, b) => {
      const scoreA = a.relevancia_descricao || 0;
      const scoreB = b.relevancia_descricao || 0;
      return scoreB - scoreA;
    });
    
    console.log(`[INFO] Total de produtos únicos combinados: ${produtos.length}`);

    // Verificar disponibilidade
    if (produtos.length > 0) {
      produtos = await verificarDisponibilidade(produtos, unidadeNegocioId);
      console.log(`[INFO] Após verificação de estoque: ${produtos.length} produtos`);
    }

    // Ordenar por IA
    let ordenadoPorIA = false;
    if (produtos.length > 0) {
      const resultadoIA = await ordenarPorIA(produtos, termoBusca);
      produtos = resultadoIA.produtos;
      ordenadoPorIA = resultadoIA.ordenado;
    }

    const metodoBusca = metodosUtilizados.length > 0 
      ? metodosUtilizados.join(' + ') 
      : 'nenhum método encontrou resultados';

    console.log(`\n========================================`);
    console.log(`[RESULTADO] ${produtos.length} produto(s) encontrado(s)`);
    console.log(`[RESULTADO] Métodos: ${metodoBusca}`);
    console.log(`[RESULTADO] Ordenado por IA: ${ordenadoPorIA ? 'Sim' : 'Não'}`);
    console.log(`========================================\n`);

    return res.status(200).json({
      busca: {
        termo_original: termoBusca,
        principio_ativo_extraido: principioAtivoBusca !== termoBusca ? principioAtivoBusca : null,
        forma_farmaceutica: formaFarmaceutica
      },
      metadados: {
        metodo_busca: metodoBusca,
        ordenado_por_ia: ordenadoPorIA,
        total_produtos: produtos.length,
        unidade_negocio_id: unidadeNegocioId
      },
      produtos: produtos.map(p => ({
        id: p.id,
        codigo: p.codigo,
        descricao: p.descricao,
        principio_ativo: p.principioativo_nome || null,
        embalagem_id: p.embalagem_id,
        estoque_disponivel: p.estoque_disponivel || 0,
        relevancia_score: p.relevancia_score || p.relevancia_descricao || null,
        origem_busca: p.origem
      }))
    });

  } catch (error) {
    console.error('❌ Erro ao buscar medicamento:', error);
    return res.status(500).json({
      erro: 'Erro ao processar busca',
      detalhes: error.message
    });
  }
});

app.get('/', (req, res) => {
  res.json({ mensagem: 'API de busca de medicamentos está rodando!' });
});

const PORT = process.env.PORT || 5232;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});