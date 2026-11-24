#!/usr/bin/env bash
# scripts/demo-driver.sh — drive the whole ladder in front of an audience, or in CI.
#
# Signs a will with sub-minute graces (DEMO mode only), then walks the phases by waking the
# executor the way the pinger does, printing state at each beat and leaving a transcript.
#
#   BASE=http://localhost:8099 DATA_DIR=/tmp/codtest2 ./scripts/demo-driver.sh
#   BASE=https://<sprite>.sprites.app PING_TOKEN=... ./scripts/demo-driver.sh --real
#
# Flags:
#   --real        use production graces from the existing will; only tick and report
#   --no-sign     skip signing (drive whatever will is already sealed)
set -euo pipefail

BASE="${BASE:-http://localhost:8099}"
DATA_DIR="${DATA_DIR:-.}"
TRANSCRIPT="${TRANSCRIPT:-demo/transcript.txt}"
GRACE="${GRACE:-0.25}"   # minutes; 0.25 = 15 seconds, enough room to narrate a beat
STEP_WAIT="${STEP_WAIT:-17}"

REAL=0
NO_SIGN=0
for arg in "$@"; do
  case "$arg" in
    --real) REAL=1 ;;
    --no-sign) NO_SIGN=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

mkdir -p "$(dirname "$TRANSCRIPT")"
: > "$TRANSCRIPT"

say() { local line="[$(date -u +%H:%M:%SZ)] $*"; echo "$line"; echo "$line" >> "$TRANSCRIPT"; }

phase() {
  curl -fsS "$BASE/api/state" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(`${j.phase} streak=${j.streakDays} will=v${j.willVersion}`)})'
}

tick() {
  if [ -n "${PING_TOKEN:-}" ]; then
    curl -fsS -X POST "$BASE/tick" -H "X-Ping-Token: $PING_TOKEN" >/dev/null
  else
    curl -fsS -X POST "$BASE/tick" >/dev/null
  fi
}

ledger_tail() {
  curl -fsS "$BASE/ledger" | grep -oE '<span class="what">[^<]+' | sed 's/<span class="what">//' | tail -"${1:-6}"
}

say "codicil demo driver — base=$BASE"
if [ "$REAL" = 0 ] && [ "$NO_SIGN" = 0 ]; then
  TOKEN=$(cat "$DATA_DIR/owner-token")

  # State pre-check: never start a beat sequence from an unknown phase. A readable sentence,
  # not an opaque failure halfway through a recording.
  CURRENT=$(phase)
  case "$CURRENT" in
    ARMED*|DORMANT*)
      say "pre-check ok: $CURRENT" ;;
    EXECUTED*)
      say "REFUSING TO START: this will has already been executed ($CURRENT)."
      say "Sign a new version first (POST /api/will), or run with --real to only tick and report."
      exit 3 ;;
    CONCERNED*|PLEADING*|EXECUTING*)
      say "REFUSING TO START: the clock is already running ($CURRENT)."
      say "Check in as the owner first: BASE=$BASE DATA_DIR=$DATA_DIR ./scripts/streak-checkin.sh"
      exit 3 ;;
    *)
      say "REFUSING TO START: unexpected phase ($CURRENT)"
      exit 3 ;;
  esac

  say "signing a will with ${GRACE}m graces"
  curl -fsS -X POST "$BASE/api/will" \
    -H 'content-type: application/x-www-form-urlencoded' \
    --data-urlencode "token=$TOKEN" \
    --data-urlencode "letter=I owe you an apology and a garden. Water the fig; the shed key is with Ada." \
    --data-urlencode "name=kiter" \
    --data-urlencode "github=PhiBao" \
    --data-urlencode "repo=memeshee/codicil" \
    --data-urlencode "slack=C0DEMO" \
    --data-urlencode "witnesses=Ada, Grace" \
    --data-urlencode "deadline=$GRACE" \
    --data-urlencode "nudge=$GRACE" \
    --data-urlencode "plead=$GRACE" >/dev/null
  say "will sealed"
fi

say "phase now: $(phase)"

for beat in 1 2 3 4; do
  say "sleeping ${STEP_WAIT}s (the sprite is 'asleep' — nothing is ticking)"
  sleep "$STEP_WAIT"
  tick
  say "tick -> $(phase)"
done

say "notice board, last entries:"
ledger_tail 8 | while IFS= read -r row; do say "  · $row"; done
say "transcript written to $TRANSCRIPT"
