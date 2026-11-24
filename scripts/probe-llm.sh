#!/usr/bin/env bash
# scripts/probe-llm.sh — P3. Find the exact model path the gateway exposes, and record it.
#
# The connector's own usage_snippet is the authority. We try the documented shapes, print
# which one answered, and write the winner to /.sprite/probe/llm-path.txt so the app can bind
# it instead of guessing.
set -uo pipefail

GATEWAY="${GATEWAY:-https://api.sprites.dev/v1/gateway}"
MODEL="${MODEL:-glm-5.3}"
OUT="${OUT:-}"; [ -z "$OUT" ] && OUT=$([ -w / .sprite ] 2>/dev/null && echo /.sprite/probe/llm-path.txt || echo ./demo/llm-path.txt)
mkdir -p "$(dirname "$OUT")" 2>/dev/null || true

echo "probe-llm — gateway: $GATEWAY · model: $MODEL"

LIST=$(curl -s "$GATEWAY/list")
IDS=$(printf '%s' "$LIST" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  let j; try{ j=JSON.parse(s) }catch{ console.log(""); return }
  const found=[]; JSON.stringify(j,(k,v)=>{
    if(v&&typeof v==="object"&&(v.provider||v.name)&&(v.connection_id||v.id)){
      const p=String(v.provider||v.name).toLowerCase();
      if(p.includes("ollama")||p.includes("openrouter")||p.includes("model")) found.push((v.provider||v.name)+" "+(v.connection_id||v.id))
    } return v});
  console.log([...new Set(found)].join("\n"))})')

if [ -z "$IDS" ]; then
  echo "  FAIL  no model connector granted to this Sprite (Ollama or OpenRouter)"
  echo "  Fallback ladder stays valid: LLM_PROVIDER=none uses deterministic templates."
  exit 1
fi

echo "  model connectors available:"
printf '  %s\n' $IDS

ok_any=0
while read -r provider id; do
  [ -z "${id:-}" ] && continue
  for path in "/chat/completions" "/v1/chat/completions" "/api/chat"; do
    URL="$GATEWAY/ollama/$id$path"
    RESP=$(curl -s -w '\n%{http_code}' -X POST "$URL" -H 'content-type: application/json' \
      -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with the single word: candle\"}],\"max_tokens\":24}" --max-time 45)
    CODE=$(printf '%s' "$RESP" | tail -1)
    BODY=$(printf '%s' "$RESP" | sed '$d')
    if [ "$CODE" = "200" ]; then
      echo "  PASS  $provider answered 200 at $path"
      echo "        body: $(printf '%s' "$BODY" | head -c 300)"
      printf 'provider=%s\nconnector=%s\npath=%s\nmodel=%s\n' "$provider" "$id" "$path" "$MODEL" > "$OUT"
      echo "        recorded to $OUT — bind this in src/connectors.ts via usageSnippet"
      ok_any=1; break 2
    fi
    echo "        ${provider} ${path} -> HTTP $CODE"
  done
done <<< "$IDS"

if [ "$ok_any" = "1" ]; then
  echo "probe-llm: PASS"
  exit 0
fi

echo "probe-llm: FAIL — no path answered; the connector may need managed provisioning, or the"
echo "model id differs. Read the connector's usage_snippet from GET /list and re-run with"
echo "PATH=/the/exact/path MODEL=the/exact/id."
exit 1
