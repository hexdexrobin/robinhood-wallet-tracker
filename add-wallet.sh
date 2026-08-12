#!/usr/bin/env bash
# Ajoute un ou plusieurs wallets au tracker (POST /add-wallet)
# Usage:
#   ./add-wallet.sh 0xABC...
#   ./add-wallet.sh 0xAAA... 0xBBB... 0xCCC...
#   npm run add -- 0xABC...

set -euo pipefail

PORT="${PORT:-3000}"
BASE_URL="${BASE_URL:-http://127.0.0.1:${PORT}}"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <wallet> [wallet2 ...]"
  echo "Exemple: $0 0x74E028F8DAA0993f078949CCE119A336eE936CE8"
  exit 1
fi

# Vérifie que le bot tourne
if ! curl -sf "${BASE_URL}/health" >/dev/null 2>&1; then
  echo "❌ Bot injoignable sur ${BASE_URL}"
  echo "   Lance d'abord: npm start"
  exit 1
fi

ok=0
fail=0
for addr in "$@"; do
  echo "→ Ajout de ${addr} ..."
  resp="$(curl -sS -X POST "${BASE_URL}/add-wallet" \
    -H "Content-Type: application/json" \
    -d "{\"address\":\"${addr}\"}" || true)"

  if echo "${resp}" | grep -q '"ok":true'; then
    echo "  ✅ ${resp}"
    ok=$((ok + 1))
  else
    echo "  ❌ ${resp:-erreur réseau}"
    fail=$((fail + 1))
  fi
done

echo ""
echo "Résumé: ${ok} ok, ${fail} échec(s)"
echo "Wallets suivis:"
curl -sS "${BASE_URL}/wallets"
echo ""
