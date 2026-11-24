// src/connectors.ts — FROZEN CALL SITES (executor-plan.md §2.4).
//
// The whole trust story lives in this file: NO Authorization header is ever attached to a
// connector call. The Sprites gateway authenticates the *caller's identity* (the Sprite the
// code runs on) and injects the stored credential on the way to the provider. A Sprite that
// never holds a token cannot leak one.

export const GATEWAY = 'https://api.sprites.dev/v1/gateway';

export interface GatewayResult<T = unknown> {
  ok: boolean;
  status: number;
  body: T | null;
  text: string;
  /** Set when the call never left the box (no gateway reachable, network error). */
  unreachable?: string;
}

export interface ConnectorInfo {
  id: string;
  provider: string;
  scopes?: string[];
  usageSnippet?: string;
  raw: unknown;
}

function headers(extra?: Record<string, string>): Record<string, string> {
  // Deliberately no Authorization: the gateway reads the Sprite identity and nothing else.
  return { 'content-type': 'application/json', ...(extra ?? {}) };
}

export async function gatewayCall<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<GatewayResult<T>> {
  const method = init.method ?? 'GET';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 15_000);
  try {
    const res = await fetch(`${GATEWAY}${path}`, {
      method,
      headers: headers(),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
    const text = await res.text();
    let body: T | null = null;
    try {
      body = text ? (JSON.parse(text) as T) : null;
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body, text };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, body: null, text: '', unreachable: message };
  } finally {
    clearTimeout(timer);
  }
}

/** Boot discovery: which connectors this Sprite may reach, and with which scopes. */
export async function listConnectors(): Promise<ConnectorInfo[]> {
  const res = await gatewayCall<Record<string, unknown>>('/list');
  if (!res.ok || !res.body) return [];
  return parseConnectorList(res.body);
}

/** Tolerant parse: the catalogue shape is the platform's, not ours. */
export function parseConnectorList(raw: unknown): ConnectorInfo[] {
  const out: ConnectorInfo[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    const provider = pickString(o, ['provider', 'name', 'slug', 'type']);
    const id = pickString(o, ['connection_id', 'connectionId', 'id']);
    if (provider && id) {
      const info: ConnectorInfo = { id, provider, raw: node };
      const raw = o.scopes ?? o.granted_scopes ?? o.grantedScopes;
      // The gateway hands scopes back as a comma-separated string ("read:org,repo"), not an
      // array, so an Array-only check silently renders an empty scope list on /proof, which is
      // the one page whose job is to show exactly this.
      const scopes = typeof raw === 'string' ? raw.split(',') : raw;
      if (Array.isArray(scopes)) {
        info.scopes = scopes.map((s) => String(s).trim()).filter((s): s is string => s.length > 0);
      }
      const snippet = pickString(o, ['usage_snippet', 'usageSnippet', 'example']);
      if (snippet) info.usageSnippet = snippet;
      out.push(info);
      return;
    }
    Object.values(o).forEach(walk);
  };
  walk(raw);
  return dedupe(out);
}

function pickString(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function dedupe(list: ConnectorInfo[]): ConnectorInfo[] {
  const seen = new Map<string, ConnectorInfo>();
  for (const c of list) seen.set(`${c.provider}:${c.id}`, c);
  return [...seen.values()];
}

// --- frozen call sites ------------------------------------------------------

/** Read-only look at the owner's public activity — the investigation step. */
export async function githubPublicEvents(connectorId: string, owner: string) {
  return gatewayCall<unknown>(`/github/${connectorId}/users/${owner}/events/public`);
}

/** Who the connector acts as. Also the cheapest proof that the grant works. */
export async function githubMe(connectorId: string) {
  return gatewayCall<{ login?: string }>(`/github/${connectorId}/user`);
}

/** The last public sign of life on a repo the owner named. */
export async function githubLastCommit(connectorId: string, repo: string) {
  return gatewayCall<Array<{ commit?: { author?: { date?: string }; message?: string } }>>(
    `/github/${connectorId}/repos/${repo}/commits?per_page=1`,
  );
}

/**
 * Mail through a custom-API connector (AgentMail or any token-auth mail API).
 * Provider and path are configuration, not code, because custom connectors vary.
 */
export async function emailSend(connectorId: string, to: string, subject: string, text: string) {
  const provider = process.env.MAIL_PROVIDER ?? 'agentmail';
  const path = process.env.MAIL_PATH ?? '/messages';
  return gatewayCall<unknown>(`/${provider}/${connectorId}${path}`, {
    method: 'POST',
    body: { to, subject, text },
  });
}

/** The farewell issue. */
export async function githubCreateIssue(connectorId: string, repo: string, title: string, body: string) {
  return gatewayCall<{ html_url?: string; number?: number }>(`/github/${connectorId}/repos/${repo}/issues`, {
    method: 'POST',
    body: { title, body },
  });
}

/** The message to the people named in the will. */
export async function slackPostMessage(connectorId: string, channel: string, text: string) {
  return gatewayCall<{ ok?: boolean; ts?: string; channel?: string }>(`/slack/${connectorId}/chat.postMessage`, {
    method: 'POST',
    body: { channel, text },
  });
}

/**
 * One OpenAI-compatible chat completion through the model connector.
 * The exact path comes from the connector's own usage_snippet (bound at probe P3); until
 * then we try the documented shape and fall back rather than guessing silently.
 */
export async function llmChat(
  connectorId: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  pathHint?: string,
): Promise<GatewayResult<unknown>> {
  const candidates = [pathHint, '/chat/completions', '/v1/chat/completions'].filter(Boolean) as string[];
  let last: GatewayResult<unknown> | null = null;
  for (const p of candidates) {
    const path = p.startsWith('/') ? p : `/${p}`;
    last = await gatewayCall<unknown>(`/ollama/${connectorId}${path}`, {
      method: 'POST',
      body: { model, messages, max_tokens: 320, temperature: 0.6 },
      timeoutMs: 45_000,
    });
    if (last.ok) return last;
    if (last.status !== 404) return last; // a real error, not a path mismatch
  }
  return last ?? { ok: false, status: 0, body: null, text: '' };
}
