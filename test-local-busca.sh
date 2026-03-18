#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-5232}"
BASE_URL="${BASE_URL:-http://localhost:${PORT}}"
QUERY="${1:-dipirona}"
UNIDADE_NEGOCIO_ID="${UNIDADE_NEGOCIO_ID:-70826}"

curl --silent --show-error --location \
  --request POST "${BASE_URL}/api/buscar-medicamentos" \
  --header 'Content-Type: application/json' \
  --data "{\"query\":\"${QUERY}\",\"unidade_negocio_id\":${UNIDADE_NEGOCIO_ID}}"

echo
