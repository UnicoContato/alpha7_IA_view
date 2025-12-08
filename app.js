// app.js - Express.js
const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const pool = new Pool({
  host: '204.216.147.179',
  port: 5432,
  database: 'superpopular_esc_2024_02_26',
  user: 'unicocontato',
  password: 'PTltrv0RG6wqePEZ'
});

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
      
      // Construir query dinâmica com os IDs dos princípios ativos encontrados
      const principioIds = principiosEncontrados.map(p => p.id);
      
      let queryProdutos = `
        SELECT 
          p.id,
          p.codigo,
          p.descricao,
          p.status,
          p.registroms,
          p.fabricanteid,
          pa.id as principioativo_id,
          pa.nome as principioativo_nome
        FROM produto p
        INNER JOIN principioativo pa ON p.principioativoid = pa.id
        WHERE pa.id = ANY($1)
          AND p.status = 'A'
      `;

      const params = [principioIds];

      // Se tiver forma farmacêutica, filtrar por TODAS as variações
      if (formaFarmaceutica && variacoesForma.length > 0) {
        const condicoesForma = variacoesForma.map((_, idx) => `p.descricao ILIKE ${idx + 2}`).join(' OR ');
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
    }

    // ETAPA 3: Se não achou por PRINCÍPIO ATIVO, buscar por DESCRIÇÃO
    if (produtos.length === 0) {
      console.log(`\n[3] ❌ Não encontrou por princípio ativo. Buscando por descrição...`);
      
      const resultadoDescricao = await pool.query(`
        SELECT 
          p.id,
          p.codigo,
          p.descricao,
          p.status,
          p.registroms,
          p.fabricanteid,
          pa.id as principioativo_id,
          pa.nome as principioativo_nome
        FROM produto p
        LEFT JOIN principioativo pa ON p.principioativoid = pa.id
        WHERE p.descricao ILIKE $1
          AND p.status = 'A'
        ORDER BY p.descricao
        LIMIT 100
      `, [`%${termoBusca}%`]);

      produtos = resultadoDescricao.rows;
      tipoBusca = 'descricao';
      console.log(`[3] ✅ Encontrados ${produtos.length} produtos por descrição`);
    }

    // Resposta
    console.log(`\n[RESULTADO FINAL] ${produtos.length} produtos encontrados via ${tipoBusca}`);
    console.log(`========================================\n`);

    
    return res.status(200).json({
      query_original: termoBusca,
      principio_ativo_extraido: principioAtivoBusca !== termoBusca ? principioAtivoBusca : null,
      forma_farmaceutica: formaFarmaceutica,
      tipo_busca: tipoBusca,
      principios_ativos_encontrados: principiosEncontrados.map(p => ({
        id: p.id,
        nome: p.nome
      })),
      total_principios_ativos: principiosEncontrados.length,
      total_resultados: produtos.length,
      produtos: produtos.map(p => ({
        id: p.id,
        codigo: p.codigo,
        descricao: p.descricao,
        principio_ativo: p.principioativo_nome || null,
        principio_ativo_id: p.principioativo_id,
        registro_ms: p.registroms,
        fabricante_id: p.fabricanteid
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

// Rota de teste
app.get('/', (req, res) => {
  res.json({ mensagem: 'API de busca de medicamentos está rodando!' });
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📍 Rota de busca: POST http://localhost:${PORT}/api/buscar-medicamentos`);
});