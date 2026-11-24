#!/usr/bin/env bash
# scripts/probe-connectors.sh — P2. Prove the gateway, then prove a write.
#
# Read-only by default: lists what this Sprite can reach, with granted scopes. With --write it
# performs one real GitHub issue and one real Slack message, then reads the issue back by
# number — because a call that returns 201 and cannot be read back is not proof.
#
#   sprite exec -s <name> -- bash scripts/probe-connectors.sh
#   GH_REPO=memeshee/codicil SLACK_CHANNEL=C0… sprite exec -s <name> -- bash scripts/probe-connectors.sh --write
set -uo pipefail

GATEWAY="${GATEWAY:-https://api.sprites.dev/v1/gateway}"
WRITE=0
[ "${1:-}" = "--write" ] && WRITE=1
GH_REPO="${GH_REPO:-}"
SLACK_CHANNEL="${SLACK_CHANNEL:-}"

pass=0; fail=0
ok()  { echo "  PASS  $*"; pass=$((pass+1)); }
bad() { echo "  FAIL  $*"; fail=$((fail+1)); }

json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j;try{j=JSON.parse(s)}catch{console.log(JSON.stringify({_raw:s.slice(0,400)}));return}
const out=[];JSON.stringify(j,(k,v)=>{if(v&&typeof v==="object"&&(v.provider||v.name)&&(v.connection_id||v.id)){out.push({provider:v.provider||v.name,id:v.connection_id||v.id,scopes:v.scopes||v.granted_scopes||[]})}return v});
const seen=new Set();const uniq=out.filter(c=>{const k=c.provider+":"+c.id;if(seen.has(k))return false;seen.add(k);return true});
if(uniq.length)console.log(JSON.stringify(uniq,null,1));else console.log(JSON.stringify(j,null,1).slice(0,800))})'
}

echo "probe-connectors — gateway: $GATEWAY"
echo
echo "[1] catalogue: GET /list (no Authorization header, ever)"
LIST=$(curl -s -w '\n%{http_code}' "$GATEWAY/list")
CODE=$(printf '%s' "$LIST" | tail -1)
BODY=$(printf '%s' "$LIST" | sed '$d')
if [ "$CODE" = "200" ]; then
  ok "gateway answered 200"
  echo "$BODY" | json | head -40
  GH_ID=$(echo "$BODY" | json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);const g=(Array.isArray(a)?a:[]).find(c=>String(c.provider).includes("github"));console.log(g?g.id:"")}catch{console.log("")}})')
  SL_ID=$(echo "$BODY" | json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);const g=(Array.isArray(a)?a:[]).find(c=>String(c.provider).includes("slack"));console.log(g?g.id:"")}catch{console.log("")}})')
else
  bad "gateway answered HTTP $CODE — outside a Sprite this is expected; inside it is not"
  GH_ID=""; SL_ID=""
fi

echo
echo "[2] github"
if [ -z "$GH_ID" ]; then
  bad "no github connector granted to this Sprite (dashboard → Connectors → Access Configuration)"
else
  ok "github connector id: $GH_ID"
  ME=$(curl -s -o /dev/null -w '%{http_code}' "$GATEWAY/github/$GH_ID/user")
  case "$ME" in 200) ok "GET /user via the gateway returns 200 (scopes accepted)" ;; *) bad "GET /user returned $ME — check granted scopes / add_scopes" ;; esac

  if [ "$WRITE" = "1" ] && [ -n "$GH_REPO" ]; then
    ISSUE=$(curl -s -X POST "$GATEWAY/github/$GH_ID/repos/$GH_REPO/issues" \
      -H 'content-type: application/json' \
      -d '{"title":"Codicil probe: the executor held no key","body":"Written by the Sprites connector gateway during build-hour-1 probing. No token was ever present in the Sprite."}')
    NUM=$(printf '%s' "$ISSUE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.number||"")}catch{console.log("")}})')
    if [ -n "$NUM" ]; then
      BACK=$(curl -s -o /dev/null -w '%{http_code}' "$GATEWAY/github/$GH_ID/repos/$GH_REPO/issues/$NUM")
      case "$BACK" in 200) ok "created issue #$NUM and read it back by number (write scope proven)" ;; *) bad "issue #$NUM created but read-back returned $BACK" ;; esac
      echo "        receipt: https://github.com/$GH_REPO/issues/$NUM"
    else
      bad "issue creation failed: $(printf '%s' "$ISSUE" | head -c 300)"
    fi
  else
    echo "        (read-only; pass --write with GH_REPO= to prove the write path)"
  fi
fi

echo
echo "[3] slack"
if [ -z "$SL_ID" ]; then
  bad "no slack connector granted to this Sprite"
else
  ok "slack connector id: $SL_ID"
  if [ "$WRITE" = "1" ] && [ -n "$SLACK_CHANNEL" ]; then
    POST=$(curl -s -X POST "$GATEWAY/slack/$SL_ID/chat.postMessage" \
      -H 'content-type: application/json' \
      -d "{\"channel\":\"$SLACK_CHANNEL\",\"text\":\"Codicil probe: this message was sent by an agent that holds no Slack token.\"}")
    case "$POST" in
      *'"ok":true'*|*'"ok": true'*) ok "chat.postMessage accepted (message visible in $SLACK_CHANNEL)" ;;
      *) bad "chat.postMessage failed: $(printf '%s' "$POST" | head -c 300)" ;;
    esac
  else
    echo "        (read-only; pass --write with SLACK_CHANNEL= to prove the write path)"
  fi
fi

echo
echo "probe-connectors: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
