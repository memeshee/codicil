// src/pages/home.ts - GET /. Phase, streak, countdown, and the HOW-I-WAKE box.

import type { ExecRecord, StateSnapshot, Will } from '../types.ts';
import { escapeHtml, shell } from './layout.ts';

export interface HomeView {
  snapshot: StateSnapshot;
  will: Will | null;
  msToNextBoundary: number | null;
  lastTickAgeSeconds: number | null;
  demo: boolean;
  wakeSources: string[];
  /** Populated only when phase is EXECUTED: the owner's return page. */
  receipts?: ExecRecord[];
  /** Demo instances open the spectator door. */
  canTry?: boolean;
  revokedAt?: string | null;
}

const PHASE_COPY: Record<StateSnapshot['phase'], string> = {
  DORMANT: 'No will yet. Nothing is being watched.',
  ARMED: 'Armed. The clock runs from your last check-in.',
  CONCERNED: 'You have missed your deadline. The nudge has gone out.',
  PLEADING: 'Still silent. Your witnesses have been written to.',
  EXECUTING: 'Carrying out your instructions now.',
  EXECUTED: 'Done. Everything below is receipts.',
  REVOKED: 'You withdrew consent. Nothing will execute until you sign a new version.',
};


const RAIL: Array<{ phase: StateSnapshot['phase']; note: string }> = [
  { phase: 'DORMANT', note: 'nothing is being watched' },
  { phase: 'ARMED', note: 'the clock runs from your last check-in' },
  { phase: 'CONCERNED', note: 'deadline missed, the nudge goes out' },
  { phase: 'PLEADING', note: 'witnesses are told, with a briefing' },
  { phase: 'EXECUTING', note: 'instructions run, in order, bounded retries' },
  { phase: 'EXECUTED', note: 'receipts, and the board keeps them' },
];

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
      ? '<p class="big">-</p>'
      : `<p class="big" data-ms="${v.msToNextBoundary}" id="countdown">${humanMs(v.msToNextBoundary)}</p>`;
  const tickAge =
    v.lastTickAgeSeconds === null ? 'never since boot' : `${Math.round(v.lastTickAgeSeconds / 60)} min ago`;
  const owner = will ? `${escapeHtml(will.owner.name)} (@${escapeHtml(will.owner.github)})` : 'unset';

  const returnPage =
    s.phase === 'EXECUTED' && v.receipts && v.receipts.length
      ? `<section class="card wake" style="border-left-color:#9a3412">
  <p class="kicker">you came back</p>
  <h1>You were gone, so I kept your word.</h1>
  <p>On ${escapeHtml(v.receipts.find((r) => r.executedAt)?.executedAt ?? s.lastCheckIn)} I carried out your instructions.
  Everything I did is below, with its receipt. Nothing is undone by your returning - that was the point.</p>
  <ul class="plain">
    ${v.receipts
      .map(
        (r) =>
          `<li><b>${escapeHtml(r.kind)}</b> - ${escapeHtml(r.status)}${
            r.resultRef ? ` / <a href="${escapeHtml(r.resultRef)}" rel="noopener">receipt</a>` : ''
          }</li>`,
      )
      .join('')}
  </ul>
  <p class="muted small">To arm again, sign a new version of the will: <a href="/will">the will</a>.
  The next version starts at ARMED with your new deadline.</p>
</section>`
      : '';

  const revoked = s.phase === 'REVOKED'
    ? `<section class="card wake">
  <p class="kicker">revoked ${escapeHtml(v.revokedAt ?? '')}</p>
  <h1>Nothing will be carried out.</h1>
  <p>You withdrew the will. The revocation is on the board, the clock is stopped, and an
  execution that was already running would have finished - which is why the revocation is
  recorded with its timestamp rather than erasing anything.</p>
  <p class="muted small">Signing a new version re-arms from scratch.</p>
</section>`
    : '';

  const tryCard = v.canTry
    ? `<section class="card wake">
  <p class="kicker">start here</p>
  <h1>How to use this demo.</h1>
  <p>Everything on this page is real: the same code that would run on a Sprite, with the clock
  compressed so you can watch a whole custody cycle in about a minute. Every row it writes is
  labelled <code>DEMO</code>.</p>
  <ol class="ops">
    <li><b>Sign a throwaway will.</b> One click, prefilled, no token and no account.</li>
    <li><b>Watch the phase</b> at the top of this page. It moves on its own:
      ARMED → CONCERNED (deadline missed, a nudge goes out) → PLEADING (the witnesses are written to)
      → EXECUTING → EXECUTED.</li>
    <li><b>Every reload is a wake.</b> A Sprite has no clock, so each request is what makes time pass
      here. Refreshing the page genuinely advances the ladder - the demo is not a recording.</li>
    <li><b>Read what it did</b> on the <a href="/ledger">notice board</a>, then check the chain
      yourself on <a href="/verify">/verify</a>: your browser recomputes every hash.</li>
    <li><b>Answer as a witness.</b> Signing gives you private witness links - open one and try
      "I know they are safe" and "I don't know". Both are recorded; only the first stands the clock down.</li>
    <li><b>Reset it</b> with the owner token, printed on /try after you sign. Pasting it into the
      check-in box on this page returns the ladder to ARMED.</li>
  </ol>
  <p><a class="cta" href="/try?name=a%20visitor&amp;letter=I%20left%20the%20fig%20tree%20to%20Ada.&amp;witnesses=Ada">Watch a will run</a></p>
  <p class="muted small">If nothing loads for a few seconds, the machine is asleep and waking -
  this instance scales to zero between visitors. It answers on its own.</p>
</section>`
    : '';

  const railIndex = RAIL.findIndex((r) => r.phase === s.phase);
  const rail = RAIL.map((r, i) =>
    `<li class="${i === railIndex ? 'now' : i < railIndex ? 'done' : ''}"><span class="phase">${r.phase}</span><span class="note">${r.note}</span></li>`,
  ).join('');

  const body = `
${returnPage}${revoked}
<section class="hero">
  <p class="kicker">current phase</p>
  <h1>${s.phase}</h1>
  <p class="phase-copy">${escapeHtml(PHASE_COPY[s.phase])}</p>
  ${countdown}
  <div class="statusbar">
    <span>phase <b>${s.phase}</b></span>
    <span>will version ${s.willVersion}</span>
    <span>owner ${owner}</span>
    ${v.demo ? '<span class=\'seal\'>demo instance</span>' : ''}
  </div>
</section>

<section>
  <h2>${s.streakDays} day${s.streakDays === 1 ? '' : 's'} of answering</h2>
  <p class="muted">Last check-in ${escapeHtml(s.lastCheckIn)}.</p>
  <form method="post" action="/api/checkin" class="checkin">
    <label for="tok" class="small">owner token</label>
    <input id="tok" name="token" type="password" autocomplete="current-password" required placeholder="paste your token">
    <button type="submit">I am here</button>
  </form>
  <p class="small muted">A check-in is the only thing that resets the clock, apart from a witness vouch.</p>
  <aside class="aside">
    deadline ${will ? will.policy.deadlineMinutes : '-'} min<br>
    nudge grace ${will ? will.policy.nudgeGraceMinutes : '-'} min<br>
    plead grace ${will ? will.policy.pleadGraceMinutes : '-'} min
  </aside>
</section>

<section>
  <h2>Six phases, and only two things move you back</h2>
  <p class="muted">Your check-in, or a witness quorum. Nothing else resets this clock, including
  anything the executor discovers.</p>
  <ol class="rail">${rail}</ol>
</section>

<section>
  <h2>A Sprite has no clock of its own</h2>
  <p>It pauses about thirty seconds after activity stops, and runs again only when a request
  arrives. So this executor does not watch anything by magic. It is woken by:</p>
  <ul class="plain">
    ${v.wakeSources.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}
  </ul>
  <figure>
    <img src="/trust-wake.svg" alt="Two paths: the trust path, where credentials stay at the connector gateway, and the wake path, which names every source of time.">
    <figcaption>The two paths that matter. Every outward call crosses the gateway, which holds the
    credential. Every way time can pass is named, because the platform does not provide a scheduler.</figcaption>
  </figure>
  <p class="small muted">Last wake ${escapeHtml(tickAge)}, last tick recorded ${s.lastTickAt ? escapeHtml(s.lastTickAt) : 'never'}.
  If both pingers fail, the deadline slips. That is a real limitation, printed here rather than hidden.</p>
</section>
${tryCard}

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

  return shell({ title: 'Codicil - an executor that holds no key', active: 'home', demo: v.demo }, body);
}

export { humanMs };
