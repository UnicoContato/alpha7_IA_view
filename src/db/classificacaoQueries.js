const { pool } = require('./pool');

const CLASSIFICACAO_PRIORIDADE = {
  REFERENCIA: 3,
  GENERICO: 2,
  SIMILAR: 1,
  DESCONHECIDO: 0
};

let fonteClassificacaoCache = null;
const STOPWORDS_ATIVO = new Set([
  'de', 'da', 'do', 'das', 'dos', 'e', 'com', 'c', 'sem',
  'mg', 'ml', 'g', 'mcg', 'ui', 'cp', 'cps', 'caps', 'fr', 'amp'
]);

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

function normalizarTexto(valor) {
  return String(valor || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extrairTokensRelevantes(texto) {
  return normalizarTexto(texto)
    .split(' ')
    .filter(token => token.length >= 4 && !STOPWORDS_ATIVO.has(token));
}

function ehClassificacaoAdministrativa(nomeClassificacao) {
  const nome = normalizarTexto(nomeClassificacao);
  if (!nome) return true;

  return (
    nome.includes('otc') ||
    nome.includes('mip') ||
    nome.includes('propag') ||
    nome.includes('tarja') ||
    nome.includes('controlad') ||
    nome.includes('politica') ||
    nome.includes('promoc')
  );
}

function inferirTipoPorDescricaoEAtivo(produto, tipoAtual, nomeClassificacao) {
  if (tipoAtual && tipoAtual !== 'DESCONHECIDO') {
    return tipoAtual;
  }

  if (!produto?.principioativo_nome) {
    return tipoAtual || null;
  }

  if (!ehClassificacaoAdministrativa(nomeClassificacao)) {
    return tipoAtual || null;
  }

  const descricao = normalizarTexto(produto.descricao);
  const tokensAtivo = extrairTokensRelevantes(produto.principioativo_nome);
  if (tokensAtivo.length === 0) {
    return 'REFERENCIA';
  }

  const primeiroTokenAtivo = tokensAtivo[0];
  const comecaComAtivo = descricao.startsWith(`${primeiroTokenAtivo} `) || descricao === primeiroTokenAtivo;
  const matches = tokensAtivo.filter(token => descricao.includes(token)).length;

  if (comecaComAtivo || matches >= Math.min(2, tokensAtivo.length)) {
    return 'GENERICO';
  }

  return 'REFERENCIA';
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
      classificacao_id_origem: row.classificacaoid,
      classificacao_nome_origem: row.classificacao_nome_origem || null
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
      ccm.tipo_canonico,
      ccm.nome_origem AS classificacao_nome_origem
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

  const fkResultado = await pool.query(`
    SELECT
      ccu.table_name AS table_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema = tc.table_schema
    WHERE tc.table_schema = 'public'
      AND tc.table_name = 'classificacaoproduto'
      AND tc.constraint_type = 'FOREIGN KEY'
      AND kcu.column_name = 'classificacaoid'
    LIMIT 1
  `);

  if (fkResultado.rows.length > 0) {
    const tabelaFk = fkResultado.rows[0].table_name;
    const colunasPreferidas = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name IN ('nome', 'descricao', 'titulo')
      ORDER BY
        CASE
          WHEN column_name = 'nome' THEN 0
          WHEN column_name = 'descricao' THEN 1
          ELSE 2
        END
      LIMIT 1
    `, [tabelaFk]);

    if (colunasPreferidas.rows.length > 0) {
      fonteClassificacaoCache = {
        tableName: tabelaFk,
        nameColumn: colunasPreferidas.rows[0].column_name
      };
      return fonteClassificacaoCache;
    }
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
  const nomeNormalizado = `
    lower(
      translate(
        coalesce(cls.${colunaNome}, ''),
        'ÁÀÃÂÄáàãâäÉÈÊËéèêëÍÌÎÏíìîïÓÒÕÔÖóòõôöÚÙÛÜúùûüÇç',
        'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCc'
      )
    )
  `;

  const query = `
    SELECT
      cp.produtoid,
      cp.classificacaoid,
      cls.${colunaNome} AS classificacao_nome_origem,
      CASE
        WHEN ${nomeNormalizado} LIKE '%gener%' THEN 'GENERICO'
        WHEN ${nomeNormalizado} LIKE '%simil%' THEN 'SIMILAR'
        WHEN ${nomeNormalizado} LIKE '%refer%'
          OR ${nomeNormalizado} LIKE '%marca%'
          OR ${nomeNormalizado} LIKE '%etic%'
          OR ${nomeNormalizado} LIKE '%inovad%'
          OR ${nomeNormalizado} LIKE '%patente%'
        THEN 'REFERENCIA'
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
    const tipoCanonico = inferirTipoPorDescricaoEAtivo(
      produto,
      classificacao?.tipo_classificacao_canonica || null,
      classificacao?.classificacao_nome_origem || null
    );

    return {
      ...produto,
      tipo_classificacao_canonica: tipoCanonico || null,
      classificacao_id_origem: classificacao?.classificacao_id_origem || null,
      classificacao_nome_origem: classificacao?.classificacao_nome_origem || null
    };
  });
}

module.exports = {
  enriquecerClassificacaoCanonica
};
