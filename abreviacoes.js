// abreviacoes.js — BUSCA GENÉRICA E ESCALÁVEL (READ-ONLY SAFE)

// 🔹 Sinônimos / abreviações curtas (EXPANSÃO CONTROLADA)
const sinonimos = {
    // Formas / embalagens
    cp: ['comprimido'],
    cpr: ['comprimido'],
    cps: ['capsula'],
    cap: ['capsula'],
    fr: ['frasco'],
    amp: ['ampola'],
    inj: ['injetavel'],
  
    // Tipos comuns
    gen: ['generico'],
    ref: ['referencia'],
    sim: ['similar'],
  
    // Higiene / consumo (exemplos, não regra)
    sh: ['shampoo'],
    xampu: ['shampoo'],
    sabon: ['sabonete'],
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
  // GERAÇÃO DE SQL (ORDEM LIVRE, MATCH FORTE)
  // ============================================================
  function gerarCondicoesBusca(tokens) {
    const condicoes = [];
    const parametros = [];
    let idx = 1;
  
    tokens.forEach(token => {
      condicoes.push(`p.descricao ILIKE $${idx++}`);
      parametros.push(`%${token}%`);
    });
  
    return {
      condicoes: condicoes.join(' AND '),
      parametros
    };
  }
  
  module.exports = {
    normalizarTermoBusca,
    expandirAbreviacoes,
    gerarCondicoesBusca
  };
  