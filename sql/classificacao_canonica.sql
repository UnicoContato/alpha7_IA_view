-- 1) Tabela de mapeamento canônico por cliente
CREATE TABLE IF NOT EXISTS classificacao_canonica_map (
  id BIGSERIAL PRIMARY KEY,
  cliente_id TEXT NOT NULL,
  classificacaoid_origem BIGINT NOT NULL,
  nome_origem TEXT,
  tipo_canonico TEXT NOT NULL CHECK (tipo_canonico IN ('REFERENCIA', 'GENERICO', 'SIMILAR')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (cliente_id, classificacaoid_origem)
);

CREATE INDEX IF NOT EXISTS idx_classificacao_canonica_map_cliente_tipo
  ON classificacao_canonica_map (cliente_id, tipo_canonico);

-- 2) Descoberta inicial (ajuste "classificacao" e "nome" se no seu schema o nome da tabela/campo for diferente)
-- Troque :cliente_id por um valor fixo, ex: 'superpopular_esc_2024_02_26'
INSERT INTO classificacao_canonica_map (cliente_id, classificacaoid_origem, nome_origem, tipo_canonico)
SELECT
  :cliente_id,
  c.id,
  c.nome,
  CASE
    WHEN c.nome ILIKE '%gener%' THEN 'GENERICO'
    WHEN c.nome ILIKE '%simil%' THEN 'SIMILAR'
    WHEN c.nome ILIKE '%refer%' OR c.nome ILIKE '%marca%' THEN 'REFERENCIA'
    ELSE NULL
  END AS tipo_canonico
FROM classificacao c
WHERE (
  c.nome ILIKE '%gener%'
  OR c.nome ILIKE '%simil%'
  OR c.nome ILIKE '%refer%'
  OR c.nome ILIKE '%marca%'
)
AND NOT EXISTS (
  SELECT 1
  FROM classificacao_canonica_map m
  WHERE m.cliente_id = :cliente_id
    AND m.classificacaoid_origem = c.id
)
AND CASE
  WHEN c.nome ILIKE '%gener%' THEN 'GENERICO'
  WHEN c.nome ILIKE '%simil%' THEN 'SIMILAR'
  WHEN c.nome ILIKE '%refer%' OR c.nome ILIKE '%marca%' THEN 'REFERENCIA'
  ELSE NULL
END IS NOT NULL;

-- 3) Correção manual (exemplo)
-- UPDATE classificacao_canonica_map
-- SET tipo_canonico = 'REFERENCIA', updated_at = NOW()
-- WHERE cliente_id = 'superpopular_esc_2024_02_26'
--   AND classificacaoid_origem = 71194;

-- 4) Conferência do resultado
-- SELECT cliente_id, classificacaoid_origem, nome_origem, tipo_canonico
-- FROM classificacao_canonica_map
-- WHERE cliente_id = 'superpopular_esc_2024_02_26'
-- ORDER BY tipo_canonico, classificacaoid_origem;
