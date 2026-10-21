/*
 * ============================================================================
 * PHASE 5 — release configuration (brief §9 AC-20 "Core workflows pass on supported Windows and
 * macOS versions", §10 "Package and test both platforms independently", docs/STACK.md packaging +
 * CI rows, docs/DECISIONS.md D12 supported OS versions, D13 unsigned builds).
 *
 * AC-20 is only fully met when the CI matrix is green on GitHub (external gate, confirmed by the
 * organizer). These static checks pin what must be in the repo for that to be possible.
 *
 * Required files (repo root):
 *   .github/workflows/ci.yml
 *     - triggers on push and pull_request
 *     - a job whose `runs-on` is `${{ matrix.os }}` with a matrix `os` list containing exactly the two
 *       supported runners windows-latest and macos-latest, `fail-fast: false`
 *     - actions/checkout and actions/setup-node with node-version >= 20
 *     - runs, in this order: `npm ci`, typecheck (`npm run [-s] typecheck`), the unit suite
 *       (`npx vitest run` or `npm test` / `npm run [-s] test`), `npm run [-s] build`, `npm run [-s] e2e`
 *     - no `continue-on-error: true` (a red step must turn the job red)
 *     - uploads the e2e screenshots in test-results/ as an artifact (actions/upload-artifact)
 *   electron-builder.yml
 *     - appId and productName
 *     - win target nsis, mac target dmg
 *     - no remote auto-update publishing (`publish: null` or no publish key) — the app is offline
 *   package.json
 *     - scripts.e2e (builds, then runs Playwright against tests/phase5/e2e)
 *     - devDependency @playwright/test
 *     - no electron-updater dependency (no network at runtime)
 *   docs/INSTALL.md   Windows (NSIS installer) and macOS (DMG) install steps, supported versions per D12
 *                     (Windows 10 22H2+/11, macOS 13 Ventura+), and the unsigned-build warning per D13
 *   docs/USER_GUIDE.md   organizer guide covering sessions, players/check-in, courts and the queue,
 *                     scoring + undo, the timer, the display window, reports/export and backup/restore,
 *                     and offline operation
 * ============================================================================
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const read = (rel: string): string => {
  const p = resolve(root, rel);
  if (!existsSync(p)) throw new Error(`Missing required file ${rel}`);
  return readFileSync(p, 'utf8');
};

/** Drop YAML comments so commented-out lines can't satisfy a check. */
const stripYamlComments = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n');

/** The `run:` commands of all steps, in file order (single-line and block `run: |` forms). */
function runCommands(yaml: string): string[] {
  const lines = yaml.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(line);
    if (!m) continue;
    const indent = (m[1] ?? '').length;
    const rest = (m[2] ?? '').trim();
    if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-' || rest === '') {
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j] ?? '';
        if (next.trim() === '') continue;
        const nextIndent = next.length - next.trimStart().length;
        if (nextIndent <= indent) break;
        out.push(next.trim());
        i = j;
      }
    } else {
      out.push(rest);
    }
  }
  return out;
}

describe('AC-20 CI matrix: .github/workflows/ci.yml', () => {
  const ci = (): string => stripYamlComments(read('.github/workflows/ci.yml'));

  it('runs on push and pull_request', () => {
    const y = ci();
    expect(y).toMatch(/^on:/m);
    expect(y).toMatch(/\bpush\b/);
    expect(y).toMatch(/\bpull_request\b/);
  });

  it('has an OS matrix of windows-latest and macos-latest, and the job runs on it', () => {
    const y = ci();
    expect(y).toMatch(/runs-on:\s*\$\{\{\s*matrix\.os\s*\}\}/);
    const inline = /^\s*os:\s*\[([^\]]*)\]/m.exec(y);
    let oses: string[];
    if (inline) {
      oses = (inline[1] ?? '').split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
    } else {
      const block = /^([ \t]*)os:[ \t]*\n((?:\1[ \t]*-[ \t]*.+\n?)+)/m.exec(y);
      expect(block, 'matrix.os list not found').not.toBeNull();
      oses = (block?.[2] ?? '')
        .split('\n')
        .map((l) => l.trim().replace(/^-\s*/, '').replace(/^['"]|['"]$/g, ''))
        .filter((l) => l !== '');
    }
    expect([...oses].sort()).toEqual(['macos-latest', 'windows-latest']);
  });

  it('does not stop the other platform when one fails, and never hides failures', () => {
    const y = ci();
    expect(y).toMatch(/fail-fast:\s*false/);
    expect(y).not.toMatch(/continue-on-error:\s*true/);
  });

  it('checks out and sets up Node 20 or newer', () => {
    const y = ci();
    expect(y).toMatch(/uses:\s*actions\/checkout@/);
    expect(y).toMatch(/uses:\s*actions\/setup-node@/);
    const node = /node-version:\s*['"]?(\d+)/.exec(y);
    expect(node, 'node-version not set').not.toBeNull();
    expect(Number(node?.[1])).toBeGreaterThanOrEqual(20);
  });

  it('runs npm ci, typecheck, the unit suite, build and e2e — in that order', () => {
    const cmds = runCommands(ci());
    const indexOf = (re: RegExp): number => cmds.findIndex((c) => re.test(c));
    const install = indexOf(/^npm ci\b/);
    const typecheck = indexOf(/^npm run (-s )?typecheck\b/);
    const unit = indexOf(/^(npx vitest run\b|npm test\b|npm run (-s )?test\b)/);
    const build = indexOf(/^npm run (-s )?build\b/);
    const e2e = indexOf(/^npm run (-s )?e2e\b/);
    expect({ install, typecheck, unit, build, e2e }).toEqual({
      install: expect.any(Number),
      typecheck: expect.any(Number),
      unit: expect.any(Number),
      build: expect.any(Number),
      e2e: expect.any(Number),
    });
    for (const [name, i] of Object.entries({ install, typecheck, unit, build, e2e })) {
      expect(i, `${name} step missing; run steps: ${JSON.stringify(cmds)}`).toBeGreaterThanOrEqual(0);
    }
    expect(install).toBeLessThan(typecheck);
    expect(typecheck).toBeLessThan(unit);
    expect(unit).toBeLessThan(build);
    expect(build).toBeLessThan(e2e);
  });

  it('uploads the e2e screenshots from test-results/', () => {
    const y = ci();
    expect(y).toMatch(/uses:\s*actions\/upload-artifact@/);
    expect(y).toMatch(/test-results/);
  });
});

/** A top-level YAML key's value: the rest of its line plus its indented block. */
function section(yaml: string, key: string): string | null {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
  if (start < 0) return null;
  const body = [(lines[start] ?? '').slice(key.length + 1)];
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i] ?? '';
    if (l.trim() !== '' && !/^[ \t]/.test(l)) break;
    body.push(l);
  }
  return body.join('\n');
}

describe('AC-20 packaging: electron-builder.yml', () => {
  const eb = (): string => stripYamlComments(read('electron-builder.yml'));

  it('names the app', () => {
    const y = eb();
    expect(y).toMatch(/^appId:\s*\S+/m);
    expect(y).toMatch(/^productName:\s*\S+/m);
  });

  it('targets NSIS on Windows', () => {
    const y = eb();
    const win = section(y, 'win');
    expect(win, 'win: section missing').not.toBeNull();
    expect(win ?? '').toMatch(/\bnsis\b/);
  });

  it('targets DMG on macOS', () => {
    const y = eb();
    const mac = section(y, 'mac');
    expect(mac, 'mac: section missing').not.toBeNull();
    expect(mac ?? '').toMatch(/\bdmg\b/);
  });

  it('does not publish to a remote update server (offline app)', () => {
    const y = eb();
    const publish = /^publish:\s*(.*)$/m.exec(y);
    if (publish) expect((publish[1] ?? '').trim()).toMatch(/^(null|~|never)$/);
    expect(y).not.toMatch(/provider:\s*(github|s3|spaces|generic|bitbucket|keygen|snapStore)/);
  });
});

describe('AC-20 package.json release scripts', () => {
  const pkg = (): {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } => JSON.parse(read('package.json')) as never;

  it('has an e2e script and Playwright as a dev dependency', () => {
    const p = pkg();
    expect(p.scripts?.e2e, 'scripts.e2e missing').toEqual(expect.any(String));
    expect(p.scripts?.e2e ?? '').toMatch(/playwright/);
    expect(Object.keys(p.devDependencies ?? {})).toContain('@playwright/test');
  });

  it('ships no auto-updater (no network at runtime)', () => {
    const p = pkg();
    const all = { ...(p.dependencies ?? {}), ...(p.devDependencies ?? {}) };
    expect(Object.keys(all)).not.toContain('electron-updater');
  });
});

describe('AC-20 install guide: docs/INSTALL.md', () => {
  it('covers Windows and macOS installers, supported versions (D12) and unsigned builds (D13)', () => {
    const doc = read('docs/INSTALL.md');
    expect(doc.length).toBeGreaterThan(800);
    expect(doc).toMatch(/Windows/);
    expect(doc).toMatch(/macOS/);
    expect(doc).toMatch(/NSIS|\.exe\b|installer/i);
    expect(doc).toMatch(/\.dmg\b|DMG/);
    expect(doc).toMatch(/Windows 10/);
    expect(doc).toMatch(/Windows 11/);
    expect(doc).toMatch(/macOS 13|Ventura/);
    expect(doc).toMatch(/unsigned|not (code[- ])?signed/i);
  });
});

describe('AC-01 user guide: docs/USER_GUIDE.md', () => {
  it('walks the organizer through every core workflow, offline', () => {
    const doc = read('docs/USER_GUIDE.md');
    expect(doc.length).toBeGreaterThan(2000);
    for (const topic of [/session/i, /check[- ]?in/i, /court/i, /queue/i, /undo/i, /timer/i, /display/i, /export/i, /backup/i, /restore/i, /offline|internet/i]) {
      expect(doc, `USER_GUIDE.md should cover ${String(topic)}`).toMatch(topic);
    }
  });
});
