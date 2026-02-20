const { pool } = require('./pool');
const { expandirAbreviacoes, gerarCondicoesBuscaComRanking } = require('../../abreviacoes');

async function buscarPrecosEOfertas(embalagemIds, unidadeNegocioId) {
  console.log(`\n[PREÇOS] Buscando preços e ofertas para ${embalagemIds.length} embalagens...`);

  if (embalagemIds.length === 0) {
    return {};
  }

  try {
    const placeholders = embalagemIds.map((_, idx) => `$${idx + 1}`).join(',');

    const query = `
      SELECT 
        em.id as embalagem_id,
        
        -- Preços da tabela EMBALAGEM (padrão geral)
        em.precoreferencial as preco_referencial_geral,
        em.precovenda as preco_venda_geral,
        em.markup as markup_geral,
        
        -- Preços específicos da UNIDADE DE NEGÓCIO
        peu.precoreferencial as preco_referencial_loja,
        peu.precovenda as preco_venda_loja,
        peu.markup as markup_loja,
        peu.plugpharmaprecocontrolado,
        
        -- Melhor oferta ativa
        mo.precooferta as preco_melhor_oferta,
        mo.descontooferta as desconto_oferta_percentual,
        mo.precounitariosemdesconto as preco_sem_desconto,
        mo.precounitariocomdesconto as preco_com_desconto,
        mo.vigenciainicio as oferta_inicio,
        mo.vigenciatermino as oferta_fim,
        
        -- Caderno de oferta relacionado
        co.nome as nome_caderno_oferta,
        ico.tipooferta,
        ico.leve,
        ico.pague,
        
        -- Preço FINAL (lógica de prioridade)
        CASE
          WHEN mo.precooferta IS NOT NULL 
            AND (mo.vigenciatermino IS NULL OR mo.vigenciatermino >= NOW())
          THEN mo.precooferta
          WHEN peu.precovenda IS NOT NULL 
          THEN peu.precovenda
          ELSE em.precovenda
        END as preco_final_venda,
        
        -- Indicador de oferta ativa
        CASE
          WHEN mo.precooferta IS NOT NULL 
            AND (mo.vigenciatermino IS NULL OR mo.vigenciatermino >= NOW())
          THEN true
          ELSE false
        END as tem_oferta_ativa

      FROM embalagem em
      
      LEFT JOIN precoembalagemunidadenegocio peu 
        ON peu.embalagemid = em.id 
        AND peu.unidadenegocioid = $${embalagemIds.length + 1}
      
      LEFT JOIN melhoroferta mo 
        ON mo.embalagemid = em.id 
        AND mo.unidadenegocioid = $${embalagemIds.length + 1}
        AND (mo.vigenciatermino IS NULL OR mo.vigenciatermino >= NOW())
      
      LEFT JOIN itemcadernooferta ico 
        ON ico.id = (
          SELECT ico2.id 
          FROM itemcadernooferta ico2
          WHERE ico2.embalagemid = em.id 
            AND ico2.cadernoofertaid = mo.cadernoofertaid
          LIMIT 1
        )
      
      LEFT JOIN cadernooferta co 
        ON co.id = mo.cadernoofertaid
      
      WHERE em.id IN (${placeholders})
    `;

    const params = [...embalagemIds, unidadeNegocioId];
    const resultado = await pool.query(query, params);

    const precosMap = {};
    resultado.rows.forEach(row => {
      precosMap[row.embalagem_id] = {
        preco_referencial_geral: parseFloat(row.preco_referencial_geral) || null,
        preco_venda_geral: parseFloat(row.preco_venda_geral) || null,
        markup_geral: parseFloat(row.markup_geral) || null,
        preco_referencial_loja: parseFloat(row.preco_referencial_loja) || null,
        preco_venda_loja: parseFloat(row.preco_venda_loja) || null,
        markup_loja: parseFloat(row.markup_loja) || null,
        plugpharma_preco_controlado: parseFloat(row.plugpharmaprecocontrolado) || null,
        preco_melhor_oferta: parseFloat(row.preco_melhor_oferta) || null,
        desconto_oferta_percentual: parseFloat(row.desconto_oferta_percentual) || null,
        preco_sem_desconto: parseFloat(row.preco_sem_desconto) || null,
        preco_com_desconto: parseFloat(row.preco_com_desconto) || null,
        oferta_inicio: row.oferta_inicio,
        oferta_fim: row.oferta_fim,
        nome_caderno_oferta: row.nome_caderno_oferta,
        tipo_oferta: row.tipooferta,
        leve: row.leve,
        pague: row.pague,
        preco_final_venda: parseFloat(row.preco_final_venda) || null,
        tem_oferta_ativa: row.tem_oferta_ativa || false
      };
    });

    console.log(`[PREÇOS] ✅ Encontrados preços para ${Object.keys(precosMap).length} embalagens`);
    const comOferta = Object.values(precosMap).filter(p => p.tem_oferta_ativa).length;
    if (comOferta > 0) {
      console.log(`[PREÇOS] 🎯 ${comOferta} produto(s) com oferta ativa`);
    }

    return precosMap;
  } catch (error) {
    console.error(`[PREÇOS] ⚠️ Erro:`, error.message);
    return {};
  }
}

async function buscarPorDescricao(termoBusca) {
  console.log(`\n[ETAPA 1] Buscando por DESCRIÇÃO: "${termoBusca}"`);

  try {
    const variacoes = expandirAbreviacoes(termoBusca);

    console.log(`[ETAPA 1] 🔍 Variações geradas: ${variacoes.length}`);
    variacoes.forEach((v, idx) => {
      console.log(`         ${idx + 1}. "${v}"`);
    });

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
    }

    console.log(`[ETAPA 1] ❌ Nenhum produto encontrado`);
    return {
      encontrado: false,
      produtos: [],
      metodo: 'descricao',
      variacoes_usadas: variacoes
    };
  } catch (error) {
    console.error(`[ETAPA 1] ⚠️ Erro:`, error.message);
    throw error;
  }
}

async function buscarPorPrincipioAtivo(principioAtivo, formaFarmaceutica, variacoesForma) {
  console.log(`\n[ETAPA 2] Buscando por PRINCÍPIO ATIVO: "${principioAtivo}"`);

  try {
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

    if (formaFarmaceutica && variacoesForma.length > 0) {
      const startIdx = principioIds.length + 1;
      const formaPlaceholders = variacoesForma.map((_, idx) => `p.descricao ILIKE $${startIdx + idx}`).join(' OR ');
      queryProdutos += ` AND (${formaPlaceholders})`;
      params.push(...variacoesForma.map(v => `%${v}%`));
      console.log(`[ETAPA 2] 🔍 Filtrando por formas: ${variacoesForma.join(', ')}`);
    }

    queryProdutos += ` ORDER BY p.descricao LIMIT 100`;

    const resultadoProdutos = await pool.query(queryProdutos, params);

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

    const precosMap = await buscarPrecosEOfertas(embalagemIds, unidadeNegocioId);

    produtos.forEach(produto => {
      produto.estoque_disponivel = estoqueMap[produto.embalagem_id] || 0;
      produto.tem_estoque = (estoqueMap[produto.embalagem_id] || 0) > 0;

      const precoInfo = precosMap[produto.embalagem_id] || {};
      produto.precos = precoInfo;
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

module.exports = {
  buscarPrecosEOfertas,
  buscarPorDescricao,
  buscarPorPrincipioAtivo,
  verificarDisponibilidade
};
