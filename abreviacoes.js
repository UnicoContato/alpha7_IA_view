// abreviacoes.js - Mapeamento de termos e suas abreviações

const abreviacoesProdutos = {
    // Higiene e Cuidados Pessoais
    'pasta de dente': ['cr dental', 'cr. dental', 'pasta dent', 'pasta de dente'],
    'creme dental': ['cr dental', 'cr. dental', 'creme dent', 'pasta dental', 'pasta dent'],
    'shampoo': ['xampu', 'shampo', 'shamp'],
    'condicionador': ['cond', 'condic'],
    'desodorante': ['desod', 'deso', 'desodor'],
    'sabonete': ['sab', 'sabao'],
    'protetor solar': ['prot solar', 'protetor sol', 'filtro solar'],
    'hidratante': ['hidr', 'hidrat'],
    'agua oxigenada': ['agua oxig', 'h2o2'],
    'alcool': ['alcool gel', 'alcool 70'],
    
    // Medicamentos e Formas
    'comprimido': ['comp', 'cp', 'compr'],
    'capsula': ['caps', 'cap'],
    'solucao oral': ['sol oral', 'sol. oral', 'solucao or'],
    'suspensao oral': ['susp oral', 'susp. oral', 'suspensao or'],
    'xarope': ['xpe', 'xar'],
    'gotas': ['gts', 'gt'],
    'pomada': ['pom'],
    'creme': ['cr'],
    'gel': ['gl'],
    'spray': ['spr'],
    'injetavel': ['inj', 'amp', 'ampola'],
    'supositorio': ['supos', 'sup'],
    'adesivo': ['ades'],
    
    // Concentrações e Medidas
    'miligramas': ['mg', 'mgs'],
    'gramas': ['g', 'gr'],
    'mililitros': ['ml', 'mls'],
    'litros': ['l', 'lt'],
    'unidades': ['un', 'und', 'u'],
    'internacional': ['ui', 'int'],
    'por cento': ['%', 'porcento'],
    
    // Termos Médicos Comuns
    'antibiotico': ['antibiot', 'atb'],
    'anti inflamatorio': ['anti inflam', 'antiinflam', 'anti-inflam'],
    'analgesico': ['analg'],
    'antipiretico': ['antip', 'antipir'],
    'vitamina': ['vit', 'vitam'],
    'suplemento': ['supl', 'suplem'],
    'complexo': ['compl', 'complex'],
    
    // Tipos de Produtos
    'generico': ['gen', 'gerico'],
    'similar': ['sim'],
    'referencia': ['ref', 'refer'],
    
    // Partes do Corpo / Uso
    'nasal': ['nas'],
    'ocular': ['ocul', 'oft', 'oftalmico'],
    'otologico': ['oto', 'otol', 'ouvido'],
    'dermatologico': ['derm', 'dermat', 'pele'],
    'bucal': ['buc'],
    'retal': ['ret'],
    'vaginal': ['vag', 'vagin'],
    
    // Termos Gerais
    'envelope': ['env'],
    'frasco': ['fr', 'fco'],
    'blister': ['blist', 'bl'],
    'cartela': ['cart'],
    'bisnaga': ['bisn'],
    'tubo': ['tb'],
    'caixa': ['cx'],
    'embalagem': ['emb', 'embal'],
    'lata': ['lt', 'lta'],
  };
  
  // Função para normalizar termo de busca
  function normalizarTermoBusca(termo) {
    let termoNormalizado = termo.toLowerCase().trim();
    
    // Remover acentos
    termoNormalizado = termoNormalizado
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    
    // Remover pontuação extra (mas manter pontos em abreviações)
    termoNormalizado = termoNormalizado
      .replace(/[,;:!?]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    return termoNormalizado;
  }
  
  // Função para expandir abreviações no termo de busca
  function expandirAbreviacoes(termo) {
    let termoExpandido = normalizarTermoBusca(termo);
    const variacoesEncontradas = [termoExpandido];
    
    // Para cada abreviação mapeada
    for (const [termoCompleto, abreviacoes] of Object.entries(abreviacoesProdutos)) {
      // Verificar se o termo contém alguma abreviação
      for (const abrev of abreviacoes) {
        const regex = new RegExp(`\\b${abrev.replace('.', '\\.')}\\b`, 'i');
        
        if (regex.test(termoExpandido)) {
          // Adicionar variação com termo completo
          const comTermoCompleto = termoExpandido.replace(regex, termoCompleto);
          if (!variacoesEncontradas.includes(comTermoCompleto)) {
            variacoesEncontradas.push(comTermoCompleto);
          }
        }
      }
      
      // Verificar se o termo contém o termo completo
      const regexCompleto = new RegExp(`\\b${termoCompleto}\\b`, 'i');
      if (regexCompleto.test(termoExpandido)) {
        // Adicionar variações com abreviações
        for (const abrev of abreviacoes) {
          const comAbreviacao = termoExpandido.replace(regexCompleto, abrev);
          if (!variacoesEncontradas.includes(comAbreviacao)) {
            variacoesEncontradas.push(comAbreviacao);
          }
        }
      }
    }
    
    return variacoesEncontradas;
  }
  
  // Função para gerar condições SQL para múltiplas variações
  function gerarCondicoesBusca(variacoes) {
    const condicoes = variacoes.map((_, idx) => `p.descricao ILIKE $${idx + 1}`).join(' OR ');
    const parametros = variacoes.map(v => `%${v}%`);
    
    return { condicoes, parametros };
  }
  
  module.exports = {
    abreviacoesProdutos,
    normalizarTermoBusca,
    expandirAbreviacoes,
    gerarCondicoesBusca
  };