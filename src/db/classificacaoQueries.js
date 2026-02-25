const { pool } = require('./pool');

const CLASSIFICACAO_PRIORIDADE = {
  REFERENCIA: 3,
  GENERICO: 2,
  SIMILAR: 1,
  DESCONHECIDO: 0
};

let fonteClassificacaoCache = null;

function quoteIdent(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function normalizarTipoCanonico(tipo) {
  if (!tipo) return null;

  const valor = String(tipo).trim().toUpperCase();
  if (valor === 'REFERENCIA' || valor === 'GENERICO' || valor === 'SIMILAR') {
    return valor;
  }

  return null;
}

function selecionarMelhorClassificacao(classificacaoPorProduto, row) {
  const produtoId = row.produtoid;
  const tipoCanonico = normalizarTipoCanonico(row.tipo_canonico) || 'DESCONHECIDO';
  const existente = classificacaoPorProduto.get(produtoId);
  const prioridadeAtual = CLASSIFICACAO_PRIORIDADE[tipoCanonico] ?? 0;
  const prioridadeExistente = CLASSIFICACAO_PRIORIDADE[existente?.tipo_classificacao_canonica] ?? -1;

  if (!existente || prioridadeAtual > prioridadeExistente) {
    classificacaoPorProduto.set(produtoId, {
      tipo_classificacao_canonica: tipoCanonico,
      classificacao_id_origem: row.classificacaoid
    });
  }
}

async function tentarMapeamentoManual(produtoIds, clienteIdFinal) {
  const placeholders = produtoIds.map((_, idx) => `$${idx + 1}`).join(',');
  const clienteParam = produtoIds.length + 1;

  const query = `
    SELECT
      cp.produtoid,
      cp.classificacaoid,
      ccm.tipo_canonico
    FROM classificacaoproduto cp
    LEFT JOIN classificacao_canonica_map ccm
      ON ccm.classificacaoid_origem = cp.classificacaoid
      AND ccm.cliente_id = $${clienteParam}
    WHERE cp.produtoid IN (${placeholders})
  `;

  const resultado = await pool.query(query, [...produtoIds, clienteIdFinal]);
  return resultado.rows;
}

async function descobrirFonteClassificacao() {
  if (fonteClassificacaoCache) {
    return fonteClassificacaoCache;
  }

  const resultado = await pool.query(`
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema
      AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
      AND c.table_name LIKE 'classific%'
      AND c.table_name NOT IN ('classificacaoproduto', 'classificacao_canonica_map')
      AND c.column_name IN ('nome', 'descricao')
    ORDER BY
      CASE
        WHEN c.table_name = 'classificacao' THEN 0
        ELSE 1
      END,
      CASE
        WHEN c.column_name = 'nome' THEN 0
        ELSE 1
      END
    LIMIT 1
  `);

  if (resultado.rows.length === 0) {
    fonteClassificacaoCache = null;
    return null;
  }

  fonteClassificacaoCache = {
    tableName: resultado.rows[0].table_name,
    nameColumn: resultado.rows[0].column_name
  };

  return fonteClassificacaoCache;
}

async function inferirClassificacaoPorNome(produtoIds) {
  const fonte = await descobrirFonteClassificacao();
  if (!fonte) {
    return [];
  }

  const placeholders = produtoIds.map((_, idx) => `$${idx + 1}`).join(',');
  const tabela = quoteIdent(fonte.tableName);
  const colunaNome = quoteIdent(fonte.nameColumn);

  const query = `
    SELECT
      cp.produtoid,
      cp.classificacaoid,
      CASE
        WHEN cls.${colunaNome} ILIKE '%gener%' THEN 'GENERICO'
        WHEN cls.${colunaNome} ILIKE '%simil%' THEN 'SIMILAR'
        WHEN cls.${colunaNome} ILIKE '%refer%' OR cls.${colunaNome} ILIKE '%marca%' THEN 'REFERENCIA'
        ELSE NULL
      END AS tipo_canonico
    FROM classificacaoproduto cp
    LEFT JOIN ${tabela} cls
      ON cls.id = cp.classificacaoid
    WHERE cp.produtoid IN (${placeholders})
  `;

  const resultado = await pool.query(query, produtoIds);
  return resultado.rows;
}

async function enriquecerClassificacaoCanonica(produtos, clienteId) {
  if (!Array.isArray(produtos) || produtos.length === 0) {
    return produtos;
  }

  const clienteIdFinal = clienteId || process.env.CLIENTE_ID || process.env.DB_NAME;
  const produtoIds = [...new Set(produtos.map(p => p.id).filter(Boolean))];
  if (produtoIds.length === 0) {
    return produtos;
  }

  const classificacaoPorProduto = new Map();

  try {
    if (clienteIdFinal) {
      const rowsMapeamento = await tentarMapeamentoManual(produtoIds, clienteIdFinal);
      rowsMapeamento.forEach(row => selecionarMelhorClassificacao(classificacaoPorProduto, row));
    }
  } catch (error) {
    if (error.code !== '42P01') {
      throw error;
    }
  }

  if (classificacaoPorProduto.size === 0) {
    const rowsInferidos = await inferirClassificacaoPorNome(produtoIds);
    rowsInferidos.forEach(row => selecionarMelhorClassificacao(classificacaoPorProduto, row));
  }

  return produtos.map(produto => {
    const classificacao = classificacaoPorProduto.get(produto.id);
    return {
      ...produto,
      tipo_classificacao_canonica: classificacao?.tipo_classificacao_canonica || null,
      classificacao_id_origem: classificacao?.classificacao_id_origem || null
    };
  });
}

module.exports = {
  enriquecerClassificacaoCanonica
};
