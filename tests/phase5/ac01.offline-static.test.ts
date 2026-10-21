/*
 * ============================================================================
 * PHASE 5 — offline guarantees that can be checked statically (brief §9 AC-01 "The installed
 * application opens and performs all core workflows without internet", §6 "All core operations work
 * without internet access", §9 Privacy "no external transmission", §12 excludes internet-dependent
 * analytics; CLAUDE.md "Offline only: no network calls, CDNs, remote fonts or telemetry").
 *
 * The runtime side (networking blocked at launch, no requests observed, the Electron session refusing
 * remote requests) is covered by tests/phase5/e2e/app.e2e.spec.ts. Here:
 *   - every HTML page under src/renderer (organizer and display) has a Content-Security-Policy meta
 *     whose default-src is 'self' or 'none' and which names no remote origin (no http:, https:, ws:,
 *     wss:, *, or host names), and loads no remote script/style/font/image;
 *   - application source under src/ has no URL with a host (http(s)://host, ws(s)://host, //cdn…),
 *     no Node networking modules (http, https, http2, net, tls, dgram), no XMLHttpRequest, WebSocket,
 *     EventSource or sendBeacon, and no auto-updater.
 * ============================================================================
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = process.cwd();

function walk(dir: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, re));
    else if (re.test(name)) out.push(full);
  }
  return out;
}

/** Remove // line comments and block comments (good enough for a lint-style scan). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

describe('AC-01 offline: renderer pages carry a strict local-only CSP', () => {
  const pages = walk(resolve(root, 'src/renderer'), /\.html$/);

  it('there is at least one renderer page', () => {
    expect(pages.length).toBeGreaterThan(0);
  });

  it('every page declares a CSP limited to the app itself', () => {
    for (const page of pages) {
      const html = readFileSync(page, 'utf8');
      const meta = /<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*content=(?:"([^"]+)"|'([^']+)')/i.exec(html);
      expect(meta, `${relative(root, page)} has no CSP meta`).not.toBeNull();
      const csp = meta?.[1] ?? meta?.[2] ?? '';
      expect(csp, relative(root, page)).toMatch(/default-src\s+('self'|'none')/);
      for (const directive of csp.split(';')) {
        const sources = directive.trim().split(/\s+/).slice(1);
        for (const source of sources) {
          expect(
            /^('self'|'none'|'unsafe-inline'|'unsafe-eval'|'strict-dynamic'|'nonce-[^']+'|'sha(256|384|512)-[^']+'|data:|blob:|file:)$/.test(source),
            `${relative(root, page)}: CSP source ${source} in "${directive.trim()}" allows a remote origin`,
          ).toBe(true);
        }
      }
    }
  });

  it('no page loads remote scripts, styles, fonts or images', () => {
    for (const page of pages) {
      const html = readFileSync(page, 'utf8');
      expect(html, relative(root, page)).not.toMatch(/(src|href)\s*=\s*["']\s*(https?:|wss?:)?\/\//i);
    }
  });
});

describe('AC-01 offline: application source makes no network calls', () => {
  const files = walk(resolve(root, 'src'), /\.(ts|tsx|js|mjs|cjs|css|html)$/);

  it('scans the application source', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('contains no remote URLs (CDNs, remote fonts, telemetry endpoints)', () => {
    for (const f of files) {
      const src = stripComments(readFileSync(f, 'utf8'));
      expect(src, `${relative(root, f)} references a remote URL`).not.toMatch(/\b(https?|wss?|ftp):\/\/[a-z0-9[]/i);
      expect(src, `${relative(root, f)} imports a remote stylesheet/font`).not.toMatch(/@import\s+url\(\s*["']?\/\//i);
    }
  });

  it('uses no networking modules or browser networking APIs', () => {
    const banned: Array<[RegExp, string]> = [
      [/from\s+['"](node:)?(http|https|http2|net|tls|dgram)['"]/, 'Node networking module'],
      [/require\(\s*['"](node:)?(http|https|http2|net|tls|dgram)['"]\s*\)/, 'Node networking module'],
      [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
      [/\bnew\s+WebSocket\b/, 'WebSocket'],
      [/\bnew\s+EventSource\b/, 'EventSource'],
      [/\bsendBeacon\b/, 'navigator.sendBeacon'],
      [/electron-updater|\bautoUpdater\b/, 'auto-updater'],
      [/\bnet\.request\(/, 'electron net.request'],
    ];
    for (const f of files) {
      const src = stripComments(readFileSync(f, 'utf8'));
      for (const [re, what] of banned) expect(re.test(src), `${relative(root, f)} uses ${what}`).toBe(false);
    }
  });
});
