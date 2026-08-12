#!/usr/bin/env bash
# Liste les wallets suivis par le bot
# Usage: ./list-wallets.sh   ou   npm run wallets

set -euo pipefail

PORT="${PORT:-3000}"
BASE_URL="${BASE_URL:-http://127.0.0.1:${PORT}}"

if ! curl -sf "${BASE_URL}/health" >/dev/null 2>&1; then
  echo "❌ Bot injoignable sur ${BASE_URL}"
  echo "   Lance d'abord: npm start"
  exit 1
fi

curl -sS "${BASE_URL}/wallets" | python3 -m json.tool 2>/dev/null \
  || curl -sS "${BASE_URL}/wallets"
echo ""
