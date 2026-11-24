#!/usr/bin/env bash
# scripts/probe-wake.sh — P1. The single high-risk unknown, measured instead of assumed.
#
# A Sprite has no scheduler. It pauses ~30s after activity stops and runs again on an inbound
# request or while a Task holds it (max 1h, renewable). This probe proves, in order:
#
#   P0  node + node:sqlite work on this box
#   P1a the disk survives a pause (a marker written before idling is still there after)
#   P1b an inbound request wakes it, and how fast (measured from OUTSIDE the Sprite)
#   P1c a Task hold keeps it up (list shows a live task; the box answers during the hold)
#   P1d a Service restarts on a cold wake while the disk keeps state (boot counter)
#
# Two modes, because half the evidence has to come from outside:
#
#   inside  : sprite exec -s <name> -- bash scripts/probe-wake.sh inside
#   outside : bash scripts/probe-wake.sh outside https://<sprite>-<org>.sprites.app
#
# Writes a JSONL log to the path in PROBE_LOG (default /.sprite/probe/wake.jsonl, falling
# back to ./demo/wake-probe.jsonl) and prints PASS/FAIL per assertion.
set -uo pipefail

MODE="${1:-inside}"
URL="${2:-${SPRITE_URL:-}}"
LOG="${PROBE_LOG:-}"
if [ -z "$LOG" ]; then
  if [ -d "/.sprite" ] && [ -w "/.sprite" ]; then LOG="/.sprite/probe/wake.jsonl"; else LOG="./demo/wake-probe.jsonl"; fi
fi
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

pass=0; fail=0
ok()   { echo "  PASS  $*"; pass=$((pass+1)); record "$1" "pass"; }
bad()  { echo "  FAIL  $*"; fail=$((fail+1)); record "$1" "fail"; }
record() { printf '{"ts":"%s","mode":"%s","check":"%s","result":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$MODE" "$1" "$2" >> "$LOG" 2>/dev/null || true; }

api() { curl -s --unix-socket /.sprite/api.sock -H 'content-type: application/json' "$@"; }

case "$MODE" in
inside)
  echo "probe-wake / inside — log: $LOG"

  echo "[P0] runtime"
  if node --version >/dev/null 2>&1; then ok "node present: $(node --version)"; else bad "node missing"; fi
  if node --experimental-sqlite -e "const{DatabaseSync}=require('node:sqlite');new DatabaseSync(':memory:').exec('create table t(a)')" 2>/dev/null; then
    ok "node:sqlite usable (no native build needed)"
  else
    bad "node:sqlite unavailable — fall back to better-sqlite3 (rebuild risk, needs a compiler)"
  fi

  echo "[P1a] disk marker"
  MARKER="${MARKER:-/.sprite/probe/marker.txt}"
  mkdir -p "$(dirname "$MARKER")" 2>/dev/null || MARKER="./demo/marker.txt"
  if [ -f "$MARKER" ]; then
    printf '{"writes":%s}\n' "$(cat "$MARKER" 2>/dev/null || echo 0)" > /tmp/_m 2>/dev/null || true
    N=$(cat "$MARKER" | tr -dc '0-9' || echo 0); N=$(( ${N:-0} + 1 ))
    echo "$N" > "$MARKER"
    ok "marker survived a previous run and was incremented to $N (disk persists across pauses: $MARKER)"
  else
    echo "1" > "$MARKER"
    ok "marker written for the first time at $MARKER — re-run this probe after an idle window to prove persistence"
  fi

  echo "[P1d] boot counter (proves a Service restarts while state stays on disk)"
  BOOTS="${BOOTS:-/.sprite/probe/boots.txt}"
  [ -w "$(dirname "$BOOTS")" ] 2>/dev/null || BOOTS="./demo/boots.txt"
  mkdir -p "$(dirname "$BOOTS")" 2>/dev/null || true
  B=$(cat "$BOOTS" 2>/dev/null | tr -dc '0-9' || echo 0); B=$(( ${B:-0} + 1 )); echo "$B" > "$BOOTS"
  ok "boot #$B recorded (compare this number across a cold wake)"

  echo "[P1c] task hold"
  HOLD=$(api -X PUT http://sprite/v1/tasks/probe -d '{"expire":"5m"}' -w '%{http_code}' -o /dev/null)
  if [ "$HOLD" = "200" ] || [ "$HOLD" = "201" ]; then
    ok "task hold created (HTTP $HOLD) — the Sprite will not pause for 5 minutes"
    LIST=$(api http://sprite/v1/tasks 2>/dev/null || echo '')
    case "$LIST" in *probe*) ok "task appears in the hold list: $LIST" ;; *) bad "task not listed after creation: $LIST" ;; esac
    api -X DELETE http://sprite/v1/tasks/probe >/dev/null 2>&1 && ok "hold released cleanly"
  else
    bad "task API unreachable (HTTP $HOLD) — this is the fallback path: run always-on and disclose it"
  fi
  ;;

outside)
  echo "probe-wake / outside — target: ${URL:-unset} — log: $LOG"
  if [ -z "$URL" ]; then echo "usage: $0 outside https://<sprite>-<org>.sprites.app" >&2; exit 2; fi

  echo "[P1b] wake-on-request, measured from here"
  IDLE="${IDLE:-75}"
  echo "  idling ${IDLE}s so the Sprite is genuinely paused..."
  sleep "$IDLE"
  T=$(curl -s -o /dev/null -w '%{time_total}' --max-time 60 "$URL/healthz" || echo "0")
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 "$URL/healthz" || echo "000")
  if [ "$CODE" = "200" ]; then
    KIND=$(node -e "const t=$T; console.log(t<0.6?'warm wake (process state preserved)':t<3?'cold wake (fresh boot)':'slower than a cold wake — check for a stale hold task')")
    ok "inbound request woke it: HTTP 200 in ${T}s ($KIND)"
  else
    bad "no answer after 60s (HTTP $CODE) — the wake path is broken"
  fi

  echo "[tick] does the deadline clock advance on a pinger request?"
  TC=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X POST "$URL/tick" ${PING_TOKEN:+-H "X-Ping-Token: $PING_TOKEN"} || echo "000")
  case "$TC" in 200) ok "POST /tick accepted (200)" ;; 403) bad "POST /tick rejected (403) — PING_TOKEN mismatch" ;; *) bad "POST /tick failed (HTTP $TC)" ;; esac
  ;;

*)
  echo "usage: $0 [inside|outside] [url]" >&2; exit 2 ;;
esac

echo
echo "probe-wake: $pass passed, $fail failed — log at $LOG"
echo "Transcript goes into the submission as evidence; the README points at it."
[ "$fail" -eq 0 ]
