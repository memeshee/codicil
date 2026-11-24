# Hacksgiving 2026 — entry build

Agent that lives on a Fly.io Sprite and uses Sprites Connectors.
Event: https://fly.io/hacksgiving/ · deadline 2026-11-30 07:59 UTC (11:59 PM PT Nov 29)

## Verified platform facts (commit #1, day 0)

Established from Fly's own docs on 2026-11-24, before writing product code. Notes in `discovery/hacksgiving/`.

- **No scheduler.** A Sprite pauses ~30s after activity stops; it wakes only on an inbound HTTP request or while a Task holds it (max 1h, heartbeat-renewed via `/.sprite/api.sock`). Any design that "notices" something on a clock needs a named wake source.
- **Connectors are deny-by-default.** Credentials live in the org and are injected at `https://api.sprites.dev/v1/gateway/<connector>/<path>`; the Sprite never holds the token. GitHub OAuth accepts `scopes=repo,read:org` with an `add_scopes` flow to widen later.
- **Egress is unrestricted by default**; a DNS allowlist policy is opt-in from outside and read-only inside (`/.sprite/policy/network.json`).
- **Disk persists, memory does not.** 8 vCPU, 100 GB ext4 (TRIM-billed), `auto-` checkpoints after ~1h of activity and on idle; a Service restarts at boot, a hand-started process does not survive a cold wake.
- **Inbound is one always-on HTTPS URL** per Sprite (`https://<name>-<org>.sprites.app/`), private by default, `--url-auth public` to open it.
