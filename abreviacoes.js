// abreviacoes.js — BUSCA INTELIGENTE COM RANKING DE RELEVÂNCIA

// 🔹 Sinônimos / abreviações curtas (EXPANSÃO CONTROLADA)
const sinonimos = {
    // Formas / embalagens
    cp: ['comprimido'],
    cpr: ['comprimido'],
    cps: ['capsula'],
    cap: ['capsula'],
    fr: ['frasco', 'fralda', 'fraldas'],  // ✅ ADICIONADO: fralda
    amp: ['ampola'],
    inj: ['injetavel'],
  
    // Tipos comuns
    gen: ['generico'],
    ref: ['referencia'],
    sim: ['similar'],
  
    // Higiene / consumo
    sh: ['shampoo'],
    xampu: ['shampoo'],
    sabon: ['sabonete'],
    fralda: ['fr', 'fraldas'],
    fraldas: ['fr', 'fralda'],
    absorvente: ['abs', 'absorv'],
  };
  
  // 🔹 Palavras descartáveis (ruído)
  const STOPWORDS = new Set([
    'de', 'da', 'do', 'dos', 'das',
    'para', 'com', 'sem',
    'ml', 'mg', 'g', 'kg', 'l', 'lt',
    'cx', 'und', 'un',
    'pct', 'kit'
  ]);
  
  // ============================================================
  // NORMALIZAÇÃO FORTE
  // ============================================================
  function normalizarTermoBusca(termo) {
    return termo
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  
  // ============================================================
  // TOKENIZAÇÃO
  // ============================================================
  function tokenizar(termoNormalizado) {
    return termoNormalizado
      .split(' ')
      .filter(t =>
        t.length > 1 &&
        !STOPWORDS.has(t) &&
        !/^\d+$/.test(t) // remove números puros
      );
  }
  
  // ============================================================
  // EXPANSÃO CONTROLADA (SEM EXPLODIR)
  // ============================================================
  function expandirTokens(tokens) {
    const resultado = new Set(tokens);
  
    tokens.forEach(token => {
      if (sinonimos[token]) {
        sinonimos[token].forEach(s => resultado.add(s));
      }
    });
  
    return Array.from(resultado);
  }
  
  // ============================================================
  // API PÚBLICA — mantém compatibilidade
  // ============================================================
  function expandirAbreviacoes(termo) {
    const normalizado = normalizarTermoBusca(termo);
    const tokens = tokenizar(normalizado);
    return expandirTokens(tokens);
  }
  
  // ============================================================
  // GERAÇÃO DE SQL COM RANKING DE RELEVÂNCIA (SOLUÇÃO!)
  // ============================================================
  function gerarCondicoesBuscaComRanking(tokens) {
    if (tokens.length === 0) {
      return {
        condicoes: '1=1',
        parametros: [],
        orderBy: 'p.descricao'
      };
    }
  
    const condicoes = [];
    const parametros = [];
    const caseStatements = [];
    let idx = 1;
  
    // Para cada token, criar condição OR
    tokens.forEach(token => {
      condicoes.push(`p.descricao ILIKE $${idx}`);
      parametros.push(`%${token}%`);
      
      // Score: +10 pontos por cada palavra que bate
      caseStatements.push(`CASE WHEN p.descricao ILIKE $${idx} THEN 10 ELSE 0 END`);
      
      idx++;
    });
  
    // Score adicional para match exato (boost de 100 pontos)
    const termoCompleto = tokens.join(' ');
    condicoes.push(`p.descricao ILIKE $${idx}`);
    parametros.push(`%${termoCompleto}%`);
    caseStatements.push(`CASE WHEN p.descricao ILIKE $${idx} THEN 100 ELSE 0 END`);
  
    // Construir ranking SQL
    const relevanciaSQL = `(${caseStatements.join(' + ')})`;
  
    return {
      condicoes: condicoes.join(' OR '),  // ✅ MUDOU DE AND PARA OR!
      parametros,
      relevanciaSQL,
      orderBy: `${relevanciaSQL} DESC, p.descricao`
    };
  }
  
  // ============================================================
  // VERSÃO ANTIGA (para compatibilidade)
  // ============================================================
  function gerarCondicoesBusca(tokens) {
    if (tokens.length === 0) {
      return {
        condicoes: '1=1',
        parametros: []
      };
    }
  
    const condicoes = [];
    const parametros = [];
    let idx = 1;
  
    tokens.forEach(token => {
      condicoes.push(`p.descricao ILIKE $${idx++}`);
      parametros.push(`%${token}%`);
    });
  
    // ✅ MUDANÇA CRÍTICA: OR ao invés de AND
    return {
      condicoes: condicoes.join(' OR '),
      parametros
    };
  }
  
  module.exports = {
    normalizarTermoBusca,
    expandirAbreviacoes,
    gerarCondicoesBusca,
    gerarCondicoesBuscaComRanking  // ✅ NOVA FUNÇÃO COM RANKING
  };