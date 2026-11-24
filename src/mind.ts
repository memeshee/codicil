// src/mind.ts — the model beat, with a ladder that never depends on a model being available.
//
// 1. Ollama managed connector (partner alignment: judge Chiang's connector).
// 2. OpenRouter managed connector.
// 3. Deterministic template. Always available, always honest.

import type { Will } from './types.ts';
import { githubLastCommit, githubMe, githubPublicEvents, llmChat, type ConnectorInfo } from './connectors.ts';

export interface MindContext {
  connectors: ConnectorInfo[];
  provider: 'ollama' | 'openrouter' | 'none';
  model: string;
}

export interface Investigation {
  source: 'github' | 'none';
  summary: string;
  detail: Record<string, unknown>;
  /** What was actually checked, what could not be, and what a witness should do next. */
  briefing: Briefing;
  /** Prose version of the briefing, model-written when a model is reachable. */
  narrative: string;
}

export interface Briefing {
  checked: string[];
  couldNotVerify: string[];
  suggest: string[];
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
      briefing: {
        checked: ['the clock itself: no check-in arrived inside the deadline'],
        couldNotVerify: ['any public activity — no GitHub connector was granted to this Sprite'],
        suggest: [
          'try to reach them on a channel a machine cannot see: a call, a door, a person',
          'do not assume the worst from silence alone',
        ],
      },
      narrative: '',
    };
  }
  // Three fallbacks deep, because "nothing could be checked" is the least useful thing an
  // executor can tell a worried witness. An empty handle used to produce a 404 on /users//events
  // and the whole investigation gave up; now a missing handle just moves to a narrower question.
  const checked: string[] = [];
  const couldNot: string[] = [];
  let events: Array<Record<string, unknown>> = [];
  let lastSeen: string | null = null;
  let source = 'none';

  const handle = (will.owner.github ?? '').trim().replace(/^@/, '');
  if (handle) {
    const res = await githubPublicEvents(gh.id, handle);
    if (res.ok && Array.isArray(res.body)) {
      events = res.body as Array<Record<string, unknown>>;
      const first = events[0];
      lastSeen = first && typeof first.created_at === 'string' ? first.created_at : lastSeen;
      checked.push(`${events.length} public GitHub event(s) on @${handle}`);
      source = 'github';
    } else {
      couldNot.push(`public events for @${handle} (the connector answered ${res.status})`);
    }
  } else {
    couldNot.push('the owner never stored a GitHub handle, so public events could not be looked up');
  }

  // Narrower but verifiable: who the connector acts as, and the repo's last commit.
  const me = await githubMe(gh.id);
  if (me.ok && me.body && typeof (me.body as { login?: string }).login === 'string') {
    checked.push(`the connector authenticates as @${(me.body as { login?: string }).login}`);
    source = source === 'none' ? 'github' : source;
  }
  const repo = (process.env.DEMO_REPO ?? '').trim();
  if (repo) {
    const lc = await githubLastCommit(gh.id, repo);
    const row = lc.ok && Array.isArray(lc.body) ? (lc.body as Array<{ commit?: { author?: { date?: string } } }>)[0] : undefined;
    const when = row?.commit?.author?.date ?? null;
    if (when) {
      checked.push(`the last commit on ${repo} was ${when}`);
      if (!lastSeen) lastSeen = when;
      source = source === 'none' ? 'github' : source;
    } else {
      couldNot.push(`the last commit on ${repo} could not be read`);
    }
  }
  if (source === 'none') {
    return {
      source: 'none',
      summary: 'The GitHub connector was reachable but every check it allows came back empty.',
      detail: { checked, couldNot },
      briefing: {
        checked: ['the clock itself: no check-in arrived inside the deadline'],
        couldNotVerify: couldNot,
        suggest: [
          'try to reach them on a channel a machine cannot see: a call, a door, a person',
          'do not assume the worst from silence alone',
        ],
      },
      narrative: '',
    };
  }
  const silentHours = lastSeen ? Math.round((Date.now() - Date.parse(lastSeen)) / 3_600_000) : null;

  const briefing: Briefing = {
    checked: [`the clock: ${will.policy.deadlineMinutes} minutes of silence past the deadline`, ...checked],
    couldNotVerify: [
      'anything private or offline: messages, calls, travel, hospital',
      lastSeen ? `the last public sign of life was ${lastSeen} (${silentHours}h ago)` : 'no public activity could be timestamped',
      ...couldNot,
    ],
    suggest: [
      'contact them directly on a channel they would actually answer',
      'if you believe they are safe, say so here and the clock stands down',
      'if you do not know, say nothing: silence is an answer, and it is recorded as one',
    ],
  };

  const facts = [
    `owner: ${will.owner.name} (@${will.owner.github})`,
    `silence: past the ${will.policy.deadlineMinutes}-minute deadline`,
    `public events visible: ${events.length}`,
    `most recent public activity: ${lastSeen ?? 'unknown'}`,
  ].join('\n');

  const narrative = await writeBriefing(mind, facts);

  return {
    source,
    summary:
      events.length === 0
        ? 'No public activity at all was found on the account.'
        : `${events.length} public event(s) visible; most recent ${lastSeen ?? 'unknown'}.`,
    detail: { count: events.length, lastSeen },
    briefing,
    narrative,
  };
}

/**
 * The model's real job: turn the facts the executor could establish into a briefing a
 * witness can act on. Strictly bounded — it may not invent facts, and if no model is
 * reachable the deterministic briefing above is what gets sent.
 */
async function writeBriefing(mind: MindContext, facts: string): Promise<string> {
  if (mind.provider === 'none') return '';
  const connector = mind.connectors.find((c) => c.provider.includes('ollama') || c.provider.includes('openrouter'));
  if (!connector) return '';
  const res = await llmChat(
    connector.id,
    mind.model,
    [
      {
        role: 'system',
        content:
          'You brief a person who has just been told their friend may be gone. Use ONLY the facts given. ' +
          'Three short sentences, plain, no eulogy, no guessing, no advice to panic. Say what was checked, ' +
          'what could not be checked, and what they might do that a machine cannot.',
      },
      { role: 'user', content: facts },
    ],
    connector.usageSnippet,
  );
  return res.ok ? (extractText(res.body) ?? '') : '';
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
