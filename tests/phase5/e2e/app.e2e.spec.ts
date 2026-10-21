/*
 * ============================================================================
 * PHASE 5 END-TO-END TESTS — Playwright driving the built Electron app.
 * AC-01 (offline startup + core workflow, no network requests), AC-18 (timer independent of scoring),
 * AC-19 (large-screen display reflects courts/scores/queue and has no organizer controls).
 * Vitest does not run this file (vitest.config.ts excludes tests/** /e2e/**). Playwright does.
 *
 * ---------------------------------------------------------------------------------------------
 * HARNESS CONTRACT (the builder provides this; the tests below rely on it)
 *
 *  - devDependency `@playwright/test`; `playwright.config.ts` at the repo root with
 *      testDir: 'tests/phase5/e2e', testMatch: '**' + '/*.spec.ts', workers: 1, fullyParallel: false,
 *      timeout >= 180_000, outputDir 'test-results' (default). No webServer, no browser projects needed.
 *  - npm script `e2e`: builds the app (`electron-vite build`, so out/main/index.js is current), makes
 *    better-sqlite3 loadable by Electron, then runs `playwright test`. `npm run -s e2e` must leave the
 *    screenshots written below in test-results/.
 *  - Launch: `_electron.launch({ args: ['<repo>/out/main/index.js', ...chromiumSwitches], env })`.
 *      env.PBOP_USER_DATA = a fresh temp directory per launch. The main process MUST call
 *      `app.setPath('userData', process.env.PBOP_USER_DATA)` before anything reads userData when the
 *      variable is set, so the SQLite database and auto-backups live there (portable data folder).
 *      Relaunching with the same PBOP_USER_DATA reopens the same data.
 *  - "Networking blocked" launches add the Chromium switches
 *      --host-resolver-rules=MAP * ~NOTFOUND   --proxy-server=http://127.0.0.1:9
 *    and HTTP(S)_PROXY=http://127.0.0.1:9 in env. The app must start and work normally like that.
 *  - The network-observation launch adds `--log-net-log=<tmp>/netlog.json` (a documented Electron
 *    switch); the Chromium net log must contain no http(s)/ws(s) URL after a short session.
 *  - Every BrowserWindow's session refuses remote requests: `webContents.session.fetch('https://…')`
 *    rejects (e.g. a webRequest.onBeforeRequest handler that cancels every non-local URL), and the
 *    renderer's own `fetch('https://…')` rejects (CSP + the same blocker).
 *
 * WINDOWS
 *  - At startup exactly one window opens: the organizer window, title contains "Pickleball Open Play"
 *    and does NOT contain "Display". `window.openPlay` (the OrganizerApi) is available in it.
 *  - The display window opens only when the organizer clicks the button named /open display/i
 *    (available inside an open session). Clicking it again focuses the existing display window instead
 *    of opening a second one. Its title contains "Display". It shows the session open in the organizer
 *    window. It has NO organizer API: `window.openPlay` is undefined there, and it contains no
 *    interactive controls at all (no button, input, select, textarea, a[href], [role=button],
 *    [contenteditable]); key presses in it change nothing. It updates by itself (no reload, no
 *    interaction) within 5 s of any change made in the organizer window.
 *
 * ORGANIZER SELECTORS (existing labels from phases 1–4 are kept)
 *  - Start screen: input label "Session name"; a <select> whose label matches /courts/i (2–4);
 *    button "Start session"; for unfinished sessions a button "Resume".
 *  - Session room: input label "Player name"; button "Add player"; per roster row a button
 *    "Check in" (disabled once checked in); per recommendation a button "Start this game";
 *    button "Finish session"; button /open display/i.
 *  - One element [data-testid="court-scoring"] per court that has a scheduled or in-progress game
 *    (none for finalized games), with attribute data-court-label="<court label>", containing:
 *      before scoring starts: a <select> labelled /first serving team/i with option values "A" and "B",
 *        and a button /start scoring/i;
 *      once scoring has started:
 *        buttons /team a wins rally/i and /team b wins rally/i — one click or one Enter/Space press
 *          records exactly one rally, no confirmation dialog, no navigation, each at least 44x44 px;
 *        button /undo/i (undo last scoring action); button /finalize game/i;
 *        [data-testid="score-A"] and [data-testid="score-B"]: the team scores as plain digits;
 *        [data-testid="called-score"]: GameState.calledScore (e.g. "0-0-2");
 *        timer controls: an input labelled /timer length/i in MINUTES (fractional values such as
 *          0.05 accepted), buttons /start timer/i, /pause timer/i, /resume timer/i, /reset timer/i,
 *          and [data-testid="timer"] with data-timer-status = src/core/timer TimerStatus
 *          ('idle' | 'running' | 'paused' | 'expired'). Expiry is only a signal to the organizer.
 *
 * DISPLAY SELECTORS
 *  - [data-testid="display-court"] per configured court, in court order, with data-court-label and
 *    data-court-status ('available' | 'unavailable' | 'in_use'); a court with a scheduled or
 *    in-progress game is 'in_use', shows its players' names, and contains [data-testid="score-A"] and
 *    [data-testid="score-B"]; once scoring has started it carries data-serving-team="A"|"B".
 *    A court without such a game contains no score-A / score-B element.
 *  - [data-testid="display-queue"] containing one [data-testid="display-queue-entry"] per waiting
 *    player in queue order (same order as OrganizerApi.getQueue); each entry's text includes the
 *    player's display name.
 *  - Court-side readability: the score digits' font-size is at least 15% of the window's innerHeight.
 * ============================================================================
 */
import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ApiResult } from '../../../src/shared/api';

const MAIN_ENTRY = resolve(process.cwd(), 'out/main/index.js');
const SHOTS = resolve(process.cwd(), 'test-results');
const OFFLINE_SWITCHES = ['--host-resolver-rules=MAP * ~NOTFOUND', '--proxy-server=http://127.0.0.1:9'];
const DEAD_PROXY = 'http://127.0.0.1:9';
const LIVE_UPDATE = { timeout: 5_000 };

const PLAYERS = ['Ana Reyes', 'Ben Cruz', 'Cora Lim', 'Dan Uy', 'Eva Tan', 'Finn Go'];

interface Launched {
  app: ElectronApplication;
  organizer: Page;
  userData: string;
}

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

async function launch(opts: { offline: boolean; userData?: string; extraArgs?: string[] }): Promise<Launched> {
  expect(existsSync(MAIN_ENTRY), `${MAIN_ENTRY} missing — the e2e script must build first`).toBe(true);
  const userData = opts.userData ?? mkdtempSync(join(tmpdir(), 'pbop-e2e-'));
  const env = baseEnv();
  env.PBOP_USER_DATA = userData;
  if (opts.offline) {
    env.HTTP_PROXY = DEAD_PROXY;
    env.HTTPS_PROXY = DEAD_PROXY;
    env.http_proxy = DEAD_PROXY;
    env.https_proxy = DEAD_PROXY;
    env.NO_PROXY = '';
    env.no_proxy = '';
  }
  const args = [MAIN_ENTRY, ...(opts.offline ? OFFLINE_SWITCHES : []), ...(opts.extraArgs ?? [])];
  const app = await electron.launch({ args, env });
  const organizer = await app.firstWindow();
  await organizer.waitForLoadState('domcontentloaded');
  await organizer.waitForFunction(() => typeof window.openPlay === 'object' && window.openPlay !== null);
  await expect(organizer).toHaveTitle(/Pickleball Open Play/);
  return { app, organizer, userData };
}

async function shutdown(l: Launched, removeData = true): Promise<void> {
  await l.app.close();
  if (removeData) rmSync(l.userData, { recursive: true, force: true });
}

async function screenshot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, name) });
}

/** Creates a session, adds and checks in players through the organizer API. Returns the session id. */
async function seedSession(page: Page, name: string, courtCount: number, players: string[]): Promise<string> {
  return page.evaluate(
    async ({ name, courtCount, players }) => {
      const unwrap = <T>(r: ApiResult<T>): T => {
        if (!r.ok) throw new Error(r.error);
        return r.value;
      };
      const session = unwrap(await window.openPlay.createSession({ name, courtCount }));
      for (const displayName of players) {
        const entry = unwrap(await window.openPlay.addNewPlayer(session.id, { displayName }));
        unwrap(await window.openPlay.checkInPlayer(session.id, entry.playerId));
      }
      return session.id;
    },
    { name, courtCount, players },
  );
}

async function sessionState(page: Page, sessionId: string) {
  return page.evaluate(async (id) => {
    const r = await window.openPlay.loadSessionState(id);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  }, sessionId);
}

async function queueNames(page: Page, sessionId: string): Promise<string[]> {
  return page.evaluate(async (id) => {
    const r = await window.openPlay.getQueue(id);
    if (!r.ok) throw new Error(r.error);
    return r.value.map((e) => e.displayName);
  }, sessionId);
}

async function scoreEventCount(page: Page, gameId: string): Promise<number> {
  return page.evaluate(async (id) => {
    const r = await window.openPlay.loadScoreLog(id);
    if (!r.ok) throw new Error(r.error);
    return r.value.events.length;
  }, gameId);
}

/** Reloads the organizer UI (to pick up API-seeded data) and resumes the unfinished session. */
async function resumeInUi(page: Page): Promise<void> {
  await page.reload();
  await page.waitForFunction(() => typeof window.openPlay === 'object' && window.openPlay !== null);
  await page.getByRole('button', { name: 'Resume' }).first().click();
  await expect(page.getByRole('button', { name: 'Finish session' })).toBeVisible();
}

async function startRecommendedGame(page: Page): Promise<Locator> {
  await expect(page.getByTestId('court-scoring')).toHaveCount(0);
  await page.getByRole('button', { name: 'Start this game' }).first().click();
  const court = page.getByTestId('court-scoring');
  await expect(court).toHaveCount(1);
  return court.first();
}

async function startScoring(court: Locator): Promise<void> {
  await court.getByLabel(/first serving team/i).selectOption('A');
  await court.getByRole('button', { name: /start scoring/i }).click();
  await expect(court.getByTestId('called-score')).toHaveText('0-0-2');
  await expect(court.getByTestId('score-A')).toHaveText('0');
  await expect(court.getByTestId('score-B')).toHaveText('0');
}

async function rallies(court: Locator, team: 'A' | 'B', count: number): Promise<void> {
  const button = court.getByRole('button', { name: team === 'A' ? /team a wins rally/i : /team b wins rally/i });
  for (let i = 0; i < count; i += 1) await button.click();
}

async function openDisplay(app: ElectronApplication, organizer: Page): Promise<Page> {
  const [display] = await Promise.all([
    app.waitForEvent('window'),
    organizer.getByRole('button', { name: /open display/i }).click(),
  ]);
  await display.waitForLoadState('domcontentloaded');
  await expect(display).toHaveTitle(/display/i);
  return display;
}

const isLocalUrl = (url: string): boolean => /^(file|data|blob|devtools|chrome|chrome-extension|about):/i.test(url);

async function sessionFetchResult(app: ElectronApplication, url: string): Promise<string[]> {
  return app.evaluate(async ({ BrowserWindow }, target) => {
    const results: string[] = [];
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        const res = await w.webContents.session.fetch(target);
        results.push(`reached ${res.status}`);
      } catch {
        results.push('blocked');
      }
    }
    return results;
  }, url);
}

// ---------------------------------------------------------------------------------------------

test.describe('AC-01 offline startup: a full short session with networking blocked', () => {
  test('opens offline, runs a session end to end through the UI, and the data survives a restart', async () => {
    test.setTimeout(240_000);
    const first = await launch({ offline: true });
    const { app, organizer } = first;
    const dialogs: string[] = [];
    organizer.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });

    // Exactly one window at startup: the organizer window (the display opens only on request).
    expect(app.windows()).toHaveLength(1);
    await expect(organizer).not.toHaveTitle(/display/i);
    // Harness sanity: the network really is unreachable in this launch.
    expect(await sessionFetchResult(app, 'https://example.com/')).toEqual(['blocked']);

    // Workflow A: create a session with 2 courts.
    await organizer.getByLabel('Session name').fill('Thursday Open Play');
    await organizer.getByLabel(/courts/i).selectOption('2');
    await organizer.getByRole('button', { name: 'Start session' }).click();
    await expect(organizer.getByRole('button', { name: 'Finish session' })).toBeVisible();
    const sessionId = await organizer.evaluate(async () => {
      const r = await window.openPlay.listSessions();
      if (!r.ok) throw new Error(r.error);
      const s = r.value.find((x) => x.name === 'Thursday Open Play');
      if (!s) throw new Error('session not created');
      return s.id;
    });
    expect((await sessionState(organizer, sessionId)).courts).toHaveLength(2);

    // Add six players and check them all in through the UI.
    for (const name of PLAYERS) {
      await organizer.getByLabel('Player name').fill(name);
      await organizer.getByRole('button', { name: 'Add player', exact: true }).click();
      await expect(organizer.getByText(name, { exact: true }).first()).toBeVisible();
    }
    for (let i = 0; i < PLAYERS.length; i += 1) {
      const pending = organizer.getByRole('button', { name: 'Check in', exact: true }).and(organizer.locator(':enabled'));
      await pending.first().click();
      await expect(pending).toHaveCount(PLAYERS.length - i - 1);
    }
    const seeded = await sessionState(organizer, sessionId);
    expect(seeded.roster).toHaveLength(6);
    expect(seeded.roster.every((r) => r.checkedInAt !== null)).toBe(true);
    expect(await queueNames(organizer, sessionId)).toHaveLength(6);

    // Workflow B/C: confirm the recommended game and score it without leaving the court.
    const court = await startRecommendedGame(organizer);
    await startScoring(court);
    const urlBefore = organizer.url();
    const rallyA = court.getByRole('button', { name: /team a wins rally/i });
    const rallyB = court.getByRole('button', { name: /team b wins rally/i });
    for (const button of [rallyA, rallyB]) {
      const box = await button.boundingBox();
      expect(box, 'rally button not rendered').not.toBeNull();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    // One click = one rally (serving team A scores each time).
    for (let i = 1; i <= 4; i += 1) {
      await rallyA.click();
      await expect(court.getByTestId('score-A')).toHaveText(String(i));
    }
    await expect(court.getByTestId('called-score')).toHaveText('4-0-2');
    // Undo restores the previous score.
    await court.getByRole('button', { name: /undo/i }).click();
    await expect(court.getByTestId('score-A')).toHaveText('3');
    await expect(court.getByTestId('called-score')).toHaveText('3-0-2');
    // Keyboard drives score entry: one keypress = one rally.
    await rallyA.focus();
    await organizer.keyboard.press('Enter');
    await expect(court.getByTestId('score-A')).toHaveText('4');
    await rallyA.focus();
    await organizer.keyboard.press('Space');
    await expect(court.getByTestId('score-A')).toHaveText('5');
    await rallies(court, 'A', 6);
    await expect(court.getByTestId('score-A')).toHaveText('11');
    await expect(court.getByTestId('score-B')).toHaveText('0');
    expect(organizer.url()).toBe(urlBefore);
    expect(dialogs).toEqual([]);
    await screenshot(organizer, 'phase5-organizer-scoring.png');

    // Confirm the final result and complete the game.
    await court.getByRole('button', { name: /finalize game/i }).click();
    await expect(organizer.getByTestId('court-scoring')).toHaveCount(0);
    const afterGame = await sessionState(organizer, sessionId);
    expect(afterGame.games).toHaveLength(1);
    const game = afterGame.games[0];
    expect(game?.status).toBe('completed');
    expect(game?.teamAScore).toBe(11);
    expect(game?.teamBScore).toBe(0);
    expect(game?.winner).toBe('A');
    expect(game?.endedAt).not.toBeNull();
    expect(await queueNames(organizer, sessionId)).toHaveLength(6);
    const leaderboard = await organizer.evaluate(async (id) => window.openPlay.getSessionLeaderboard(id), sessionId);
    expect(leaderboard.ok).toBe(true);
    const rows = leaderboard.ok ? leaderboard.value : [];
    const played = rows.filter((r) => r.gamesPlayed === 1);
    expect(played).toHaveLength(4);
    expect(played.filter((r) => r.wins === 1 && r.pointsFor === 11)).toHaveLength(2);
    expect(played.filter((r) => r.losses === 1 && r.pointsAgainst === 11)).toHaveLength(2);

    // Workflow E: finish the session.
    await organizer.getByRole('button', { name: 'Finish session' }).click();
    await expect.poll(async () => (await sessionState(organizer, sessionId)).session.status).toBe('completed');
    await screenshot(organizer, 'phase5-organizer-finished.png');
    await shutdown(first, false);

    // Restart, still offline: the completed session and its game are still there.
    const second = await launch({ offline: true, userData: first.userData });
    try {
      const reopened = await sessionState(second.organizer, sessionId);
      expect(reopened.session.status).toBe('completed');
      expect(reopened.games.map((g) => [g.status, g.teamAScore, g.teamBScore])).toEqual([['completed', 11, 0]]);
      await expect(second.organizer.getByText('Thursday Open Play').first()).toBeVisible();
    } finally {
      await shutdown(second);
    }
  });
});

test.describe('AC-01 offline: the app makes no network requests', () => {
  test('a short session issues no remote request from any window or from Chromium', async () => {
    test.setTimeout(180_000);
    const logDir = mkdtempSync(join(tmpdir(), 'pbop-netlog-'));
    const netLog = join(logDir, 'netlog.json');
    // Not network-blocked on purpose: any request the app made would actually go out and be logged.
    const l = await launch({ offline: false, extraArgs: [`--log-net-log=${netLog}`] });
    const seen: string[] = [];
    try {
      const { app, organizer } = l;
      organizer.on('request', (r) => seen.push(r.url()));
      const sessionId = await seedSession(organizer, 'Network watch', 2, PLAYERS);
      await resumeInUi(organizer);
      // Positive control: the observer does see the app's own (local) loads.
      expect(seen.some((u) => u.startsWith('file:'))).toBe(true);

      const display = await openDisplay(app, organizer);
      display.on('request', (r) => seen.push(r.url()));
      await display.reload();
      await display.waitForLoadState('domcontentloaded');
      await expect(display.getByTestId('display-court')).toHaveCount(2, LIVE_UPDATE);

      const court = await startRecommendedGame(organizer);
      await startScoring(court);
      await rallies(court, 'A', 3);
      await rallies(court, 'B', 1);
      await expect(display.getByTestId('display-queue-entry')).toHaveCount(2, LIVE_UPDATE);
      expect((await sessionState(organizer, sessionId)).games).toHaveLength(1);

      const remote = seen.filter((u) => !isLocalUrl(u));
      expect(remote, `renderer requests: ${JSON.stringify(remote)}`).toEqual([]);
    } finally {
      await shutdown(l);
    }

    expect(existsSync(netLog), 'Chromium net log was not written (--log-net-log)').toBe(true);
    const text = readFileSync(netLog, 'utf8');
    const eventsAt = text.indexOf('"events"');
    expect(eventsAt, 'net log has no events section').toBeGreaterThanOrEqual(0);
    const remoteInLog = [...new Set([...text.slice(eventsAt).matchAll(/"((?:https?|wss?|ftp):\/\/[^"]*)"/gi)].map((m) => m[1] ?? ''))];
    expect(remoteInLog, `Chromium network activity: ${JSON.stringify(remoteInLog.slice(0, 10))}`).toEqual([]);
    rmSync(logDir, { recursive: true, force: true });
  });

  test('every window session and renderer refuses remote requests even when the internet is reachable', async () => {
    test.setTimeout(120_000);
    const l = await launch({ offline: false });
    try {
      const { app, organizer } = l;
      await seedSession(organizer, 'Blocker check', 2, PLAYERS.slice(0, 4));
      await resumeInUi(organizer);
      const display = await openDisplay(app, organizer);
      const results = await sessionFetchResult(app, 'https://example.com/');
      expect(results).toHaveLength(2);
      expect(results).toEqual(['blocked', 'blocked']);
      for (const page of [organizer, display]) {
        const outcome = await page.evaluate(() =>
          fetch('https://example.com/').then(
            () => 'reached',
            () => 'blocked',
          ),
        );
        expect(outcome).toBe('blocked');
      }
    } finally {
      await shutdown(l);
    }
  });
});

test.describe('AC-19 display window reflects courts, scores and queue, with no organizer controls', () => {
  test('mirrors the organizer state live and exposes no controls', async () => {
    test.setTimeout(240_000);
    const l = await launch({ offline: true });
    try {
      const { app, organizer } = l;
      const sessionId = await seedSession(organizer, 'Display check', 2, PLAYERS);
      await resumeInUi(organizer);
      const display = await openDisplay(app, organizer);
      expect(app.windows()).toHaveLength(2);

      // Courts: every configured court, in order, available.
      const courts = display.getByTestId('display-court');
      await expect(courts).toHaveCount(2, LIVE_UPDATE);
      await expect(courts.nth(0)).toHaveAttribute('data-court-label', 'Court 1');
      await expect(courts.nth(1)).toHaveAttribute('data-court-label', 'Court 2');
      await expect(courts.nth(0)).toHaveAttribute('data-court-status', 'available');
      await expect(courts.nth(1)).toHaveAttribute('data-court-status', 'available');
      await expect(courts.nth(0).getByTestId('score-A')).toHaveCount(0);

      // Queue: same players in the same order as the organizer's queue.
      const entries = display.getByTestId('display-queue').getByTestId('display-queue-entry');
      const expectQueueMatches = async (): Promise<void> => {
        const names = await queueNames(organizer, sessionId);
        await expect(entries).toHaveCount(names.length, LIVE_UPDATE);
        for (let i = 0; i < names.length; i += 1) await expect(entries.nth(i)).toContainText(names[i] ?? '', LIVE_UPDATE);
      };
      await expectQueueMatches();
      expect(await entries.count()).toBe(6);

      // Court availability changes show up.
      const state0 = await sessionState(organizer, sessionId);
      const court2Id = state0.courts.find((c) => c.label === 'Court 2')?.id ?? '';
      await organizer.evaluate(async (id) => window.openPlay.setCourtStatus(id, 'unavailable'), court2Id);
      await expect(courts.nth(1)).toHaveAttribute('data-court-status', 'unavailable', LIVE_UPDATE);
      await organizer.evaluate(async (id) => window.openPlay.setCourtStatus(id, 'available'), court2Id);
      await expect(courts.nth(1)).toHaveAttribute('data-court-status', 'available', LIVE_UPDATE);

      // Assign a game: the court goes in use with its players; the queue shrinks to the other two.
      await resumeInUi(organizer);
      const court = await startRecommendedGame(organizer);
      const label = (await court.getAttribute('data-court-label')) ?? '';
      expect(label).toMatch(/^Court [12]$/);
      const shown = display.locator(`[data-testid="display-court"][data-court-label="${label}"]`);
      await expect(shown).toHaveAttribute('data-court-status', 'in_use', LIVE_UPDATE);
      const assigned = await sessionState(organizer, sessionId);
      const game = assigned.games.find((g) => g.status === 'scheduled' || g.status === 'in_progress');
      expect(game).toBeDefined();
      const nameOf = new Map(assigned.roster.map((r) => [r.playerId, r.player.displayName]));
      for (const p of game?.participants ?? []) await expect(shown).toContainText(nameOf.get(p.playerId) ?? '?', LIVE_UPDATE);
      await expectQueueMatches();
      expect(await entries.count()).toBe(2);

      // Scores and serving team follow every rally.
      await startScoring(court);
      await expect(shown.getByTestId('score-A')).toHaveText('0', LIVE_UPDATE);
      await expect(shown.getByTestId('score-B')).toHaveText('0', LIVE_UPDATE);
      await expect(shown).toHaveAttribute('data-serving-team', 'A', LIVE_UPDATE);
      await rallies(court, 'A', 3);
      await expect(shown.getByTestId('score-A')).toHaveText('3', LIVE_UPDATE);
      await expect(shown.getByTestId('score-B')).toHaveText('0', LIVE_UPDATE);
      await rallies(court, 'B', 1); // side out at 3-0-2: B serves, A keeps 3
      await expect(shown).toHaveAttribute('data-serving-team', 'B', LIVE_UPDATE);
      await expect(shown.getByTestId('score-A')).toHaveText('3', LIVE_UPDATE);
      await expect(shown.getByTestId('score-B')).toHaveText('0', LIVE_UPDATE);
      await rallies(court, 'B', 2);
      await expect(shown.getByTestId('score-B')).toHaveText('2', LIVE_UPDATE);
      await screenshot(display, 'phase5-display.png');

      // Court-side readability: score digits at least 15% of the viewport height.
      const ratio = await shown.getByTestId('score-A').evaluate((el) => {
        let max = parseFloat(getComputedStyle(el).fontSize);
        for (const child of Array.from(el.querySelectorAll('*'))) max = Math.max(max, parseFloat(getComputedStyle(child).fontSize));
        return max / window.innerHeight;
      });
      expect(ratio).toBeGreaterThanOrEqual(0.15);

      // No organizer controls: no organizer API, no interactive elements, keys do nothing.
      expect(await display.evaluate(() => typeof (window as unknown as { openPlay?: unknown }).openPlay)).toBe('undefined');
      expect(
        await display.locator('button, input, select, textarea, a[href], [role="button"], [contenteditable=""], [contenteditable="true"]').count(),
      ).toBe(0);
      const gameId = game?.id ?? '';
      const before = await scoreEventCount(organizer, gameId);
      expect(before).toBe(6);
      await display.locator('body').click();
      for (const key of ['a', 'b', 'Enter', 'Space', 'Backspace', 'z', 'ControlOrMeta+z', 'ArrowUp', '1']) await display.keyboard.press(key);
      await display.waitForTimeout(500);
      expect(await scoreEventCount(organizer, gameId)).toBe(before);
      await expect(shown.getByTestId('score-B')).toHaveText('2');

      // Opening the display again does not create a second display window.
      await organizer.getByRole('button', { name: /open display/i }).click();
      await organizer.waitForTimeout(1_000);
      expect(app.windows()).toHaveLength(2);

      // Finish the game: the court frees up and all six players are back in the queue.
      await rallies(court, 'B', 9); // B 11, A 3
      await expect(shown.getByTestId('score-B')).toHaveText('11', LIVE_UPDATE);
      await court.getByRole('button', { name: /finalize game/i }).click();
      await expect(shown).toHaveAttribute('data-court-status', 'available', LIVE_UPDATE);
      await expect(shown.getByTestId('score-A')).toHaveCount(0, LIVE_UPDATE);
      await expectQueueMatches();
      expect(await entries.count()).toBe(6);
      await screenshot(display, 'phase5-display-after-game.png');
    } finally {
      await shutdown(l);
    }
  });
});

test.describe('AC-18 timer works independently of score completion', () => {
  test('expiry never finalizes the game; pause holds; scoring and finalizing are unaffected by the timer', async () => {
    test.setTimeout(180_000);
    const l = await launch({ offline: true });
    try {
      const { organizer } = l;
      const sessionId = await seedSession(organizer, 'Timer check', 2, PLAYERS.slice(0, 4));
      await resumeInUi(organizer);
      const court = await startRecommendedGame(organizer);
      await startScoring(court);
      await rallies(court, 'A', 2);
      await expect(court.getByTestId('score-A')).toHaveText('2');
      const gameId = (await sessionState(organizer, sessionId)).games[0]?.id ?? '';
      expect(gameId).not.toBe('');

      const timer = court.getByTestId('timer');
      await expect(timer).toHaveAttribute('data-timer-status', 'idle');
      // 0.05 minutes = 3 seconds.
      await court.getByLabel(/timer length/i).fill('0.05');
      await court.getByRole('button', { name: /start timer/i }).click();
      await expect(timer).toHaveAttribute('data-timer-status', 'running');

      // Paused: does not expire however long we wait.
      await court.getByRole('button', { name: /pause timer/i }).click();
      await expect(timer).toHaveAttribute('data-timer-status', 'paused');
      await organizer.waitForTimeout(4_500);
      await expect(timer).toHaveAttribute('data-timer-status', 'paused');

      // Resumed: expires, and only signals.
      await court.getByRole('button', { name: /resume timer/i }).click();
      await expect(timer).toHaveAttribute('data-timer-status', 'running');
      await expect(timer).toHaveAttribute('data-timer-status', 'expired', { timeout: 15_000 });
      await organizer.waitForTimeout(1_000);
      const afterExpiry = await sessionState(organizer, sessionId);
      expect(afterExpiry.games).toHaveLength(1);
      expect(afterExpiry.games[0]?.status).toBe('in_progress');
      expect(afterExpiry.games[0]?.winner).toBeNull();
      expect(afterExpiry.games[0]?.endedAt).toBeNull();
      expect(await scoreEventCount(organizer, gameId)).toBe(2);
      await expect(court.getByTestId('score-A')).toHaveText('2');
      await expect(court.getByTestId('score-B')).toHaveText('0');
      await screenshot(organizer, 'phase5-timer-expired.png');

      // Scoring continues normally after expiry.
      const rallyA = court.getByRole('button', { name: /team a wins rally/i });
      await expect(rallyA).toBeEnabled();
      await rallyA.click();
      await expect(court.getByTestId('score-A')).toHaveText('3');

      // Reset, then a long timer running while the game is won and finalized.
      await court.getByRole('button', { name: /reset timer/i }).click();
      await expect(timer).toHaveAttribute('data-timer-status', 'idle');
      await court.getByLabel(/timer length/i).fill('10');
      await court.getByRole('button', { name: /start timer/i }).click();
      await expect(timer).toHaveAttribute('data-timer-status', 'running');
      await rallies(court, 'A', 8);
      await expect(court.getByTestId('score-A')).toHaveText('11');
      await court.getByRole('button', { name: /finalize game/i }).click();
      await expect.poll(async () => (await sessionState(organizer, sessionId)).games[0]?.status).toBe('completed');
      const finished = (await sessionState(organizer, sessionId)).games[0];
      expect([finished?.teamAScore, finished?.teamBScore, finished?.winner]).toEqual([11, 0, 'A']);
    } finally {
      await shutdown(l);
    }
  });
});
