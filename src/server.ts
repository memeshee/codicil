// src/server.ts — the HTTP spine. Node stdlib only; no framework, no dependency that could
// rot between now and judging.
//
// Every inbound request runs the evaluator once (wake.ts), because on a Sprite an inbound
// request is the ONLY thing that makes time pass for this program.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { Store, hashToken, newToken, tokenMatches, utcDayKey } from './state.ts';
import { applyCheckIn, applyRevoke, applyVouch, applyWillSigned, msToNextBoundary, toSnapshot } from './evaluator.ts';
import { onWake, recordTick } from './wake.ts';
import { executeWill, notifyWitnesses, sendNudge } from './executor.ts';
import { investigate } from './mind.ts';
import { GATEWAY, listConnectors, type ConnectorInfo } from './connectors.ts';
import { noticeBoard } from './ledger.ts';
import type { Instruction, Will, WitnessSpec } from './types.ts';
import { renderHome } from './pages/home.ts';
import { renderWill } from './pages/will.ts';
import { renderWitness } from './pages/witness.ts';
import { renderLedger } from './pages/ledger.ts';
import { renderProof } from './pages/proof.ts';
import { renderTry } from './pages/try.ts';
import { renderOpen } from './pages/open.ts';
import { renderVerify } from './pages/verify.ts';
import { shell } from './pages/layout.ts';

const PORT = Number(process.env.PORT ?? 8080);
const DEMO = process.env.DEMO === '1';
const DATA_DIR = process.env.DATA_DIR ?? process.cwd();
const DB_PATH = process.env.DB_PATH ?? join(DATA_DIR, 'codicil.db');
const PING_TOKEN = process.env.PING_TOKEN ?? '';
const LLM_PROVIDER = (process.env.LLM_PROVIDER ?? 'ollama') as 'ollama' | 'openrouter' | 'none';
const LLM_MODEL = process.env.LLM_MODEL ?? 'glm-5.3';

const store = new Store(DB_PATH);
const startedAt = new Date().toISOString();

// --- tiny helpers -----------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += String(c);
      if (data.length > 1_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function parseBody(raw: string, contentType: string): Record<string, string> {
  if (!raw) return {};
  if (contentType.includes('application/json')) {
    try {
      const j = JSON.parse(raw) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(raw).entries());
}

function send(res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  send(res, status, JSON.stringify(obj, null, 2), 'application/json; charset=utf-8');
}

function redirect(res: ServerResponse, to: string): void {
  res.writeHead(303, { location: to });
  res.end();
}

// Rate limit: 10 check-in attempts per minute per client.
const hits = new Map<string, number[]>();
function rateLimited(key: string, limit = 10, windowMs = 60_000): boolean {
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > limit;
}

/** Absolute base URL as the caller saw it. Behind Fly's proxy the scheme is forwarded. */
function baseUrl(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim();
  const scheme = proto === 'https' || proto === 'http' ? proto : host.startsWith('localhost') ? 'http' : 'https';
  return `${scheme}://${host}`;
}

function clientKey(req: IncomingMessage): string {
  return (req.socket.remoteAddress ?? 'unknown') + ':' + (req.headers['x-forwarded-for'] ?? '');
}

// --- owner token bootstrap --------------------------------------------------

function ownerTokenPath(): string {
  return join(DATA_DIR, 'owner-token');
}

function ensureOwnerToken(): string | null {
  if (store.getOwnerTokenHash()) return null;
  const path = ownerTokenPath();
  if (existsSync(path)) {
    const token = readFileSync(path, 'utf8').trim();
    if (token) {
      store.setOwnerTokenHash(hashToken(token));
      return null;
    }
  }
  const token = newToken();
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(path, token + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
  store.setOwnerTokenHash(hashToken(token));
  return token;
}

// --- connector cache --------------------------------------------------------

let connectorCache: { at: number; list: ConnectorInfo[] } = { at: 0, list: [] };

async function connectors(): Promise<ConnectorInfo[]> {
  if (Date.now() - connectorCache.at < 5 * 60_000) return connectorCache.list;
  const list = await listConnectors();
  connectorCache = { at: Date.now(), list };
  store.setKVPublic('connectors', { at: new Date().toISOString(), list });
  return list;
}

// --- will construction ------------------------------------------------------

function buildWill(form: Record<string, string>, previous: Will | null, now: string): { will: Will; witnesses: WitnessSpec[] } {
  const deadline = Number(form.deadline ?? (previous?.policy.deadlineMinutes ?? 10080));
  const nudge = Number(form.nudge ?? (previous?.policy.nudgeGraceMinutes ?? 2880));
  const plead = Number(form.plead ?? (previous?.policy.pleadGraceMinutes ?? 1440));
  if (!DEMO && (deadline < 60 || nudge < 60 || plead < 60)) {
    throw new Error('graces below 60 minutes are only accepted with DEMO=1');
  }
  if (DEMO && (deadline <= 0 || nudge <= 0 || plead <= 0)) {
    throw new Error('graces must be positive');
  }
  const minGrace = DEMO ? 0.05 : 1;
  if (!Number.isFinite(deadline) || deadline < minGrace) throw new Error(`deadline must be at least ${minGrace} minute(s)`);

  // Witness syntax: "Ada", "Ada <U0123ABCD>", "Grace <grace@example.com>".
  // A witness with no channel can still vouch from their link — but they cannot be *told*,
  // and the ledger will say so instead of pretending.
  const witnesses = (form.witnesses ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/^(.+?)\s*<([^>]+)>$/);
      if (!m) return { name: s } as WitnessSpec;
      const name = m[1]!.trim();
      const channel = m[2]!.trim();
      return (channel.includes('@')
        ? { name, email: channel }
        : { name, slackUserId: channel }) as WitnessSpec;
    });

  const instructions: Instruction[] = [];
  const letter = (form.letter ?? previous?.letter ?? '').trim();
  if (!letter) throw new Error('the will needs your words');

  if (form.repo) {
    instructions.push({
      kind: 'github_issue',
      repo: form.repo.trim(),
      title: 'A last word, delivered by an executor that holds no key',
      body: '',
    });
  }
  if (form.slack) {
    instructions.push({ kind: 'slack_post', target: form.slack.trim(), text: '' });
  }

  // The sealed blob arrives already encrypted by the browser. We never see a passphrase;
  // if the client could not encrypt (no JS), we refuse rather than store plaintext silently.
  let sealed: Will['sealed'] | undefined = previous?.sealed;
  if (form.sealed_blob !== undefined) {
    const raw = form.sealed_blob.trim();
    if (raw) {
      try {
        const b = JSON.parse(raw) as { ct?: string; iv?: string; salt?: string; hint?: string };
        if (!b.ct || !b.iv || !b.salt) throw new Error('incomplete blob');
        sealed = { ct: b.ct, iv: b.iv, salt: b.salt, ...(b.hint ? { hint: b.hint } : {}) };
      } catch {
        throw new Error('the sealed letter was malformed — seal it in the browser, not by hand');
      }
    } else {
      sealed = undefined;
    }
  }

  const vouchQuorum = Math.max(1, Math.min(5, Number(form.quorum ?? previous?.policy.vouchQuorum ?? 1) || 1));

  const will: Will = {
    version: (previous?.version ?? 0) + 1,
    owner: { name: form.name?.trim() || previous?.owner.name || 'the owner', github: form.github?.trim() || previous?.owner.github || '' },
    letter,
    policy: { deadlineMinutes: deadline, nudgeGraceMinutes: nudge, pleadGraceMinutes: plead, vouchQuorum },
    ...(sealed ? { sealed } : {}),
    instructions: instructions.length ? instructions : (previous?.instructions ?? []),
    witnesses,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  return { will, witnesses };
}

// --- request pipeline -------------------------------------------------------

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const now = new Date().toISOString();

  // Wake first: on a Sprite, this request might be the first activity in hours.
  const wake = await onWake(store, now);
  let phase = wake.state.phase;

  // A nudge is a real call, not a ledger row: the owner gets told, through the connector,
  // that the clock has run out.
  if (wake.transitions.some((t) => t.kind === 'nudge')) {
    const will = store.getWill();
    const channel =
      (will?.instructions.find((i) => i.kind === 'slack_post') as { target?: string } | undefined)?.target ??
      process.env.NUDGE_CHANNEL ??
      '';
    if (will && channel) {
      const nudge = await sendNudge({ store, connectors: await connectors(), now }, will, channel);
      console.log(`[nudge] slack ${nudge.ok ? 'sent' : 'failed'}${nudge.ref ? ` ref=${nudge.ref}` : ''}${nudge.note ? ` (${nudge.note})` : ''}`);
    } else {
      store.appendEvent('execute_fail', { kind: 'nudge', reason: 'no channel configured' }, now);
    }
  }

  // PLEADING: the witnesses have to be TOLD. This is the beat the product's whole human
  // ladder rests on, and until now nothing was ever sent.
  if (wake.transitions.some((t) => t.kind === 'witness_notified')) {
    const will = store.getWill();
    if (will) {
      const mind = { connectors: await connectors(), provider: LLM_PROVIDER, model: LLM_MODEL };
      const inv = await investigate(will, mind);
      store.setKVPublic('briefing', {
        at: now,
        summary: inv.summary,
        narrative: inv.narrative,
        briefing: inv.briefing,
      });
      store.appendEvent('investigate', { source: inv.source, summary: inv.summary, ...inv.detail }, now);
      const told = await notifyWitnesses({ store, connectors: await connectors(), now }, will, inv.briefing);
      console.log(`[witnesses] sent=${told.sent} unreachable=${told.unreachable.join(',') || 'none'}`);
    }
  }

  // Drain EXECUTING exactly once, here, so every path (tick, page view, check-in) can
  // complete an execution that came due while the box was asleep.
  if (phase === 'EXECUTING') {
    const outcome = await executeWill({ store, connectors: await connectors(), mind: { connectors: await connectors(), provider: LLM_PROVIDER, model: LLM_MODEL }, now });
    phase = store.getState(now).phase;
    store.appendEvent('boot', { note: 'execution drained', ok: outcome.ok, failed: outcome.failed }, now);
  }

  // static assets
  if (method === 'GET' && (path === '/style.css' || path === '/favicon.svg')) {
    const file = join(process.cwd(), 'public', path.slice(1));
    if (existsSync(file)) {
      const type = extname(file) === '.css' ? 'text/css; charset=utf-8' : 'image/svg+xml';
      send(res, 200, readFileSync(file, 'utf8'), type);
      return;
    }
    send(res, 404, 'not found', 'text/plain');
    return;
  }

  // machine endpoints
  if (method === 'GET' && path === '/healthz') {
    const s = store.getState(now);
    sendJson(res, 200, { ok: true, phase: s.phase, lastCheckIn: s.lastCheckIn, lastTickAt: s.lastTickAt, uptimeSince: startedAt });
    return;
  }
  if (method === 'GET' && path === '/api/state') {
    sendJson(res, 200, toSnapshot(store.getState(now), store.getWill()));
    return;
  }
  if (method === 'POST' && path === '/tick') {
    const presented = String(req.headers['x-ping-token'] ?? '');
    if (PING_TOKEN && !tokenMatches(presented, hashToken(PING_TOKEN))) {
      sendJson(res, 403, { ok: false, error: 'bad ping token' });
      return;
    }
    recordTick(store, now);
    sendJson(res, 200, { ok: true, phase: store.getState(now).phase });
    return;
  }

  if (method === 'GET' && path === '/') {
    const s = store.getState(now);
    const will = store.getWill();
    const lastTickAgeSeconds = s.lastTickAt ? Math.max(0, (Date.parse(now) - Date.parse(s.lastTickAt)) / 1000) : null;
    send(
      res,
      200,
      renderHome({
        snapshot: toSnapshot(s, will),
        will,
        msToNextBoundary: msToNextBoundary(s, will, now),
        lastTickAgeSeconds,
        demo: DEMO,
        receipts: s.phase === 'EXECUTED' ? store.listInstructions() : [],
        canTry: DEMO,
        revokedAt: s.revokedAt ?? null,
        wakeSources: [
          'your own check-in, and any witness opening their notice — both are inbound requests',
          'a scheduled GitHub Action calling POST /tick every 30 minutes',
          'a second, independent external pinger on the same route, in a different failure domain',
        ],
      }),
    );
    return;
  }

  if (method === 'GET' && path === '/will') {
    send(res, 200, renderWill({ will: store.getWill(), demo: DEMO }));
    return;
  }

  if (method === 'GET' && path === '/ledger') {
    const events = store.listEvents(500);
    send(res, 200, renderLedger({ rows: noticeBoard(events), demo: DEMO, count: events.length }));
    return;
  }

  if (method === 'GET' && path === '/proof') {
    const list = await connectors();
    send(
      res,
      200,
      renderProof({
        envNames: Object.keys(process.env).filter((k) => ['PING_TOKEN', 'DEMO', 'LLM_PROVIDER', 'LLM_MODEL', 'PORT', 'DATA_DIR', 'DB_PATH'].includes(k)),
        connectorList: list.length ? list.map((c) => ({ provider: c.provider, connection_id: c.id, scopes: c.scopes ?? [] })) : null,
        phase: store.getState(now).phase,
        gateway: GATEWAY,
        demo: DEMO,
        chain: store.verifyChain(),
        sealed: Boolean(store.getWill()?.sealed),
      }),
    );
    return;
  }

  // --- witness routes -------------------------------------------------------
  const witnessMatch = path.match(/^\/w\/([a-f0-9]+)\/([A-Za-z0-9_-]+)(\/(vouch|unknown))?$/);
  if (witnessMatch) {
    const [, wid, token, vouch] = witnessMatch;
    const action = witnessMatch[4] ?? null;
    const witness = store.getWitness(wid!);
    if (!witness || !tokenMatches(token!, witness.tokenHash)) {
      send(res, 404, shell({ title: 'Codicil — not found' }, '<section class="card"><h1>This link is not valid.</h1><p class="muted">Witness notices are private to one person.</p></section>'));
      return;
    }
    if (vouch) {
      if (method !== 'POST') {
        send(res, 405, 'method not allowed', 'text/plain');
        return;
      }
      if (action === 'unknown') {
        // "I don't know" is an answer, and it is recorded as one — it just does not reset
        // anything. Silence and uncertainty are not consent.
        store.appendEvent('quorum', { witnessId: wid, answer: 'unknown', counted: false }, now);
      } else {
        store.markWitnessVouched(wid!);
        const r = applyVouch(store.getState(now), wid!, now, store.getWill());
        store.setState(r.state);
        r.events.forEach((e) => store.appendEvent(e.kind, e.detail, now));
      }
    }
    send(
      res,
      200,
      renderWitness({
        witness,
        will: store.getWill(),
        snapshot: toSnapshot(store.getState(now), store.getWill()),
        demo: DEMO,
        vouched: Boolean(witness.vouchedAt) || Boolean(vouch && method === 'POST' && action !== 'unknown'),
        lastCheckIn: store.getState(now).lastCheckIn,
        briefing: store.getKVPublic<{ briefing?: { checked: string[]; couldNotVerify: string[]; suggest: string[] }; narrative?: string }>('briefing') ?? null,
        quorum: store.getWill()?.policy.vouchQuorum ?? 1,
        counted: store.getState(now).vouchIds?.length ?? 0,
      }),
    );
    return;
  }

  // --- trust routes ---------------------------------------------------------

  if (method === 'GET' && path === '/verify.json') {
    sendJson(res, 200, { chain: store.verifyChain(), rows: store.listChain() });
    return;
  }
  if (method === 'GET' && path === '/verify') {
    send(res, 200, renderVerify({ chain: store.verifyChain(), demo: DEMO, count: store.listChain().length }));
    return;
  }
  if (method === 'GET' && path === '/open') {
    send(res, 200, renderOpen({ will: store.getWill(), demo: DEMO }));
    return;
  }
  if (DEMO && method === 'GET' && path === '/try') {
    const will = store.getWill();
    send(
      res,
      200,
      renderTry({
        will,
        prefill: {
          name: url.searchParams.get('name') ?? undefined,
          letter: url.searchParams.get('letter') ?? undefined,
          witnesses: url.searchParams.get('witnesses') ?? undefined,
        },
        snapshot: toSnapshot(store.getState(now), will),
        msToNextBoundary: msToNextBoundary(store.getState(now), will, now),
        demoToken: store.getKVPublic<string>('demoToken') ?? '',
        repo: process.env.DEMO_REPO ?? '',
        channel: process.env.DEMO_SLACK ?? '',
        demo: true,
      }),
    );
    return;
  }
  if (DEMO && method === 'POST' && path === '/try') {
    // A spectator may drive the whole ladder without an owner token: this is a disposable
    // instance, and the will it signs is this instance's will, labelled DEMO everywhere.
    if (rateLimited(`try:${clientKey(req)}`, 4, 60_000)) {
      sendJson(res, 429, { ok: false, error: 'slow down a moment' });
      return;
    }
    const form = parseBody(await readBody(req), String(req.headers['content-type'] ?? ''));
    const demoToken = new (await import('node:crypto')).randomBytes(12).toString('base64url') as string;
    form.token = demoToken;
    form.deadline = form.deadline || '0.34';
    form.nudge = form.nudge || '0.34';
    form.plead = form.plead || '0.34';
    form.name = form.name || 'a visitor';
    form.letter = form.letter || 'This is a demo will, signed by a visitor to the demo instance.';
    if (process.env.DEMO_REPO) form.repo = process.env.DEMO_REPO;
    if (process.env.DEMO_SLACK) form.slack = process.env.DEMO_SLACK;
    store.setKVPublic('demoToken', demoToken);
    const previous = store.getWill();
    try {
      const { will, witnesses } = buildWill(form, previous, now);
      const created = store.replaceWitnesses(witnesses);
      store.replaceInstructions(will.instructions);
      store.setWill(will);
      const r = applyWillSigned(store.getState(now), will, now);
      store.setState(r.state);
      r.events.forEach((e) => store.appendEvent(e.kind, { ...e.detail, demo: true }, now));
      const links = created.map((c) => ({ name: c.row.name, url: `${baseUrl(req)}/w/${c.row.id}/${c.token}` }));
      if (String(req.headers.accept ?? '').includes('text/html')) {
        // A browser signing from /try lands back on the live ladder, not on raw JSON.
        redirect(res, '/try');
        return;
      }
      sendJson(res, 200, { ok: true, demoToken, phase: r.state.phase, witnesses: links, ladderMinutes: will.policy });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // --- api ------------------------------------------------------------------
  if (method === 'POST' && path === '/api/checkin') {
    if (rateLimited(clientKey(req))) {
      sendJson(res, 429, { ok: false, error: 'too many attempts' });
      return;
    }
    const form = parseBody(await readBody(req), String(req.headers['content-type'] ?? ''));
    const demoToken = DEMO ? store.getKVPublic<string>('demoToken') : null;
    const okOwner = tokenMatches(form.token ?? '', store.getOwnerTokenHash());
    const okDemo = Boolean(demoToken && form.token === demoToken);
    if (!okOwner && !okDemo) {
      sendJson(res, 403, { ok: false, error: 'bad owner token' });
      return;
    }
    const r = applyCheckIn(store.getState(now), store.getWill(), now);
    store.setState(r.state);
    r.events.forEach((e) => store.appendEvent(e.kind, e.detail, now));
    if (String(req.headers['accept'] ?? '').includes('text/html')) redirect(res, '/');
    else sendJson(res, 200, { ok: true, phase: r.state.phase, streakDays: r.state.streakDays });
    return;
  }

  if (method === 'POST' && path === '/api/revoke') {
    const form = parseBody(await readBody(req), String(req.headers['content-type'] ?? ''));
    if (!tokenMatches(form.token ?? '', store.getOwnerTokenHash())) {
      sendJson(res, 403, { ok: false, error: 'bad owner token' });
      return;
    }
    const r = applyRevoke(store.getState(now), form.reason?.trim() || 'owner withdrew consent', now);
    store.setState(r.state);
    r.events.forEach((e) => store.appendEvent(e.kind, e.detail, now));
    sendJson(res, 200, {
      ok: true,
      phase: r.state.phase,
      note: 'nothing will execute for this version. Signing a new version re-arms it.',
    });
    return;
  }

  if (method === 'POST' && path === '/api/rotate') {
    const form = parseBody(await readBody(req), String(req.headers['content-type'] ?? ''));
    if (!tokenMatches(form.token ?? '', store.getOwnerTokenHash())) {
      sendJson(res, 403, { ok: false, error: 'bad owner token' });
      return;
    }
    const fresh = newToken();
    store.setOwnerTokenHash(hashToken(fresh));
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(ownerTokenPath(), fresh + '\n', { mode: 0o600 });
    chmodSync(ownerTokenPath(), 0o600);
    store.appendEvent('token_rotated', { at: now, note: 'previous token invalid immediately' }, now);
    sendJson(res, 200, { ok: true, token: fresh, note: 'the old token no longer checks in. Store this one.' });
    return;
  }

  if (method === 'POST' && path === '/api/will') {
    const form = parseBody(await readBody(req), String(req.headers['content-type'] ?? ''));
    if (!tokenMatches(form.token ?? '', store.getOwnerTokenHash())) {
      sendJson(res, 403, { ok: false, error: 'bad owner token' });
      return;
    }
    try {
      const previous = store.getWill();
      const { will, witnesses } = buildWill(form, previous, now);
      const created = store.replaceWitnesses(witnesses);
      store.replaceInstructions(will.instructions);
      store.setWill(will);
      const r = applyWillSigned(store.getState(now), will, now);
      store.setState(r.state);
      r.events.forEach((e) => store.appendEvent(e.kind, { ...e.detail, demo: DEMO }, now));

      const base = baseUrl(req);
      const links = created.map((c) => ({ name: c.row.name, url: `${base}/w/${c.row.id}/${c.token}` }));
      const body = `
<section class="card">
  <p class="kicker">sealed · version ${will.version}</p>
  <h1>The will is armed.</h1>
  <p>Send each witness their own link. They are shown once: only hashes are stored, so this page
  is the only copy that will ever exist.</p>
  <ul class="plain">${links.map((l) => `<li>${l.name}: <code>${l.url}</code></li>`).join('') || '<li class="muted">no witnesses named</li>'}</ul>
  <p class="muted small">${will.instructions.length} instruction(s) · deadline ${will.policy.deadlineMinutes} min ·
  nudge ${will.policy.nudgeGraceMinutes} min · plead ${will.policy.pleadGraceMinutes} min</p>
  <p><a href="/">back to the home page</a></p>
</section>`;
      send(res, 200, shell({ title: 'Codicil — will sealed', active: 'will', demo: DEMO }, body));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 400, { ok: false, error: message });
    }
    return;
  }

  send(res, 404, shell({ title: 'Codicil — not found' }, '<section class="card"><h1>Nothing here.</h1></section>'));
}

// --- boot -------------------------------------------------------------------

const booted = ensureOwnerToken();
store.appendEvent('boot', { port: PORT, demo: DEMO, dayKey: utcDayKey(startedAt) }, startedAt);

createServer((req, res) => {
  handle(req, res).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    store.appendEvent('boot', { error: message }, new Date().toISOString());
    sendJson(res, 500, { ok: false, error: message });
  });
}).listen(PORT, () => {
  console.log(`codicil listening on :${PORT} (demo=${DEMO ? 'on' : 'off'}, db=${DB_PATH})`);
  if (booted) {
    console.log(`owner token written ONCE to ${ownerTokenPath()} (0600). Read it with: cat ${ownerTokenPath()}`);
  }
});
