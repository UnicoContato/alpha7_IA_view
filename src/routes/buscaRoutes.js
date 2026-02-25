const express = require('express');
const { buscarPorDescricao, buscarPorPrincipioAtivo, verificarDisponibilidade } = require('../db/queries');
const { enriquecerClassificacaoCanonica } = require('../db/classificacaoQueries');
const { ordenarPorIA } = require('../services/aiService');
const { extrairFormaFarmaceutica } = require('../utils/searchUtils');

const router = express.Router();

const UNIDADE_NEGOCIO_ID_PADRAO = parseInt(process.env.UNIDADE_NEGOCIO_ID || '65984');

router.post('/api/buscar-medicamentos', async (req, res) => {
  try {
    const { query, unidade_negocio_id } = req.body;

    if (!query || query.trim() === '') {
      return res.status(400).json({ erro: 'Query vazia' });
    }

    const unidadeNegocioId = unidade_negocio_id || UNIDADE_NEGOCIO_ID_PADRAO;
    const termoBusca = query.trim().toLowerCase();

    console.log(`\n========================================`);
    console.log(`[BUSCA] Termo: "${termoBusca}"`);
    console.log(`[BUSCA] Unidade Negócio ID: ${unidadeNegocioId}`);
    console.log(`========================================`);

    const { principioAtivoBusca, formaFarmaceutica, variacoesForma } = extrairFormaFarmaceutica(termoBusca);

    console.log(`[INFO] Princípio ativo extraído: "${principioAtivoBusca}"`);
    console.log(`[INFO] Forma farmacêutica: "${formaFarmaceutica || 'nenhuma'}"`);

    let produtosPrincipioAtivo = [];
    let produtosDescricao = [];
    let principiosEncontrados = [];
    let metodosUtilizados = [];

    const [resultadoPrincipioAtivo, resultadoDescricao] = await Promise.all([
      buscarPorPrincipioAtivo(principioAtivoBusca, formaFarmaceutica, variacoesForma),
      buscarPorDescricao(termoBusca)
    ]);

    if (resultadoPrincipioAtivo.encontrado) {
      produtosPrincipioAtivo = resultadoPrincipioAtivo.produtos;
      principiosEncontrados = resultadoPrincipioAtivo.principiosEncontrados || [];
      metodosUtilizados.push(resultadoPrincipioAtivo.metodo);
    }

    if (resultadoDescricao.produtos && resultadoDescricao.produtos.length > 0) {
      produtosDescricao = resultadoDescricao.produtos;
      metodosUtilizados.push(resultadoDescricao.metodo);
    }

    const produtosMap = new Map();

    produtosPrincipioAtivo.forEach(p => {
      produtosMap.set(p.id, { ...p, origem: 'principio_ativo' });
    });

    produtosDescricao.forEach(p => {
      if (!produtosMap.has(p.id)) {
        produtosMap.set(p.id, { ...p, origem: 'descricao' });
      } else {
        const produto = produtosMap.get(p.id);
        produto.origem = 'ambos';
        produto.relevancia_descricao = p.relevancia_descricao;
        produtosMap.set(p.id, produto);
      }
    });

    let produtos = Array.from(produtosMap.values());

    produtos.sort((a, b) => {
      const scoreA = a.relevancia_descricao || 0;
      const scoreB = b.relevancia_descricao || 0;
      return scoreB - scoreA;
    });

    console.log(`[INFO] Total de produtos únicos combinados: ${produtos.length}`);

    if (produtos.length > 0) {
      produtos = await verificarDisponibilidade(produtos, unidadeNegocioId);
      console.log(`[INFO] Após verificação de estoque: ${produtos.length} produtos`);
    }

    if (produtos.length > 0) {
      produtos = await enriquecerClassificacaoCanonica(produtos);
    }

    let ordenadoPorIA = false;
    if (produtos.length > 0) {
      const resultadoIA = await ordenarPorIA(produtos, termoBusca);
      produtos = resultadoIA.produtos;
      ordenadoPorIA = resultadoIA.ordenado;
    }

    const metodoBusca = metodosUtilizados.length > 0
      ? metodosUtilizados.join(' + ')
      : 'nenhum método encontrou resultados';
    const classificacoesDisponiveis = [...new Set(produtos.map(p => p.tipo_classificacao_canonica).filter(Boolean))];

    console.log(`\n========================================`);
    console.log(`[RESULTADO] ${produtos.length} produto(s) encontrado(s)`);
    console.log(`[RESULTADO] Métodos: ${metodoBusca}`);
    console.log(`[RESULTADO] Ordenado por IA: ${ordenadoPorIA ? 'Sim' : 'Não'}`);
    console.log(`========================================\n`);

    return res.status(200).json({
      busca: {
        termo_original: termoBusca,
        principio_ativo_extraido: principioAtivoBusca !== termoBusca ? principioAtivoBusca : null,
        forma_farmaceutica: formaFarmaceutica
      },
      metadados: {
        metodo_busca: metodoBusca,
        ordenado_por_ia: ordenadoPorIA,
        total_produtos: produtos.length,
        unidade_negocio_id: unidadeNegocioId,
        classificacoes_disponiveis: classificacoesDisponiveis
      },
      produtos: produtos.map(p => ({
        id: p.id,
        codigo: p.codigo,
        codigo_barras: p.codigobarras,
        descricao: p.descricao,
        principio_ativo: p.principioativo_nome || null,
        tipo_classificacao: p.tipo_classificacao_canonica || null,
        classificacao_id_origem: p.classificacao_id_origem || null,
        embalagem_id: p.embalagem_id,
        estoque_disponivel: p.estoque_disponivel || 0,
        relevancia_score: p.relevancia_score || p.relevancia_descricao || null,
        origem_busca: p.origem,
        precos: {
          preco_venda: p.precos?.preco_final_venda || null,
          tem_oferta_ativa: p.precos?.tem_oferta_ativa || false,
          preco_sem_desconto: p.precos?.preco_sem_desconto || null,
          preco_com_desconto: p.precos?.preco_com_desconto || null,
          desconto_percentual: p.precos?.desconto_oferta_percentual || null,
          nome_caderno_oferta: p.precos?.nome_caderno_oferta || null,
          tipo_oferta: p.precos?.tipo_oferta || null,
          leve: p.precos?.leve || null,
          pague: p.precos?.pague || null,
          oferta_inicio: p.precos?.oferta_inicio || null,
          oferta_fim: p.precos?.oferta_fim || null,
          preco_referencial_geral: p.precos?.preco_referencial_geral || null,
          preco_venda_geral: p.precos?.preco_venda_geral || null,
          preco_referencial_loja: p.precos?.preco_referencial_loja || null,
          preco_venda_loja: p.precos?.preco_venda_loja || null,
          markup_geral: p.precos?.markup_geral || null,
          markup_loja: p.precos?.markup_loja || null,
          plugpharma_preco_controlado: p.precos?.plugpharma_preco_controlado || null
        }
      }))
    });
  } catch (error) {
    console.error('❌ Erro ao buscar medicamento:', error);
    return res.status(500).json({
      erro: 'Erro ao processar busca',
      detalhes: error.message
    });
  }
});

router.get('/', (req, res) => {
  res.json({ mensagem: 'API de busca de medicamentos está rodando!' });
});

module.exports = { router };
