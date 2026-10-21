// Generates the marketing screenshots in site/assets/screenshots/ by driving the built app with
// Playwright's Electron support. Uses a fresh temporary data folder (PBOP_USER_DATA) with realistic
// sample data, so your own sessions are never touched. Fully offline.
// Usage: npm run screenshots          (builds first; or: node scripts/marketing-screenshots.mjs)
import { _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = join(root, 'out', 'main', 'index.js');
const OUT = join(root, 'site', 'assets', 'screenshots');
const MAX_WIDTH = 1600;
const WIDTH = 1440;
const HEIGHT = 900;

const PLAYERS = [
  'Maya Santos', 'Jordan Lee', 'Priya Patel', 'Luis Ortega', 'Hana Kim', 'Marcus Reed',
  'Sofia Rossi', 'Kenji Watanabe', 'Amara Okafor', 'Ethan Brooks', 'Chloe Martin', 'Diego Ramos',
  'Noah Fischer', 'Isla Nguyen',
];
/** Final scores for the recorded games (winner first), so the stats and awards look like a real night. */
const SCORES = [
  [11, 7], [11, 9], [12, 10], [11, 4], [11, 8], [13, 11], [11, 6], [11, 9], [11, 3], [11, 10], [11, 5], [12, 10],
  [11, 8], [11, 7], [11, 9],
];

if (!existsSync(MAIN)) {
  console.error('out/main/index.js is missing. Run npm run build first (or npm run screenshots).');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
const userData = mkdtempSync(join(tmpdir(), 'rallyflow-shots-'));
const env = { ...process.env, PBOP_USER_DATA: userData };
delete env.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({ args: [MAIN], env });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function sizeWindows(width, height) {
  await app.evaluate(({ BrowserWindow }, size) => {
    for (const w of BrowserWindow.getAllWindows()) w.setContentSize(size.width, size.height);
  }, { width, height });
}

/** Screenshot, then scale to at most MAX_WIDTH px wide (macOS sips). */
async function shot(page, name) {
  const file = join(OUT, name);
  await page.screenshot({ path: file });
  if (process.platform === 'darwin') execFileSync('sips', ['--resampleWidth', String(MAX_WIDTH), file], { stdio: 'ignore' });
  console.log('wrote', file);
}

try {
  const organizer = await app.firstWindow();
  await organizer.waitForFunction(() => typeof window.openPlay === 'object' && window.openPlay !== null);
  await sizeWindows(WIDTH, HEIGHT);

  // ---- Sample data: a finished warm-up session (for all-time stats) and tonight's live session.
  await organizer.evaluate(
    async ({ players, scores }) => {
      const api = window.openPlay;
      const unwrap = (r) => {
        if (!r.ok) throw new Error(r.error);
        return r.value;
      };
      let scoreIndex = 0;
      async function playRound(sessionId, finish) {
        const result = unwrap(await api.recommendNextGames(sessionId));
        const games = [];
        for (const rec of result.recommendations) games.push(unwrap(await api.assignRecommendation(sessionId, rec)));
        for (const game of games) {
          unwrap(await api.startScoring(game.id, { firstServingTeam: scoreIndex % 2 === 0 ? 'A' : 'B' }));
          if (!finish) continue;
          const [w, l] = scores[scoreIndex % scores.length];
          const winner = scoreIndex % 3 === 1 ? 'B' : 'A';
          unwrap(await api.recordGameResult(game.id, winner === 'A' ? { winner, scoreA: w, scoreB: l } : { winner, scoreA: l, scoreB: w }));
          scoreIndex += 1;
        }
        return games;
      }
      async function addPlayers(sessionId, names, existing) {
        for (const displayName of names) {
          const known = existing.find((p) => p.displayName === displayName);
          const entry = known
            ? unwrap(await api.addExistingPlayer(sessionId, known.id))
            : unwrap(await api.addNewPlayer(sessionId, { displayName }));
          unwrap(await api.checkInPlayer(sessionId, entry.playerId));
        }
      }

      const warmup = unwrap(await api.createSession({ name: 'Monday Morning Drop-In', courtCount: 2 }));
      await addPlayers(warmup.id, players.slice(0, 10), []);
      for (let i = 0; i < 3; i += 1) await playRound(warmup.id, true);
      unwrap(await api.finishSession(warmup.id));

      const known = unwrap(await api.listPlayers());
      const tonight = unwrap(await api.createSession({ name: 'Thursday Night Open Play', courtCount: 3 }));
      await addPlayers(tonight.id, players, known);
      for (let i = 0; i < 5; i += 1) await playRound(tonight.id, true);
      // Leave a live round on the courts, mid-rally.
      const live = await playRound(tonight.id, false);
      const rallies = [
        ['A', 'A', 'B', 'A', 'B', 'B', 'A', 'A', 'A', 'B', 'A', 'A', 'B', 'A'],
        ['B', 'B', 'A', 'B', 'A', 'B', 'B', 'A', 'B'],
        ['A', 'B', 'A', 'A', 'B', 'A'],
      ];
      for (let g = 0; g < live.length; g += 1) {
        for (const winner of rallies[g % rallies.length]) unwrap(await api.recordScoringEvent(live[g].id, { type: 'rally', winner }));
      }
      return tonight.id;
    },
    { players: PLAYERS, scores: SCORES },
  );

  async function setLook(mode, theme) {
    await organizer.evaluate(async (a) => {
      const r = await window.openPlay.setAppearance(a);
      if (!r.ok) throw new Error(r.error);
    }, { mode, theme });
    await organizer.reload();
    await organizer.waitForFunction(() => typeof window.openPlay === 'object' && window.openPlay !== null);
    await wait(400);
  }
  async function openTonight() {
    await organizer.getByRole('button', { name: 'Resume' }).first().click();
    await organizer.getByRole('button', { name: 'Finish session' }).waitFor();
    await wait(900);
  }

  // ---- Organizer dashboard, light (Court Green) and dark (Midnight Neon).
  await setLook('light', 'court');
  await openTonight();
  await shot(organizer, 'organizer-light.png');

  await setLook('dark', 'neon');
  await openTonight();
  await shot(organizer, 'organizer-dark.png');

  await setLook('dark', 'ocean');
  await openTonight();
  await shot(organizer, 'organizer-ocean-dark.png');

  // ---- Big-screen display.
  await setLook('light', 'court');
  await openTonight();
  const [display] = await Promise.all([app.waitForEvent('window'), organizer.getByRole('button', { name: /open display/i }).click()]);
  await display.waitForLoadState('domcontentloaded');
  // The big screen is a TV: capture it at 1920x1080 (scaled to MAX_WIDTH afterwards).
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.getTitle().includes('Display'));
    w?.setContentSize(1920, 1080);
  });
  await display.getByTestId('display-court').first().waitFor();
  await wait(1800);
  await shot(display, 'display.png');

  // ---- Awards: the organizer page and the ceremony on the big screen.
  await organizer.getByRole('button', { name: 'Awards' }).first().click();
  await organizer.locator('#awards-heading').waitFor();
  await wait(4500); // let the confetti settle
  await shot(organizer, 'awards.png');
  await organizer.evaluate(async () => {
    const list = await window.openPlay.listSessions();
    if (!list.ok) throw new Error(list.error);
    const tonight = list.value.find((s) => s.name === 'Thursday Night Open Play');
    if (!tonight) throw new Error('missing session');
    await window.openPlay.showAwardsOnDisplay({ kind: 'session', sessionId: tonight.id });
  });
  await display.locator('[data-ready="awards"]').waitFor();
  await wait(5000);
  await shot(display, 'awards-ceremony.png');
  await organizer.evaluate(() => window.openPlay.showCourtsOnDisplay());
  await display.close();

  // ---- Reports and leaderboard.
  await organizer.reload();
  await organizer.waitForFunction(() => typeof window.openPlay === 'object' && window.openPlay !== null);
  await organizer.getByRole('button', { name: 'Reports and data' }).click();
  await wait(800);
  const sessionSelect = organizer.locator('select[aria-label="Session"]');
  if (await sessionSelect.count()) await sessionSelect.selectOption({ label: 'Thursday Night Open Play' });
  await wait(500);
  const reports = organizer.getByRole('button', { name: 'Export CSV' });
  await reports.scrollIntoViewIfNeeded();
  await organizer.evaluate(() => {
    const el = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Export CSV');
    const h = [...document.querySelectorAll('h2')].find((x) => x.textContent === 'Reports and data');
    h?.scrollIntoView({ block: 'start' });
    window.scrollBy(0, -110);
    void el;
  });
  await wait(500);
  await shot(organizer, 'reports.png');

  // ---- Appearance picker.
  await organizer.evaluate(() => window.scrollTo(0, 0));
  await openTonight();
  await organizer.getByRole('button', { name: 'Appearance' }).click();
  await organizer.getByRole('dialog', { name: 'Appearance settings' }).waitFor();
  await wait(600);
  await shot(organizer, 'appearance.png');
} finally {
  await app.close();
  rmSync(userData, { recursive: true, force: true });
}
