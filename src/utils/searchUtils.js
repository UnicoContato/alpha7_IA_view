const { formasFarmaceuticas } = require('../../similarity');

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

        // Remove preposições e artigos que sobram
        principioAtivoBusca = principioAtivoBusca
          .replace(/\b(em|de|da|do|das|dos|na|no|nas|nos|com|para|por)\b/gi, '')
          .replace(/\s+/g, ' ')
          .trim();

        break;
      }
    }
    if (formaFarmaceutica) break;
  }

  return { principioAtivoBusca, formaFarmaceutica, variacoesForma };
}

module.exports = { extrairFormaFarmaceutica };
