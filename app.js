// app.js - Express.js REFATORADO (UM PRODUTO POR VEZ)
const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const { formasFarmaceuticas } = require('./similarity');
const { expandirAbreviacoes, gerarCondicoesBusca } = require('./abreviacoes');
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
        
        // 🔧 ADICIONE ESTAS LINHAS:
        // Remove preposições e artigos que sobram
        principioAtivoBusca = principioAtivoBusca
          .replace(/\b(em|de|da|do|das|dos|na|no|nas|nos|com|para|por)\b/gi, '')
          .replace(/\s+/g, ' ')  // Remove espaços múltiplos
          .trim();
        
        break;
      }
    }
    if (formaFarmaceutica) break;
  }

  return { principioAtivoBusca, formaFarmaceutica, variacoesForma };
}

// ============================================================
// ETAPA 1: BUSCAR POR DESCRIÇÃO
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
    
    const { condicoes, parametros } = gerarCondicoesBusca(variacoes);
    
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
        em.codigobarras
      FROM produto p
      LEFT JOIN principioativo pa ON p.principioativoid = pa.id
      INNER JOIN embalagem em ON em.produtoid = p.id
      WHERE (${condicoes})
        AND p.status = 'A'
      ORDER BY p.descricao
      LIMIT 100
    `;
    
    const resultado = await pool.query(query, parametros);

    if (resultado.rows.length > 0) {
      console.log(`[ETAPA 1] ✅ Encontrados ${resultado.rows.length} produtos`);
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
    console.log(`[ETAPA 4] ⚠️ IA não configurada - pulando ordenação`);
    return { produtos, ordenado: false };
  }

  if (produtos.length <= 1) {
    console.log(`[ETAPA 4] ⚠️ Apenas ${produtos.length} produto(s) - ordenação desnecessária`);
    return { produtos, ordenado: false };
  }

  try {
    // Aumentar limite e ajustar dinamicamente
    const MAX_PRODUTOS_IA = Math.min(50, produtos.length);
    const produtosParaIA = produtos.slice(0, MAX_PRODUTOS_IA);
    const produtosRestantes = produtos.slice(MAX_PRODUTOS_IA);

    console.log(`[ETAPA 4] Enviando ${produtosParaIA.length} produtos para IA analisar`);
    if (produtosRestantes.length > 0) {
      console.log(`[ETAPA 4] ${produtosRestantes.length} produtos serão adicionados ao final`);
    }

    const listaProdutos = produtosParaIA.map((p, idx) => ({
      index: idx,
      descricao: (p.descricao ?? "").substring(0, 150), // Limitar tamanho
      principio_ativo: p.principioativo_nome ?? "",
    }));

    const prompt = `Analise os produtos farmacêuticos abaixo e ordene por relevância para a busca: "${termoBusca}"

Produtos (total: ${listaProdutos.length}):
${JSON.stringify(listaProdutos, null, 2)}

Critérios de relevância (por prioridade):
1. Correspondência exata do princípio ativo ou nome comercial
2. Correspondência da forma farmacêutica (comprimido, xarope, injetável, etc)
3. Correspondência parcial de palavras-chave
4. Produtos encontrados por "ambos" os métodos têm ligeira preferência

IMPORTANTE: 
- Retorne APENAS um array JSON com os ${listaProdutos.length} índices ordenados do mais relevante ao menos relevante
- Formato: [5,2,0,1,3,4,...]
- Não inclua texto, explicações ou markdown
- Todos os ${listaProdutos.length} índices devem estar presentes (0 a ${listaProdutos.length - 1})`;

    const response = await axios.post(
      OPENAI_API_URL,
      {
        model: 'gpt-5-nano',
        messages: [
          {
            role: 'system',
            content: 'Você é um especialista em classificação de medicamentos farmacêuticos. Responda SEMPRE e APENAS com um array JSON de números inteiros, representando os índices ordenados por relevância. Sem texto adicional, sem markdown, sem explicações.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 1,
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000 // 30 segundos de timeout
      }
    );

    let texto = response.data.choices[0].message.content.trim();
    console.log(`[ETAPA 4] Resposta da IA (primeiros 200 chars): ${texto.substring(0, 200)}`);
    
    // Limpar markdown e outros caracteres
    texto = texto.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    
    // Tentar extrair array JSON
    const match = texto.match(/\[[\d,\s]+\]/);

    if (!match) {
      console.error(`[ETAPA 4] ❌ IA não retornou array válido. Resposta: ${texto.substring(0, 500)}`);
      throw new Error("IA não retornou array JSON válido.");
    }

    const indices = JSON.parse(match[0]);

    // Validar quantidade de índices
    if (indices.length !== produtosParaIA.length) {
      console.error(`[ETAPA 4] ❌ IA retornou ${indices.length} índices, esperado ${produtosParaIA.length}`);
      throw new Error(`Quantidade de índices incorreta: ${indices.length} vs ${produtosParaIA.length}`);
    }

    // Validar se todos os índices são válidos
    const indicesValidos = indices.every(idx => 
      Number.isInteger(idx) && idx >= 0 && idx < produtosParaIA.length
    );

    if (!indicesValidos) {
      console.error(`[ETAPA 4] ❌ IA retornou índices inválidos`);
      throw new Error("Índices fora do intervalo válido");
    }

    // Verificar duplicatas
    const indicesUnicos = new Set(indices);
    if (indicesUnicos.size !== indices.length) {
      console.error(`[ETAPA 4] ❌ IA retornou índices duplicados`);
      throw new Error("Índices duplicados detectados");
    }

    // Aplicar ordenação
    const produtosOrdenados = indices.map((idx, pos) => ({
      ...produtosParaIA[idx],
      relevancia_score: produtosParaIA.length - pos
    }));

    // Adicionar produtos restantes ao final (se houver)
    if (produtosRestantes.length > 0) {
      produtosRestantes.forEach(p => {
        produtosOrdenados.push({ ...p, relevancia_score: 0 });
      });
    }

    console.log(`[ETAPA 4] ✅ ${produtosOrdenados.length} produtos ordenados por IA com sucesso`);
    console.log(`[ETAPA 4] Top 3: ${produtosOrdenados.slice(0, 3).map(p => p.descricao.substring(0, 50)).join(' | ')}`);
    
    return { produtos: produtosOrdenados, ordenado: true };

  } catch (error) {
    console.error(`[ETAPA 4] ⚠️ Erro na ordenação por IA:`, error.message);
    if (error.response) {
      console.error(`[ETAPA 4] Resposta da API:`, error.response.data);
    }
    
    // Em caso de erro, retornar produtos na ordem original
    console.log(`[ETAPA 4] Retornando produtos na ordem original (sem ordenação por IA)`);
    return { produtos, ordenado: false };
  }
}
// ============================================================
// ROTA PRINCIPAL - UM PRODUTO POR VEZ
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

    // Extrair informações do termo
    const { principioAtivoBusca, formaFarmaceutica, variacoesForma } = extrairFormaFarmaceutica(termoBusca);
    
    console.log(`[INFO] Princípio ativo extraído: "${principioAtivoBusca}"`);
    console.log(`[INFO] Forma farmacêutica: "${formaFarmaceutica || 'nenhuma'}"`);

    let produtosPrincipioAtivo = [];
    let produtosDescricao = [];
    let principiosEncontrados = [];
    let metodosUtilizados = [];

    // ETAPA 1: Buscar por AMBOS os métodos em paralelo
    const [resultadoPrincipioAtivo, resultadoDescricao] = await Promise.all([
      buscarPorPrincipioAtivo(principioAtivoBusca, formaFarmaceutica, variacoesForma),
      buscarPorDescricao(termoBusca)
    ]);

    
    // Coletar produtos de princípio ativo
    if (resultadoPrincipioAtivo.encontrado) {
      produtosPrincipioAtivo = resultadoPrincipioAtivo.produtos;
      principiosEncontrados = resultadoPrincipioAtivo.principiosEncontrados || [];
      metodosUtilizados.push(resultadoPrincipioAtivo.metodo);
      console.log(`[INFO] Encontrados ${produtosPrincipioAtivo.length} produtos por princípio ativo`);
    }

    // Coletar produtos de descrição
    if (resultadoDescricao.produtos && resultadoDescricao.produtos.length > 0) {
      produtosDescricao = resultadoDescricao.produtos;
      metodosUtilizados.push(resultadoDescricao.metodo);
      console.log(`[INFO] Encontrados ${produtosDescricao.length} produtos por descrição`);
    }

    // ETAPA 2: Combinar e remover duplicatas (usando ID como chave única)
    const produtosMap = new Map();
    
    // Adicionar produtos de princípio ativo (prioridade)
    produtosPrincipioAtivo.forEach(p => {
      produtosMap.set(p.id, { ...p, origem: 'principio_ativo' });
    });
    
    // Adicionar produtos de descrição (se não existir)
    produtosDescricao.forEach(p => {
      if (!produtosMap.has(p.id)) {
        produtosMap.set(p.id, { ...p, origem: 'descricao' });
      } else {
        // Marcar que foi encontrado por ambos os métodos
        const produto = produtosMap.get(p.id);
        produto.origem = 'ambos';
        produtosMap.set(p.id, produto);
      }
    });

    let produtos = Array.from(produtosMap.values());
    
    console.log(`[INFO] Total de produtos únicos combinados: ${produtos.length}`);

    // ETAPA 3: Verificar disponibilidade
    if (produtos.length > 0) {
      produtos = await verificarDisponibilidade(produtos, unidadeNegocioId);
      console.log(`[INFO] Após verificação de estoque: ${produtos.length} produtos`);
    }

    // ETAPA 4: Ordenar e filtrar por IA (aumentar limite se necessário)
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
    console.log(`[RESULTADO] Distribuição por origem:`);
    console.log(`  - Princípio ativo: ${produtos.filter(p => p.origem === 'principio_ativo').length}`);
    console.log(`  - Descrição: ${produtos.filter(p => p.origem === 'descricao').length}`);
    console.log(`  - Ambos: ${produtos.filter(p => p.origem === 'ambos').length}`);
    console.log(`========================================\n`);

    // Formatar resposta
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
        total_principios_ativos: principiosEncontrados.length,
        unidade_negocio_id: unidadeNegocioId,
        estatisticas_origem: {
          principio_ativo: produtos.filter(p => p.origem === 'principio_ativo').length,
          descricao: produtos.filter(p => p.origem === 'descricao').length,
          ambos: produtos.filter(p => p.origem === 'ambos').length
        }
      },
      produtos: produtos.map(p => ({
        id: p.id,
        codigo: p.codigo,
        descricao: p.descricao,
        principio_ativo: p.principioativo_nome || null,
        principio_ativo_id: p.principioativo_id,
        registro_ms: p.registroms,
        fabricante_id: p.fabricanteid,
        embalagem_id: p.embalagem_id,
        embalagem_descricao: p.embalagem_descricao,
        codigo_barras: p.codigobarras || null,
        estoque_disponivel: p.estoque_disponivel || 0,
        relevancia_score: p.relevancia_score || null,
        origem_busca: p.origem // Indica de onde veio o produto
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
  console.log(`📍 Rota de busca: POST http://localhost:${PORT}/api/buscar-medicamento`);
  console.log(`📋 Formato esperado: { "query": "dipirona", "unidade_negocio_id": 65984 }`);
});