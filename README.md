# Codicil

An agent that lives on a Fly.io Sprite and, if its owner goes silent past their own
deadline, carries out the owner's written instructions through the owner's real
accounts — **without ever holding a key**.

> clawds.ai resurrects *your agent* when it dies. Codicil executes *your will* through
> *your accounts* when *you* go silent, and never holds a credential.

Built for [Fly.io Hacksgiving 2026](https://fly.io/hacksgiving/). A Sprite and at least
one Sprites Connector are load-bearing here, not decoration: the credential never enters
the box, so an executor that can post, message and release files cannot leak a token even
if it is compromised.

<!-- LIVE LINK, VIDEO AND "TRY IT IN 60 SECONDS" LAND HERE AT SUBMISSION -->

## What it does

Codicil holds one document: your will. Not a legal instrument — the plain-language thing
you would want said, and the handful of actions you want taken, if you stop answering.

1. **Armed.** You check in. A streak counter on the public page is real days of operation.
2. **Concerned.** You miss your deadline. It nudges you on Slack.
3. **Pleading.** Still silent. It writes to your witnesses — people you named — and asks
   what they know. Their reply is the only thing that stands the clock down, short of you.
4. **Executing.** Past the final grace, it does what the document says: a farewell issue on
   your repo, a message in your channel, a file released from object storage. Each action is
   written to an append-only public notice board with its result reference.

Everything either phase does is on `/ledger`. Nothing on that page is a letter body.

![Trust and wake architecture](docs/trust-wake.svg)

The two paths that matter: **the trust path** (every outward call crosses Fly's connector
gateway, which holds the credential) and **the wake path** (a Sprite has no scheduler, so every
way time can pass is named).

## Evidence you can re-run

The repository ships the probes rather than a claim that probing happened:

```
scripts/probe-wake.sh inside     # P0/P1: node+sqlite, disk persistence, boot counter, task hold
scripts/probe-wake.sh outside <url>   # P1b: wake-on-request latency, measured from outside
scripts/probe-connectors.sh --write   # P2: gateway catalogue, then a real issue + Slack message
scripts/probe-llm.sh             # P3: the exact model path the gateway exposes
scripts/demo-driver.sh           # the whole ladder, ARMED -> EXECUTED, in one run
```


## Honest engineering notes

**There is no scheduler on a Sprite.** It pauses about 30 seconds after activity stops and
wakes only on an inbound HTTP request, or while a Task holds it (one hour maximum, renewed
by heartbeat). So "the agent notices you are gone" is only true if something wakes it. This
deployment names its wake sources, plainly, on the home page:

- each check-in and each witness visit is an inbound request and wakes it;
- a scheduled GitHub Action pings `POST /tick` every 30 minutes;
- a second, independent external pinger hits the same route (different failure domain).

If both pingers die, the deadline slips — the page says so rather than implying vigilance
the system cannot have.

**Secrets.** No provider credential ever enters the Sprite. Connector requests go to
`https://api.sprites.dev/v1/gateway/...` with no Authorization header; Fly injects the
credential at the gateway. `/proof` shows the environment variable *names* and the granted
scopes, never values.

## Layout

```
src/      types state evaluator executor connectors mind wake ledger server + pages/
public/   style.css, favicon.svg
test/     node:test suites
scripts/  probes, demo driver, streak check-in
docs/     the one architecture diagram
```

Run locally: `node --experimental-sqlite --experimental-strip-types src/server.ts`
Test: `npm test` · Type-check: `npm run typecheck`

## Day 0 platform facts

Established from Fly's documentation before any product code was written. Notes in
`discovery/hacksgiving/`.

- **No scheduler.** Pause ~30s after activity; wake only on inbound HTTP or a held Task
  (max 1h, heartbeat-renewed via `/.sprite/api.sock`). Designs that "notice" something on a
  clock must name a wake source.
- **Connectors are deny-by-default.** Credentials live in the org and are injected at
  `https://api.sprites.dev/v1/gateway/<connector>/<path>`; the Sprite never holds the token.
  GitHub OAuth takes `scopes=repo,read:org`, with an `add_scopes` flow to widen later.
- **Egress is unrestricted by default**; a DNS allowlist policy is opt-in from outside and
  read-only inside (`/.sprite/policy/network.json`).
- **Disk persists, memory does not.** 8 vCPU, 100 GB ext4 (TRIM-billed), `auto-` checkpoints
  after ~1h of activity and on idle; a Service restarts at boot, a hand-started process does
  not survive a cold wake.
- **Inbound is one always-on HTTPS URL** per Sprite (`https://<name>-<org>.sprites.app/`),
  private by default; `--url-auth public` opens it.

## Licence

MIT
