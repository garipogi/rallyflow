// Builds site/privacy.html and site/terms.html from PRIVACY.md and EULA.md so the website and the
// shipped documents never drift apart. Handles the small Markdown subset those files use
// (headings, paragraphs, bullet lists, **bold**, `code`). Usage: node scripts/build-site-legal.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');

function toHtml(md) {
  const out = [];
  let para = [];
  let list = null;
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
    if (list) out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
    list = null;
  };
  for (const line of md.split(/\r?\n/)) {
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    } else if (/^\s*-\s+/.test(line)) {
      if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
      (list ??= []).push(line.replace(/^\s*-\s+/, ''));
    } else if (/^\s+\S/.test(line) && list) {
      list[list.length - 1] += ` ${line.trim()}`;
    } else if (line.trim() === '') {
      flush();
    } else {
      if (list) flush();
      para.push(line.trim());
    }
  }
  flush();
  return out.join('\n');
}

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'self'; form-action 'none'" />
  <title>${title} — RallyFlow</title>
  <link rel="icon" type="image/svg+xml" href="assets/icon.svg" />
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <header class="topbar">
    <div class="wrap">
      <a class="topbar-brand" href="index.html"><img src="assets/icon.svg" alt="" width="36" height="36" /><span class="topbar-word">Rally<span>Flow</span></span></a>
      <nav class="topnav" aria-label="Main"><a href="index.html">Home</a><a href="privacy.html">Privacy</a><a href="terms.html">Terms</a></nav>
    </div>
  </header>
  <main class="wrap legal">
${body}
  </main>
  <footer><div class="wrap"><span>© 2026 RallyFlow</span><nav aria-label="Legal"><a href="privacy.html">Privacy</a><a href="terms.html">Terms (EULA)</a><a href="index.html">Home</a></nav></div></footer>
</body>
</html>
`;
}

for (const [src, out, title] of [['PRIVACY.md', 'privacy.html', 'Privacy Policy'], ['EULA.md', 'terms.html', 'End-User Licence Agreement']]) {
  writeFileSync(join(root, 'site', out), page(title, toHtml(readFileSync(join(root, src), 'utf8'))));
  console.log(`wrote site/${out}`);
}
