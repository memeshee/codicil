// src/pages/home.ts — GET /. Phase, streak, countdown, and the HOW-I-WAKE box.

import type { StateSnapshot, Will } from '../types.ts';
import { escapeHtml, shell } from './layout.ts';

export interface HomeView {
  snapshot: StateSnapshot;
  will: Will | null;
  msToNextBoundary: number | null;
  lastTickAgeSeconds: number | null;
  demo: boolean;
  wakeSources: string[];
}

const PHASE_COPY: Record<StateSnapshot['phase'], string> = {
  DORMANT: 'No will yet. Nothing is being watched.',
  ARMED: 'Armed. The clock runs from your last check-in.',
  CONCERNED: 'You have missed your deadline. The nudge has gone out.',
  PLEADING: 'Still silent. Your witnesses have been written to.',
  EXECUTING: 'Carrying out your instructions now.',
  EXECUTED: 'Done. Everything below is receipts.',
};

function humanMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function renderHome(v: HomeView): string {
  const { snapshot: s, will } = v;
  const countdown =
    v.msToNextBoundary === null
      ? '<p class="big">—</p>'
      : `<p class="big" data-ms="${v.msToNextBoundary}" id="countdown">${humanMs(v.msToNextBoundary)}</p>`;
  const tickAge =
    v.lastTickAgeSeconds === null ? 'never since boot' : `${Math.round(v.lastTickAgeSeconds / 60)} min ago`;
  const owner = will ? `${escapeHtml(will.owner.name)} (@${escapeHtml(will.owner.github)})` : 'unset';

  const body = `
<section class="hero">
  <p class="kicker">phase</p>
  <h1>${s.phase}</h1>
  <p class="phase-copy">${escapeHtml(PHASE_COPY[s.phase])}</p>
</section>

<section class="grid">
  <div class="card">
    <p class="kicker">your streak</p>
    <p class="big">${s.streakDays} <span class="unit">day${s.streakDays === 1 ? '' : 's'}</span></p>
    <p class="muted">last check-in ${escapeHtml(s.lastCheckIn)}</p>
    <form method="post" action="/api/checkin" class="checkin">
      <label for="tok">owner token</label>
      <input id="tok" name="token" type="password" autocomplete="current-password" required placeholder="paste your token">
      <button type="submit">I'm here</button>
    </form>
    <p class="muted small">A check-in is the only thing that resets the clock apart from a witness vouch.</p>
  </div>

  <div class="card">
    <p class="kicker">next boundary</p>
    ${countdown}
    <p class="muted">phase ${s.phase} · will version ${s.willVersion} · owner ${owner}</p>
    <ul class="plain">
      <li>deadline ${will ? will.policy.deadlineMinutes : '—'} min</li>
      <li>nudge grace ${will ? will.policy.nudgeGraceMinutes : '—'} min</li>
      <li>plead grace ${will ? will.policy.pleadGraceMinutes : '—'} min</li>
    </ul>
  </div>
</section>

<section class="card wake">
  <p class="kicker">how i wake — stated plainly</p>
  <p>A Sprite sleeps. It has no clock of its own: it pauses about thirty seconds after
  activity stops, and runs again only when a request arrives. So this executor does not
  "watch" anything by magic. It is woken by:</p>
  <ul>
    ${v.wakeSources.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}
  </ul>
  <p class="muted">Last wake: ${escapeHtml(tickAge)} · last tick recorded ${s.lastTickAt ? escapeHtml(s.lastTickAt) : 'never'}.
  If both pingers fail, the deadline slips. That is a real limitation, printed here rather than hidden.</p>
</section>

<script>
(() => {
  const el = document.getElementById('countdown');
  if (!el) return;
  let ms = Number(el.dataset.ms || 0);
  const fmt = (t) => {
    const s = Math.max(0, Math.floor(t / 1000));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm ' + (s % 60) + 's';
    return s + 's';
  };
  setInterval(() => { ms = Math.max(0, ms - 1000); el.textContent = fmt(ms); }, 1000);
})();
</script>`;

  return shell({ title: 'Codicil — an executor that holds no key', active: 'home', demo: v.demo }, body);
}

export { humanMs };
