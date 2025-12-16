// app.js - Express.js 
const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

// Configuração da OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

const pool = new Pool({
  host: '204.216.147.179',
  port: 5432,
  database: 'superpopular_esc_2024_02_26',
  user: 'unicocontato',
  password: 'PTltrv0RG6wqePEZ'
});

// ============================================================
// CONSTANTE: CAMPOS DE PREÇO PARA REUTILIZAÇÃO
// ============================================================
const QUERY_CAMPOS_PRECO = `
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
  
  -- ✅ PREÇO NORMAL DA EMBALAGEM
  em.precovenda as preco_normal,
  
  -- ✅ MENOR PREÇO DE OFERTA VÁLIDO
  (
    SELECT MIN(ico.precooferta)
    FROM itemcadernooferta ico
    INNER JOIN cadernooferta co ON co.id = ico.cadernoofertaid
    INNER JOIN unidadenegocioparticipantecadernooferta unp 
      ON unp.cadernoofertaid = co.id
    WHERE ico.embalagemid = em.id
      AND ico.tipooferta = 'P'
      AND co.status = 'A'
      AND unp.unidadenegocioid = 65984
      AND CURRENT_TIMESTAMP BETWEEN co.datahorainicial AND co.datahorafinal
  ) as menor_preco_oferta,
  
  -- ✅ ORIGEM DA OFERTA DE PREÇO (caderno de ofertas)
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
      AND unp.unidadenegocioid = 65984
      AND CURRENT_TIMESTAMP BETWEEN co.datahorainicial AND co.datahorafinal
    ORDER BY ico.precooferta ASC
    LIMIT 1
  ) as origem_oferta_preco,
  
  -- ✅ DESCONTO PERCENTUAL
  (
    SELECT MAX(ico.descontooferta)
    FROM itemcadernooferta ico
    INNER JOIN cadernooferta co ON co.id = ico.cadernoofertaid
    INNER JOIN unidadenegocioparticipantecadernooferta unp 
      ON unp.cadernoofertaid = co.id
    WHERE ico.embalagemid = em.id
      AND ico.tipooferta = 'D'
      AND co.status = 'A'
      AND unp.unidadenegocioid = 65984
      AND CURRENT_TIMESTAMP BETWEEN co.datahorainicial AND co.datahorafinal
  ) as desconto_percentual,
  
  -- ✅ ORIGEM DA OFERTA DE DESCONTO
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
      AND unp.unidadenegocioid = 65984
      AND CURRENT_TIMESTAMP BETWEEN co.datahorainicial AND co.datahorafinal
    ORDER BY ico.descontooferta DESC
    LIMIT 1
  ) as origem_oferta_desconto,
  
  -- ✅ PREÇO FINAL (melhor preço disponível)
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
        AND unp.unidadenegocioid = 65984
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
        AND unp.unidadenegocioid = 65984
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
          AND unp.unidadenegocioid = 65984
          AND CURRENT_TIMESTAMP BETWEEN co.datahorainicial AND co.datahorafinal
      ),
      em.precovenda
    )
  END as preco_final,
  
  -- ✅ PROMOÇÃO LEVE/PAGUE
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
      AND unp.unidadenegocioid = 65984
      AND CURRENT_TIMESTAMP BETWEEN co.datahorainicial AND co.datahorafinal
    LIMIT 1
  ) as promocao_levepague
`;

// ROTA: Buscar medicamentos
app.post('/api/buscar-medicamentos', async (req, res) => {
  try {
    const { query } = req.body;

    if (!query || query.trim() === '') {
      return res.status(400).json({ erro: 'Query vazia' });
    }

    const termoBusca = query.trim().toLowerCase();
    let produtos = [];
    let tipoBusca = '';
    let principiosEncontrados = [];

    // Detectar formas farmacêuticas (com suas variações/abreviações)
    const formasFarmaceuticas = {
      'gotas': ['gotas', 'gts', 'gt'],
      'comprimido': ['comprimido', 'comprimidos', 'cp', 'comp'],
      'capsula': ['capsula', 'capsulas', 'caps'],
      'xarope': ['xarope', 'xpe'],
      'pomada': ['pomada', 'pom'],
      'creme': ['creme', 'cr'],
      'gel': ['gel'],
      'spray': ['spray'],
      'injetavel': ['injetavel', 'inj', 'ampola', 'amp'],
      'solucao': ['solucao', 'sol'],
      'suspensao': ['suspensao', 'susp']
    };
    
    let principioAtivoBusca = termoBusca;
    let formaFarmaceutica = null;
    let variacoesForma = [];

    // Detectar forma farmacêutica na busca
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
    console.log(`========================================\n`);

    // ETAPA 1: LISTAR TODOS OS PRINCÍPIOS ATIVOS que contêm o termo
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

    // ETAPA 2: Buscar TODOS os produtos que usam QUALQUER UM desses princípios
    if (principiosEncontrados.length > 0) {
      console.log(`\n[2] Buscando produtos que usam QUALQUER UM desses ${principiosEncontrados.length} princípios...`);
      
      const principioIds = principiosEncontrados.map(p => p.id);
      
      let queryProdutos = `
        SELECT ${QUERY_CAMPOS_PRECO}
        FROM produto p
        INNER JOIN principioativo pa ON p.principioativoid = pa.id
        INNER JOIN embalagem em ON em.produtoid = p.id
        INNER JOIN estoque e ON e.embalagemid = em.id
        WHERE pa.id = ANY($1)
          AND p.status = 'A'
          AND e.unidadenegocioid = 65984
          AND COALESCE(e.estoque, 0) > 0
      `;
      
      const params = [principioIds];

      // Se tiver forma farmacêutica, filtrar por TODAS as variações
      if (formaFarmaceutica && variacoesForma.length > 0) {
        const condicoesForma = variacoesForma.map((_, idx) => `p.descricao ILIKE $${idx + 2}`).join(' OR ');
        queryProdutos += ` AND (${condicoesForma})`;
        variacoesForma.forEach(variacao => {
          params.push(`%${variacao}%`);
        });
        
        console.log(`[2] Filtrando por formas: ${variacoesForma.join(', ')}`);
      }

      queryProdutos += ` ORDER BY p.descricao LIMIT 100`;

      const resultadoProdutos = await pool.query(queryProdutos, params);
      produtos = resultadoProdutos.rows;
      tipoBusca = 'principio_ativo';

      console.log(`[2] ✅ Encontrados ${produtos.length} produtos`);
      
      // Mostrar distribuição por princípio ativo
      const distribuicao = {};
      produtos.forEach(p => {
        distribuicao[p.principioativo_nome] = (distribuicao[p.principioativo_nome] || 0) + 1;
      });
      console.log(`\n[DISTRIBUIÇÃO POR PRINCÍPIO ATIVO]:`);
      Object.entries(distribuicao).forEach(([pa, count]) => {
        console.log(`    - ${pa}: ${count} produto(s)`);
      });

      // OPÇÃO 3: FALLBACK - Se não achou com forma farmacêutica, busca sem ela
      if (produtos.length === 0 && formaFarmaceutica) {
        console.log(`\n[2.5] ⚠️  Nenhum produto encontrado com filtro de forma farmacêutica.`);
        console.log(`[2.5] 🔄 Tentando busca SEM filtro de forma farmacêutica...`);
        
        const queryProdutosSemForma = `
          SELECT ${QUERY_CAMPOS_PRECO}
          FROM produto p
          INNER JOIN principioativo pa ON p.principioativoid = pa.id
          INNER JOIN embalagem em ON em.produtoid = p.id
          INNER JOIN estoque e ON e.embalagemid = em.id
          WHERE pa.id = ANY($1)
            AND p.status = 'A'
            AND e.unidadenegocioid = 65984
            AND COALESCE(e.estoque, 0) > 0
          ORDER BY p.descricao
          LIMIT 100
        `;
        
        const resultadoProdutosSemForma = await pool.query(queryProdutosSemForma, [principioIds]);
        produtos = resultadoProdutosSemForma.rows;
        tipoBusca = 'principio_ativo_sem_forma';

        console.log(`[2.5] ✅ Encontrados ${produtos.length} produtos (sem filtro de forma)`);
        
        // Mostrar distribuição por princípio ativo
        const distribuicaoSemForma = {};
        produtos.forEach(p => {
          distribuicaoSemForma[p.principioativo_nome] = (distribuicaoSemForma[p.principioativo_nome] || 0) + 1;
        });
        console.log(`\n[DISTRIBUIÇÃO POR PRINCÍPIO ATIVO (sem forma)]:`);
        Object.entries(distribuicaoSemForma).forEach(([pa, count]) => {
          console.log(`    - ${pa}: ${count} produto(s)`);
        });
      }
    }

    // ETAPA 3: Se não achou por PRINCÍPIO ATIVO, buscar por DESCRIÇÃO
    if (produtos.length === 0) {
      console.log(`\n[3] ❌ Não encontrou por princípio ativo. Buscando por descrição...`);
      
      const resultadoDescricao = await pool.query(`
        SELECT ${QUERY_CAMPOS_PRECO}
        FROM produto p
        LEFT JOIN principioativo pa ON p.principioativoid = pa.id
        INNER JOIN embalagem em ON em.produtoid = p.id
        INNER JOIN estoque e ON e.embalagemid = em.id
        WHERE p.descricao ILIKE $1
          AND p.status = 'A'
          AND e.unidadenegocioid = 65984
          AND COALESCE(e.estoque, 0) > 0
        ORDER BY p.descricao
        LIMIT 100
      `, [`%${termoBusca}%`]);
    
      produtos = resultadoDescricao.rows;
      tipoBusca = 'descricao';
      console.log(`[3] ✅ Encontrados ${produtos.length} produtos por descrição`);
    }

    // Resposta
    console.log(`\n[RESULTADO FINAL] ${produtos.length} produtos encontrados via ${tipoBusca}`);

    // ETAPA 4: USAR IA PARA ORDENAR POR RELEVÂNCIA
    let produtosOrdenados = produtos;
    let usouIA = false;

    if (produtos.length > 1 && OPENAI_API_KEY !== 'sua-chave-aqui') {
      console.log(`\n[4] 🤖 Usando IA para ordenar ${produtos.length} produtos por relevância...`);
      
      try {
        produtosOrdenados = await ordenarProdutosPorIA(produtos, termoBusca);
        usouIA = true;
        console.log(`[4] ✅ Produtos ordenados por IA com sucesso`);
      } catch (error) {
        console.error(`[4] ⚠️  Erro ao usar IA, mantendo ordem original:`, error.message);
        produtosOrdenados = produtos;
      }
    } else if (produtos.length > 1) {
      console.log(`\n[4] ⚠️  Chave da OpenAI não configurada. Mantendo ordem original.`);
    }

    console.log(`========================================\n`);

    return res.status(200).json({
      query_original: termoBusca,
      principio_ativo_extraido: principioAtivoBusca !== termoBusca ? principioAtivoBusca : null,
      forma_farmaceutica: formaFarmaceutica,
      tipo_busca: tipoBusca,
      ordenado_por_ia: usouIA,
      unidade_negocio_id: 65984,
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
        estoque_disponivel: p.estoque_disponivel,
        
        // ✅ PREÇOS COMPLETOS
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
        
        // ✅ ORIGEM DAS OFERTAS
        origem_oferta: {
          oferta_preco: p.origem_oferta_preco || null,
          oferta_desconto: p.origem_oferta_desconto || null
        },
        
        // ✅ PROMOÇÃO LEVE/PAGUE
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

// Função para ordenar produtos usando IA (ChatGPT)
async function ordenarProdutosPorIA(produtos, buscaOriginal) {
  try {
    // Para muitos produtos, pegar apenas os 30 primeiros para IA ordenar
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
            content: 'Você é um especialista em classificação de medicamentos. Responda SEMPRE e APENAS com um array JSON de números, sem texto adicional, sem markdown, sem explicações. Exemplo de resposta válida: [2,0,5,1,3,4]'
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
    
    // Remover markdown se houver
    texto = texto.replace(/```json/g, '').replace(/```/g, '').trim();
    
    // Tentar encontrar o array JSON
    const match = texto.match(/\[[\d,\s]+\]/);

    if (!match) {
      console.error("[IA] Resposta recebida:", texto);
      throw new Error("IA não retornou array de índices válido.");
    }

    const indices = JSON.parse(match[0]);

    if (indices.length !== produtosParaIA.length) {
      console.error(`[IA] Esperado ${produtosParaIA.length} índices, recebido ${indices.length}`);
      throw new Error(`A IA retornou ${indices.length} índices mas eram esperados ${produtosParaIA.length}.`);
    }

    // Validar que todos os índices estão no range correto
    const indicesValidos = indices.every(i => i >= 0 && i < produtosParaIA.length);
    if (!indicesValidos) {
      throw new Error("A IA retornou índices fora do range válido.");
    }

    // Ordenar os produtos conforme IA
    const produtosOrdenados = indices.map((i, pos) => ({
      ...produtosParaIA[i],
      relevancia_score: produtosParaIA.length - pos
    }));

    // Adicionar os produtos restantes no final (se houver)
    if (produtosRestantes.length > 0) {
      console.log(`[IA] Adicionando ${produtosRestantes.length} produtos restantes ao final`);
      produtosRestantes.forEach(p => {
        produtosOrdenados.push({
          ...p,
          relevancia_score: 0
        });
      });
    }

    return produtosOrdenados;

  } catch (error) {
    console.error("[IA] Erro:", error.message);
    if (error.response) {
      console.error("[IA] Resposta da API:", error.response.data);
    }
    throw error;
  }
}

// Rota de teste
app.get('/', (req, res) => {
  res.json({ mensagem: 'API de busca de medicamentos está rodando!' });
});

// Iniciar servidor
const PORT = process.env.PORT || 5232;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📍 Rota de busca: POST http://localhost:${PORT}/api/buscar-medicamentos`);
});