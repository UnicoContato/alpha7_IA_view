// app.js - Express.js 
const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const { formasFarmaceuticas } = require('./similarity');
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

// Unidade de negócio padrão (pode vir de env ou request)
const UNIDADE_NEGOCIO_ID_PADRAO = parseInt(process.env.UNIDADE_NEGOCIO_ID || '65984');

// ============================================================
// FUNÇÃO: GERAR CAMPOS DE PREÇO COM PARÂMETRO DINÂMICO
// ============================================================
function gerarCamposPreco(paramIndex) {
  // paramIndex é o índice do parâmetro $N para unidadenegocioid
  return `
  p.id,
  p.codigo,
  p.descricao,
  p.status,
  p.registroms,
  p.fabricanteid,
  pa.id as principioativo_id,
  pa.nome as principioativo_nome,
  COALESCE(e.estoque, 0) as estoque_disponivel,
  e.embalagemid,
  em.descricao as embalagem_descricao,
  em.codigobarras, 
  em.precovenda as preco_normal,
  
  (
    SELECT MIN(ico.precooferta)
    FROM itemcadernooferta ico
    INNER JOIN cadernooferta co ON co.id = ico.cadernoofertaid
    INNER JOIN unidadenegocioparticipantecadernooferta unp 
      ON unp.cadernoofertaid = co.id
    WHERE ico.embalagemid = em.id
      AND ico.tipooferta = 'P'
      AND co.status = 'A'
      AND unp.unidadenegocioid = $${paramIndex}
      AND CURRENT_TIMESTAMP BETWEEN co.datahorainicial AND co.datahorafinal
  ) as menor_preco_oferta,
  
  (
    SELECT json_build_object(
      'caderno_oferta_id', co.id,
      'nome', co.nome,
      'data_inicial', co.datahorainicial,
      'data_final', co.datahorafinal,
      'origem', co.origem
    )
    FROM itemcadernooferta ico
    INNER JOIN cadernooferta co ON co.id = ico.cadernoofertaid
    INNER JOIN unidadenegocioparticipantecadernooferta unp 
      ON unp.cadernoofertaid = co.id
    WHERE ico.embalagemid = em.id
      AND ico.tipooferta = 'P'
      AND co.status = 'A'
      AND unp.unidadenegocioid = $${paramIndex}
      AND CURRENT_TIMESTAMP BETWEEN co.datahorainicial AND co.datahorafinal
    ORDER BY ico.precooferta ASC
    LIMIT 1
  ) as origem_oferta_preco,
  
  (
    SELECT MAX(ico.descontooferta)
    FROM itemcadernooferta ico
    INNER JOIN cadernooferta co ON co.id = ico.cadernoofertaid
    INNER JOIN unidadenegocioparticipantecadernooferta unp 
      ON unp.cadernoofertaid = co.id
    WHERE ico.embalagemid = em.id
      AND ico.tipooferta = 'D'
      AND co.status = 'A'
      AND unp.unidadenegocioid = $${paramIndex}
      AND CURRENT_TIMESTAMP BETWEEN co.datahorainicial AND co.datahorafinal
  ) as desconto_percentual,
  
  (
    SELECT json_build_object(
      'caderno_oferta_id', co.id,
      'nome', co.nome,
      'data_inicial', co.datahorainicial,
      'data_final', co.datahorafinal,
      'origem', co.origem
    )
    FROM itemcadernooferta ico
    INNER JOIN cadernooferta co ON co.id = ico.cadernoofertaid
    INNER JOIN unidadenegocioparticipantecadernooferta unp 
      ON unp.cadernoofertaid = co.id
    WHERE ico.embalagemid = em.id
      AND ico.tipooferta = 'D'
      AND co.status = 'A'
      AND unp.unidadenegocioid = $${paramIndex}
      AND CURRENT_TIMESTAMP BETWEEN co.datahorainicial AND co.datahorafinal
    ORDER BY ico.descontooferta DESC
    LIMIT 1
  ) as origem_oferta_desconto,
  
  CASE
    WHEN (
      SELECT MAX(ico.descontooferta)
      FROM itemcadernooferta ico
      INNER JOIN cadernooferta co ON co.id = ico.cadernoofertaid
      INNER JOIN unidadenegocioparticipantecadernooferta unp 
        ON unp.cadernoofertaid = co.id
      WHERE ico.embalagemid = em.id
        AND ico.tipooferta = 'D'
        AND co.status = 'A'
        AND unp.unidadenegocioid = $${paramIndex}
        AND CURRENT_TIMESTAMP BETWEEN co.datahorainicial AND co.datahorafinal
    ) IS NOT NULL 
    THEN em.precovenda * (1 - (
      SELECT MAX(ico.descontooferta) / 100
      FROM itemcadernooferta ico
      INNER JOIN cadernooferta co ON co.id = ico.cadernoofertaid
      INNER JOIN unidadenegocioparticipantecadernooferta unp 
        ON unp.cadernoofertaid = co.id
      WHERE ico.embalagemid = em.id
        AND ico.tipooferta = 'D'
        AND co.status = 'A'
        AND unp.unidadenegocioid = $${paramIndex}
        AND CURRENT_TIMESTAMP BETWEEN co.datahorainicial AND co.datahorafinal
    ))
    ELSE COALESCE(
      (
        SELECT MIN(ico.precooferta)
        FROM itemcadernooferta ico
        INNER JOIN cadernooferta co ON co.id = ico.cadernoofertaid
        INNER JOIN unidadenegocioparticipantecadernooferta unp 
          ON unp.cadernoofertaid = co.id
        WHERE ico.embalagemid = em.id
          AND ico.tipooferta = 'P'
          AND co.status = 'A'
          AND unp.unidadenegocioid = $${paramIndex}
          AND CURRENT_TIMESTAMP BETWEEN co.datahorainicial AND co.datahorafinal
      ),
      em.precovenda
    )
  END as preco_final,
  
  (
    SELECT json_build_object(
      'leve', ico.leve,
      'pague', ico.pague,
      'desconto_levepague', ico.descontolevepague
    )
    FROM itemcadernooferta ico
    INNER JOIN cadernooferta co ON co.id = ico.cadernoofertaid
    INNER JOIN unidadenegocioparticipantecadernooferta unp 
      ON unp.cadernoofertaid = co.id
    WHERE ico.embalagemid = em.id
      AND ico.leve IS NOT NULL
      AND ico.pague IS NOT NULL
      AND co.status = 'A'
      AND unp.unidadenegocioid = $${paramIndex}
      AND CURRENT_TIMESTAMP BETWEEN co.datahorainicial AND co.datahorafinal
    LIMIT 1
  ) as promocao_levepague
  `;
}

// ROTA: Buscar medicamentos
app.post('/api/buscar-medicamentos', async (req, res) => {
  try {
    const { query, unidade_negocio_id } = req.body;

    if (!query || query.trim() === '') {
      return res.status(400).json({ erro: 'Query vazia' });
    }

    // Usar unidade_negocio_id do body ou padrão
    const unidadeNegocioId = unidade_negocio_id || UNIDADE_NEGOCIO_ID_PADRAO;

    const termoBusca = query.trim().toLowerCase();
    let produtos = [];
    let tipoBusca = '';
    let principiosEncontrados = [];

    // const formasFarmaceuticas = {
    //   'gotas': ['gotas', 'gts', 'gt'],
    //   'comprimido': ['comprimido', 'comprimidos', 'cp', 'comp'],
    //   'capsula': ['capsula', 'capsulas', 'caps'],
    //   'xarope': ['xarope', 'xpe'],
    //   'pomada': ['pomada', 'pom'],
    //   'creme': ['creme', 'cr'],
    //   'gel': ['gel'],
    //   'spray': ['spray'],
    //   'injetavel': ['injetavel', 'inj', 'ampola', 'amp'],
    //   'solucao': ['solucao', 'sol'],
    //   'suspensao': ['suspensao', 'susp']
    // };
    
    // Certifique-se de que o arquivo similarity.js exporta um objeto chamado `formasFarmaceuticas`
    // Exemplo de estrutura esperada no similarity.js:
    // module.exports = {
    //   formasFarmaceuticas: {
    //     'gotas': ['gotas', 'gts', 'gt'],
    //     'comprimido': ['comprimido', 'comprimidos', 'cp', 'comp'],
    //     ...
    //   }
    // };

    let principioAtivoBusca = termoBusca;
    let formaFarmaceutica = null;
    let variacoesForma = [];

    for (const [forma, variacoes] of Object.entries(formasFarmaceuticas)) {
      for (const variacao of variacoes) {
        const regex = new RegExp(`\\b${variacao}\\b`, 'i');
        if (regex.test(termoBusca)) {
          formaFarmaceutica = forma;
          variacoesForma = variacoes;
          principioAtivoBusca = termoBusca.replace(regex, '').trim();
          break;
        }
      }
      if (formaFarmaceutica) break;
    }

    console.log(`\n========================================`);
    console.log(`[BUSCA] Termo original: "${termoBusca}"`);
    console.log(`[BUSCA] Princípio ativo: "${principioAtivoBusca}"`);
    console.log(`[BUSCA] Forma farmacêutica: "${formaFarmaceutica || 'nenhuma'}"`);
    console.log(`[BUSCA] Unidade Negócio ID: ${unidadeNegocioId}`);
    console.log(`========================================\n`);

    // ETAPA 1: LISTAR TODOS OS PRINCÍPIOS ATIVOS
    console.log(`[1] Buscando TODOS os princípios ativos que contêm: "${principioAtivoBusca}"`);
    
    const resultadoPrincipios = await pool.query(`
      SELECT DISTINCT id, nome 
      FROM principioativo 
      WHERE nome ILIKE $1
      ORDER BY nome
    `, [`%${principioAtivoBusca}%`]);

    principiosEncontrados = resultadoPrincipios.rows;
    console.log(`[1] ✅ Encontrados ${principiosEncontrados.length} princípios ativos:`);
    principiosEncontrados.forEach((pa, idx) => {
      console.log(`    ${idx + 1}. [ID: ${pa.id}] ${pa.nome}`);
    });

    // ETAPA 2: Buscar produtos
    if (principiosEncontrados.length > 0) {
      console.log(`\n[2] Buscando produtos que usam QUALQUER UM desses ${principiosEncontrados.length} princípios...`);
      
      const principioIds = principiosEncontrados.map(p => p.id);
      const principioPlaceholders = principioIds.map((_, idx) => `$${idx + 1}`).join(',');
      
      // Gerar campos com índice correto (unidadeNegocioId será o último parâmetro)
      const unidadeParamIndex = principioIds.length + (formaFarmaceutica ? variacoesForma.length : 0) + 1;
      const camposPreco = gerarCamposPreco(unidadeParamIndex);
      
      let queryProdutos = `
        SELECT ${camposPreco}
        FROM produto p
        INNER JOIN principioativo pa ON p.principioativoid = pa.id
        INNER JOIN embalagem em ON em.produtoid = p.id
        INNER JOIN estoque e ON e.embalagemid = em.id
        WHERE pa.id IN (${principioPlaceholders})
          AND p.status = 'A'
          AND e.unidadenegocioid = $${unidadeParamIndex}
          AND COALESCE(e.estoque, 0) > 0
      `;
      
      let params = [...principioIds];

      if (formaFarmaceutica && variacoesForma.length > 0) {
        const startIdx = principioIds.length + 1;
        const formaPlaceholders = variacoesForma.map((_, idx) => `p.descricao ILIKE $${startIdx + idx}`).join(' OR ');
        queryProdutos += ` AND (${formaPlaceholders})`;
        params.push(...variacoesForma.map(v => `%${v}%`));
        console.log(`[2] Filtrando por formas: ${variacoesForma.join(', ')}`);
      }

      params.push(unidadeNegocioId);
      queryProdutos += ` ORDER BY p.descricao LIMIT 100`;

      const resultadoProdutos = await pool.query(queryProdutos, params);
      produtos = resultadoProdutos.rows;
      tipoBusca = 'principio_ativo';

      console.log(`[2] ✅ Encontrados ${produtos.length} produtos`);
      
      const distribuicao = {};
      produtos.forEach(p => {
        distribuicao[p.principioativo_nome] = (distribuicao[p.principioativo_nome] || 0) + 1;
      });
      console.log(`\n[DISTRIBUIÇÃO POR PRINCÍPIO ATIVO]:`);
      Object.entries(distribuicao).forEach(([pa, count]) => {
        console.log(`    - ${pa}: ${count} produto(s)`);
      });

      // FALLBACK sem forma
      if (produtos.length === 0 && formaFarmaceutica) {
        console.log(`\n[2.5] 🔄 Tentando busca SEM filtro de forma farmacêutica...`);
        
        const unidadeParamIndexSemForma = principioIds.length + 1;
        const camposPrecoSemForma = gerarCamposPreco(unidadeParamIndexSemForma);
        
        const queryProdutosSemForma = `
          SELECT ${camposPrecoSemForma}
          FROM produto p
          INNER JOIN principioativo pa ON p.principioativoid = pa.id
          INNER JOIN embalagem em ON em.produtoid = p.id
          INNER JOIN estoque e ON e.embalagemid = em.id
          WHERE pa.id IN (${principioPlaceholders})
            AND p.status = 'A'
            AND e.unidadenegocioid = $${unidadeParamIndexSemForma}
            AND COALESCE(e.estoque, 0) > 0
          ORDER BY p.descricao
          LIMIT 100
        `;
        
        const resultadoProdutosSemForma = await pool.query(queryProdutosSemForma, [...principioIds, unidadeNegocioId]);
        produtos = resultadoProdutosSemForma.rows;
        tipoBusca = 'principio_ativo_sem_forma';
        console.log(`[2.5] ✅ Encontrados ${produtos.length} produtos (sem filtro de forma)`);
      }
    }

    // ETAPA 3: Buscar por DESCRIÇÃO
    if (produtos.length === 0) {
      console.log(`\n[3] ❌ Não encontrou por princípio ativo. Buscando por descrição...`);
      
      const camposPrecoDesc = gerarCamposPreco(2);
      
      const resultadoDescricao = await pool.query(`
        SELECT ${camposPrecoDesc}
        FROM produto p
        LEFT JOIN principioativo pa ON p.principioativoid = pa.id
        INNER JOIN embalagem em ON em.produtoid = p.id
        INNER JOIN estoque e ON e.embalagemid = em.id
        WHERE p.descricao ILIKE $1
          AND p.status = 'A'
          AND e.unidadenegocioid = $2
          AND COALESCE(e.estoque, 0) > 0
        ORDER BY p.descricao
        LIMIT 100
      `, [`%${termoBusca}%`, unidadeNegocioId]);
    
      produtos = resultadoDescricao.rows;
      tipoBusca = 'descricao';
      console.log(`[3] ✅ Encontrados ${produtos.length} produtos por descrição`);
    }

    console.log(`\n[RESULTADO FINAL] ${produtos.length} produtos encontrados via ${tipoBusca}`);

    // ETAPA 4: IA
    let produtosOrdenados = produtos;
    let usouIA = false;

    if (produtos.length > 1 && OPENAI_API_KEY && OPENAI_API_KEY !== 'sua-chave-aqui') {
      console.log(`\n[4] 🤖 Usando IA para ordenar ${produtos.length} produtos...`);
      
      try {
        produtosOrdenados = await ordenarProdutosPorIA(produtos, termoBusca);
        usouIA = true;
        console.log(`[4] ✅ Produtos ordenados por IA`);
      } catch (error) {
        console.error(`[4] ⚠️  Erro ao usar IA:`, error.message);
        produtosOrdenados = produtos;
      }
    }

    console.log(`========================================\n`);

    return res.status(200).json({
      query_original: termoBusca,
      principio_ativo_extraido: principioAtivoBusca !== termoBusca ? principioAtivoBusca : null,
      forma_farmaceutica: formaFarmaceutica,
      tipo_busca: tipoBusca,
      ordenado_por_ia: usouIA,
      unidade_negocio_id: unidadeNegocioId,
      principios_ativos_encontrados: principiosEncontrados.map(p => ({
        id: p.id,
        nome: p.nome
      })),
      total_principios_ativos: principiosEncontrados.length,
      total_resultados: produtosOrdenados.length,
      produtos: produtosOrdenados.map(p => ({
        id: p.id,
        codigo: p.codigo,
        descricao: p.descricao,
        principio_ativo: p.principioativo_nome || null,
        principio_ativo_id: p.principioativo_id,
        registro_ms: p.registroms,
        fabricante_id: p.fabricanteid,
        embalagem_id: p.embalagemid,
        embalagem_descricao: p.embalagem_descricao,
        codigo_barras: p.codigobarras || null,
        estoque_disponivel: p.estoque_disponivel,
        
        preco: {
          normal: p.preco_normal ? parseFloat(p.preco_normal) : null,
          oferta: p.menor_preco_oferta ? parseFloat(p.menor_preco_oferta) : null,
          final: p.preco_final ? parseFloat(p.preco_final) : null,
          desconto_percentual: p.desconto_percentual ? parseFloat(p.desconto_percentual) : null,
          tem_oferta: p.menor_preco_oferta !== null || p.desconto_percentual !== null,
          economia: p.preco_normal && p.preco_final && p.preco_final < p.preco_normal
            ? parseFloat((p.preco_normal - p.preco_final).toFixed(2))
            : null,
          percentual_economia: p.preco_normal && p.preco_final && p.preco_final < p.preco_normal
            ? parseFloat((((p.preco_normal - p.preco_final) / p.preco_normal) * 100).toFixed(2))
            : null
        },
        
        origem_oferta: {
          oferta_preco: p.origem_oferta_preco || null,
          oferta_desconto: p.origem_oferta_desconto || null
        },
        
        promocao_levepague: p.promocao_levepague || null,
        relevancia_score: p.relevancia_score || null
      }))
    });

  } catch (error) {
    console.error('❌ Erro ao buscar medicamentos:', error);
    return res.status(500).json({
      erro: 'Erro ao processar busca',
      detalhes: error.message
    });
  }
});

async function ordenarProdutosPorIA(produtos, buscaOriginal) {
  try {
    const MAX_PRODUTOS_IA = 30;
    const produtosParaIA = produtos.slice(0, MAX_PRODUTOS_IA);
    const produtosRestantes = produtos.slice(MAX_PRODUTOS_IA);

    const listaProdutos = produtosParaIA.map((p, idx) => ({
      index: idx,
      descricao: p.descricao ?? "",
      principio_ativo: p.principioativo_nome ?? ""
    }));

    const prompt = `Analise os produtos abaixo e ordene por relevância para a busca: "${buscaOriginal}"

Produtos:
${JSON.stringify(listaProdutos, null, 2)}

Critérios de relevância:
1. Correspondência exata do princípio ativo > correspondência parcial
2. Correspondência da forma farmacêutica (se houver na busca)
3. Descrição mais próxima da busca

IMPORTANTE: Retorne APENAS um array JSON com os índices ordenados. Exemplo: [5,2,0,1,3,4]
Não inclua explicações, apenas o array.`;

    const response = await axios.post(
      OPENAI_API_URL,
      {
        model: 'gpt-4.1',
        messages: [
          {
            role: 'system',
            content: 'Você é um especialista em classificação de medicamentos. Responda SEMPRE e APENAS com um array JSON de números, sem texto adicional, sem markdown, sem explicações.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.1,
        max_tokens: 500
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    let texto = response.data.choices[0].message.content.trim();
    texto = texto.replace(/```json/g, '').replace(/```/g, '').trim();
    const match = texto.match(/\[[\d,\s]+\]/);

    if (!match) {
      throw new Error("IA não retornou array válido.");
    }

    const indices = JSON.parse(match[0]);

    if (indices.length !== produtosParaIA.length) {
      throw new Error(`IA retornou ${indices.length} índices, esperado ${produtosParaIA.length}.`);
    }

    const produtosOrdenados = indices.map((i, pos) => ({
      ...produtosParaIA[i],
      relevancia_score: produtosParaIA.length - pos
    }));

    if (produtosRestantes.length > 0) {
      produtosRestantes.forEach(p => {
        produtosOrdenados.push({ ...p, relevancia_score: 0 });
      });
    }

    return produtosOrdenados;

  } catch (error) {
    console.error("[IA] Erro:", error.message);
    throw error;
  }
}

app.get('/', (req, res) => {
  res.json({ mensagem: 'API de busca de medicamentos está rodando!' });
});

const PORT = process.env.PORT || 5232;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📍 Rota de busca: POST http://localhost:${PORT}/api/buscar-medicamentos`);
});