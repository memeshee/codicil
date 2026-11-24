#!/usr/bin/env bash
# scripts/deploy-sprite.sh — the whole Sprite path, in one command.
#
# Written while the CLI was unauthenticated so that the moment `sprite login` works, the rules
# stop being a claim: this creates the Sprite, opens its URL, pushes this tree, installs a
# systemd unit so the executor survives a cold wake, and proves the result.
#
#   ./scripts/deploy-sprite.sh              # dry run: prints every command it would run
#   ./scripts/deploy-sprite.sh --apply      # does it
#
# It refuses to pretend: if the CLI is not authenticated, it says so and exits non-zero rather
# than deploying something that looks like a Sprite and is not one.
set -euo pipefail

SPRITE="${SPRITE:-codicil}"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1
export PATH="$HOME/.local/bin:$PATH"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
run() {
  if [ "$APPLY" = 1 ]; then echo "+ $*"; "$@"; else echo "  would run: $*"; fi
}
remote() {
  if [ "$APPLY" = 1 ]; then echo "+ sprite exec -s $SPRITE -- bash -lc $(printf '%q' "$1")"; sprite exec -s "$SPRITE" -- bash -lc "$1"; else echo "  would exec: $1"; fi
}

# ---------------------------------------------------------------- preconditions
say "1/6 checking the sprite CLI is authenticated"
if ! command -v sprite >/dev/null 2>&1; then
  echo "sprite CLI not on PATH. Install it, then re-run." >&2; exit 1
fi
if ! sprite list >/dev/null 2>&1; then
  cat >&2 <<'MSG'

NOT AUTHENTICATED. This script will not fake it. Pick one:

  1. In your own terminal (no codes pasted anywhere):
       PATH=$HOME/.local/bin:$PATH sprite login --force

  2. Token route, unattended afterwards:
       create a Sprites API token at sprites.dev/account, then
       umask 077 && mkdir -p ~/.config && cat > ~/.config/sprites.token   # paste, ctrl-d
       chmod 600 ~/.config/sprites.token
       PATH=$HOME/.local/bin:$PATH sprite auth setup --token "$(cat ~/.config/sprites.token)"

Then re-run this script with --apply.
MSG
  exit 1
fi
say "   authenticated"

# ---------------------------------------------------------------- create + open
say "2/6 creating the sprite (idempotent)"
if sprite list 2>/dev/null | grep -qw "$SPRITE"; then
  echo "   $SPRITE already exists"
else
  run sprite create "$SPRITE" --skip-console
fi
run sprite config update --url-auth public -s "$SPRITE"

URL=""
if [ "$APPLY" = 1 ]; then
  URL=$(sprite info -s "$SPRITE" 2>/dev/null | grep -E '^URL:' | awk '{print $2}' | head -1 || true)
fi
echo "   public URL: ${URL:-<printed by sprite info after creation>}"

# ---------------------------------------------------------------- push the tree
say "3/6 pushing this tree into the sprite"
REMOTE_HOME="/home/sprite"
if [ "$APPLY" = 1 ]; then
  REMOTE_HOME=$(sprite exec -s "$SPRITE" -- bash -lc 'echo $HOME' 2>/dev/null | tr -d '\r' | tail -1)
  [ -n "$REMOTE_HOME" ] || REMOTE_HOME="/home/sprite"
fi
echo "   remote home: $REMOTE_HOME"
run sprite file push -r -p . "$SPRITE:$REMOTE_HOME/codicil"

# ---------------------------------------------------------------- run as a service
# PID 1 on a Sprite is tini, not systemd: a systemd unit would install cleanly and never run.
# The platform's own supervision is `sprite-env services`, which restarts on crash and starts in
# dependency order on a cold boot. Only one service may hold the HTTP port.
say "4/6 creating the service that holds the HTTP port"
NODE_BIN="/.sprite/bin/node"
if [ "$APPLY" = 1 ]; then
  NODE_BIN=$(sprite exec -s "$SPRITE" --no-stdin -- bash -lc 'command -v node' 2>/dev/null | grep -v bind | tr -d '\r' | tail -1)
fi
echo "   node: $NODE_BIN"
SERVICE_CMD="sprite-env services create codicil --cmd $NODE_BIN --args --experimental-sqlite,--experimental-strip-types,src/server.ts --env PORT=8080,DATA_DIR=$REMOTE_HOME/codicil/data,DEMO=1,NODE_ENV=production --dir $REMOTE_HOME/codicil --http-port 8080 --no-stream"
if [ "$APPLY" = 1 ]; then
  sprite exec -s "$SPRITE" --no-stdin -- bash -lc "$SERVICE_CMD && sleep 2 && sprite-env services list" 2>&1 | grep -v bind | tail -3
else
  echo "  would exec: $SERVICE_CMD"
fi

# ---------------------------------------------------------------- prove it
say "5/6 waiting for the public URL, then proving the platform facts"
if [ "$APPLY" = 1 ] && [ -n "$URL" ]; then
  for i in $(seq 1 30); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "${URL%/}/healthz" || true)
    [ "$code" = "200" ] && { echo "   healthz 200 after ${i}s"; break; }
    sleep 2
  done
  curl -s -o /dev/null -w "   GET / -> %{http_code} in %{time_total}s\n" "${URL%/}/" || true
else
  echo "  would poll <url>/healthz until 200, then GET / and time it"
fi

say "6/6 probes (these are the difference between using a connector and saying so)"
run sprite exec -s "$SPRITE" -- bash -lc "$REMOTE_HOME/codicil/scripts/probe-wake.sh inside"
if [ -n "$URL" ] && [ "$APPLY" = 1 ]; then
  run "$REMOTE_HOME/codicil/scripts/probe-wake.sh" outside "$URL"
fi
echo
echo "Next, and only then is the entry valid:"
echo "  1. attach GitHub + Slack connectors to this Sprite and consent the scopes"
echo "  2. sprite exec -s $SPRITE -- bash -lc '$REMOTE_HOME/codicil/scripts/probe-connectors.sh --write'"
echo "  3. put ${URL:-<sprite url>} in the form as the demo link, and re-render the video"
