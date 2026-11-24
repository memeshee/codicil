#!/usr/bin/env bash
# scripts/streak-checkin.sh — the entrant's own daily check-in, for real days on the ledger.
#
#   BASE=https://<sprite>.sprites.app DATA_DIR=~/.sprite-secrets ./scripts/streak-checkin.sh
#
# Exits non-zero if the check-in is rejected, so a cron job or the demo can notice.
set -euo pipefail

BASE="${BASE:-http://localhost:8099}"
DATA_DIR="${DATA_DIR:-.}"
TOKEN_FILE="${TOKEN_FILE:-$DATA_DIR/owner-token}"

if [ ! -f "$TOKEN_FILE" ]; then
  echo "no owner token at $TOKEN_FILE" >&2
  exit 2
fi

TOKEN=$(cat "$TOKEN_FILE")
RESP=$(curl -fsS -X POST "$BASE/api/checkin" \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$TOKEN\"}")

echo "$RESP"
echo "$RESP" | grep -q '"ok": true' || { echo "check-in rejected" >&2; exit 1; }
