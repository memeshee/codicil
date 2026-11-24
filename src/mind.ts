// src/mind.ts — the model beat, with a ladder that never depends on a model being available.
//
// 1. Ollama managed connector (partner alignment: judge Chiang's connector).
// 2. OpenRouter managed connector.
// 3. Deterministic template. Always available, always honest.

import type { Will } from './types.ts';
import { githubPublicEvents, llmChat, type ConnectorInfo } from './connectors.ts';

export interface MindContext {
  connectors: ConnectorInfo[];
  provider: 'ollama' | 'openrouter' | 'none';
  model: string;
}

export interface Investigation {
  source: 'github' | 'none';
  summary: string;
  detail: Record<string, unknown>;
}

/**
 * The investigation step. Read-only by design: it looks at public activity to give the
 * witnesses context, and it NEVER resets the clock (executor-plan.md §2.1).
 */
export async function investigate(will: Will, mind: MindContext): Promise<Investigation> {
  const gh = mind.connectors.find((c) => c.provider.includes('github'));
  if (!gh) {
    return {
      source: 'none',
      summary: 'No GitHub connector was reachable, so no public activity could be checked.',
      detail: { reason: 'connector_missing' },
    };
  }
  const res = await githubPublicEvents(gh.id, will.owner.github);
  if (!res.ok) {
    return {
      source: 'none',
      summary: `The GitHub connector answered ${res.status}; nothing could be checked.`,
      detail: { status: res.status },
    };
  }
  const events = Array.isArray(res.body) ? (res.body as Array<Record<string, unknown>>) : [];
  const first = events[0];
  const lastSeen = first && typeof first.created_at === 'string' ? first.created_at : null;
  return {
    source: 'github',
    summary:
      events.length === 0
        ? 'No public activity at all was found on the account.'
        : `${events.length} public event(s) visible; most recent ${lastSeen ?? 'unknown'}.`,
    detail: { count: events.length, lastSeen },
  };
}

/**
 * Compose the closing note. The owner's letter is the spine and is carried VERBATIM —
 * the model is only allowed to write a short frame around it, never to rewrite it.
 */
export async function composeLetter(
  will: Will,
  investigation: Investigation,
  mind: MindContext,
): Promise<{ text: string; usedModel: boolean }> {
  const letter = will.letter.trim();
  const frame = templateFrame(will, investigation);
  if (mind.provider === 'none') return { text: `${frame}\n\n${letter}`, usedModel: false };

  const connector = mind.connectors.find((c) =>
    mind.provider === 'ollama' ? c.provider.includes('ollama') || c.provider.includes('openrouter') : c.provider.includes('openrouter'),
  );
  if (!connector) return { text: `${frame}\n\n${letter}`, usedModel: false };

  const res = await llmChat(
    connector.id,
    mind.model,
    [
      {
        role: 'system',
        content:
          'You write two sentences of plain framing for a letter a person left behind. Warm, concrete, no eulogy cliches, no mention of AI. You never alter the letter itself.',
      },
      {
        role: 'user',
        content: `The person is ${will.owner.name}. Their own words follow; write ONLY two sentences introducing them, then stop.\n\n${letter}`,
      },
    ],
    connector.usageSnippet,
  );

  const text = res.ok ? extractText(res.body) : null;
  if (!text) return { text: `${frame}\n\n${letter}`, usedModel: false };
  return { text: `${text.trim()}\n\n${letter}`, usedModel: true };
}

export function templateFrame(will: Will, investigation: Investigation): string {
  const name = will.owner.name;
  return [
    `${name} asked that this be sent if they stopped answering.`,
    investigation.source === 'github'
      ? `Before sending it, the executor checked: ${investigation.summary}`
      : 'The executor could not check public activity; it says so rather than implying otherwise.',
  ].join(' ');
}

function extractText(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  const choices = o.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const c = choices[0] as Record<string, unknown>;
    const msg = c.message as Record<string, unknown> | undefined;
    if (msg && typeof msg.content === 'string') return msg.content;
    if (typeof c.text === 'string') return c.text;
  }
  if (typeof o.response === 'string') return o.response;
  return null;
}
