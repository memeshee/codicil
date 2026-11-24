// src/pages/layout.ts — the shared shell. ADDITIVE (not a frozen interface): it exists so
// the five pages share one document skeleton and one stylesheet. Stamped in executor-plan.md.

export interface ShellOpts {
  title: string;
  active?: 'home' | 'will' | 'ledger' | 'proof';
  demo?: boolean;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function shell(opts: ShellOpts, body: string): string {
  const nav = [
    ['/', 'home', 'home'],
    ['/will', 'will', 'the will'],
    ['/ledger', 'ledger', 'notice board'],
    ['/proof', 'proof', 'no keys'],
  ]
    .map(([href, key, label]) => `<a href="${href}"${opts.active === key ? ' class="on"' : ''}>${label}</a>`)
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header>
  <a class="mark" href="/"><span class="candle" aria-hidden="true"></span> Codicil</a>
  <nav>${nav}</nav>
</header>
<main>
${body}
</main>
<footer>
  <p>An executor that holds no key. Runs on a Fly.io Sprite; every credential stays at the gateway.</p>
  ${opts.demo ? '<p class="demo-flag">DEMO configuration — shortened graces. Rows are labelled.</p>' : ''}
</footer>
</body>
</html>`;
}
