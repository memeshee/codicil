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
  URL=$(sprite info -s "$SPRITE" 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.sprites\.app/?' | head -1 || true)
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
say "4/6 installing a systemd unit so a cold wake comes back up"
UNIT="/tmp/codicil.service"
cat > "$UNIT" <<EOF
[Unit]
Description=Codicil executor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$REMOTE_HOME/codicil
Environment=PORT=8080
Environment=DATA_DIR=$REMOTE_HOME/codicil/data
Environment=NODE_ENV=production
ExecStart=$(command -v node || echo /usr/bin/node) --experimental-sqlite --experimental-strip-types src/server.ts
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
if [ "$APPLY" = 1 ]; then
  sprite exec -s "$SPRITE" --file "$UNIT:/tmp/codicil.service" -- bash -lc \
    'sudo mv /tmp/codicil.service /etc/systemd/system/codicil.service && sudo systemctl daemon-reload && sudo systemctl enable --now codicil.service && systemctl is-active codicil.service'
else
  echo "  would install $UNIT and: systemctl enable --now codicil.service"
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
