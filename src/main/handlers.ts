import { ScoringError } from '../core/scoring';
import { NEW_SESSION_ROTATION_SETTINGS } from '../core/rotation';
import { withTransaction } from '../data/db';
import type { Db } from '../data/db';
import {
  assignManually,
  assignRecommendation,
  declineTurn,
  getQueue,
  getRotationSettings,
  recommendNextGames,
  setRotationSettings,
} from '../data/rotation';
import { setCourtCount, setCourtStatus } from '../data/courts';
import {
  ConfirmationRequiredError,
  DuplicatePlayerError,
  SessionReadOnlyError,
  SessionStateError,
  ValidationError,
} from '../data/errors';
import {
  correctScoringEvent,
  finalizeGame,
  loadScoreLog,
  recordGameResult,
  recordScoringEvent,
  reopenGame,
  startScoring,
  undoLastScoringEvent,
} from '../data/scoring';
import { listPlayers, renamePlayer } from '../data/players';
import {
  addNewPlayerToSession,
  addPlayerToSession,
  checkInPlayer,
  removePlayerFromSession,
  setAvailability,
} from '../data/roster';
import {
  createSession,
  deleteSession,
  findUnfinishedSessions,
  finishSession,
  getSession,
  listSessions,
  loadSessionState,
  reopenSession,
} from '../data/sessions';
import { BackupValidationError, createBackup, restoreBackup, validateBackup } from '../data/backup';
import { exportCsv, exportXlsx } from '../data/export';
import { listGames } from '../data/games';
import { getHistoricalLeaderboard, getSessionLeaderboard } from '../data/stats';
import {
  addAwardToLineup,
  getAwardLibrary,
  getAwardLineup,
  getAwards,
  restoreAwardLineup,
  setAwardLineup,
  setAwardPick,
  type AwardsReport,
  type AwardsScope,
} from '../data/awards';
import { buildSteps, phasesOf, validateCeremonyState } from '../shared/ceremony';
import { getAppearance, setAppearance } from '../data/appearance';
import type { Appearance } from '../shared/themes';
import { FILE_PREFIX } from '../shared/brand';
import { writeFileSync } from 'node:fs';
import { StatsError } from '../core/stats';
import type { ApiMethod, ApiResult, DisplayMode, ExportFormat, OrganizerApi } from '../shared/api';

type Handlers = { [K in ApiMethod]: (...args: unknown[]) => ApiResult<unknown> | Promise<ApiResult<unknown>> };
type SyncHandlerName = Exclude<
  ApiMethod,
  | 'exportData'
  | 'createBackup'
  | 'restoreBackup'
  | 'openDisplay'
  | 'deleteSession'
  | 'showAwardsOnDisplay'
  | 'showCourtsOnDisplay'
  | 'saveAwardsImage'
  | 'saveCertificates'
  | 'setAppearance'
  | 'runCeremonyOnDisplay'
  | 'endCeremonyOnDisplay'
>;

/** The one open database connection; restore closes it and opens the restored file. */
export interface DbStore {
  current(): Db;
  close(): void;
  open(): void;
}

/** Native dialogs and app facts, supplied by the Electron main process. */
export interface HostServices {
  appVersion: string;
  dbFile: string;
  autoBackupDir: string;
  chooseDirectory(title: string): Promise<string | null>;
  chooseSaveFile(title: string, defaultName: string, extension: string): Promise<string | null>;
  chooseOpenFile(title: string, extension: string): Promise<string | null>;
  /** Native confirmation dialog; `confirmLabel` names the destructive button (default "Replace data"). */
  confirm(message: string, detail: string, confirmLabel?: string): Promise<boolean>;
  /** Opens (or focuses) the display window for this session. */
  openDisplay(sessionId: string): void;
  /**
   * Switches what the display window shows, opening it when it is closed. With `quiet` the mode
   * changes without opening or focusing the window (ceremony steps while the host keeps the keyboard).
   */
  showOnDisplay?(mode: DisplayMode, opts?: { quiet?: boolean }): void;
  /** Renders the awards ceremony off screen and returns it as PNG bytes. */
  captureAwardsImage?(scope: AwardsScope): Promise<Uint8Array>;
  /** Prints the organizer window (its print layout) to PDF bytes. */
  printOrganizerPdf?(): Promise<Uint8Array>;
  /** Makes native UI and window backgrounds follow a newly saved appearance. */
  applyAppearance?(appearance: Appearance): void;
}

function requireHost<T>(fn: T | undefined, what: string): T {
  if (fn === undefined) throw new ValidationError(`${what} is not available here.`);
  return fn;
}

/** Arguments arrive over IPC: only the two known scope shapes pass. */
function toScope(value: unknown): AwardsScope {
  const v = value as { kind?: unknown; sessionId?: unknown } | null;
  if (v && v.kind === 'historical') return { kind: 'historical' };
  if (v && v.kind === 'session' && typeof v.sessionId === 'string') return { kind: 'session', sessionId: v.sessionId };
  throw new ValidationError('Choose a session or all time for the awards.');
}

function codeOf(err: unknown): string {
  if (err instanceof DuplicatePlayerError) return 'duplicate_player';
  if (err instanceof SessionReadOnlyError) return 'session_read_only';
  if (err instanceof SessionStateError) return 'session_state';
  if (err instanceof ConfirmationRequiredError) return 'confirmation_required';
  if (err instanceof ValidationError || err instanceof StatsError) return 'validation';
  if (err instanceof BackupValidationError) return `backup_${err.reason}`;
  if (err instanceof ScoringError) return 'scoring';
  return 'unexpected';
}

function failure(err: unknown): ApiResult<never> {
  const error = err instanceof Error ? err.message : String(err);
  if (err instanceof DuplicatePlayerError) return { ok: false, error, code: codeOf(err), matches: err.matches };
  return { ok: false, error, code: codeOf(err) };
}

function run<T>(fn: () => T): ApiResult<T> {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return failure(err);
  }
}

async function runAsync<T>(fn: () => Promise<T>): Promise<ApiResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return failure(err);
  }
}

/** Handlers that only touch the open database. Arguments arrive over IPC, so they are cast at this one boundary. */
function createDbHandlers(db: Db): { [K in SyncHandlerName]: (...args: unknown[]) => ApiResult<unknown> } {
  return {
    getSessionLeaderboard: (sid) => run(() => getSessionLeaderboard(db, sid as string)),
    getHistoricalLeaderboard: () => run(() => getHistoricalLeaderboard(db)),
    getAwards: (scope) => run(() => getAwards(db, toScope(scope))),
    listSessions: () => run(() => listSessions(db)),
    findUnfinishedSessions: () => run(() => findUnfinishedSessions(db)),
    // D14: sessions started from the app balance games played and rotate partners from the start.
    createSession: (input) =>
      run(() =>
        withTransaction(db, () => {
          const session = createSession(db, input as Parameters<OrganizerApi['createSession']>[0]);
          setRotationSettings(db, session.id, { ...NEW_SESSION_ROTATION_SETTINGS }, { at: session.startedAt });
          return session;
        }),
      ),
    loadSessionState: (id) => run(() => loadSessionState(db, id as string)),
    finishSession: (id) => run(() => finishSession(db, id as string)),
    reopenSession: (id) => run(() => reopenSession(db, id as string)),
    setCourtCount: (id, count) => run(() => setCourtCount(db, id as string, count as number)),
    setCourtStatus: (id, status) => run(() => setCourtStatus(db, id as string, status as 'available' | 'unavailable')),
    listPlayers: () => run(() => listPlayers(db)),
    addExistingPlayer: (sid, pid) => run(() => addPlayerToSession(db, sid as string, pid as string)),
    addNewPlayer: (id, input) =>
      run(() => addNewPlayerToSession(db, id as string, input as Parameters<OrganizerApi['addNewPlayer']>[1])),
    checkInPlayer: (sid, pid) => run(() => checkInPlayer(db, sid as string, pid as string)),
    setAvailability: (sid, pid, a) =>
      run(() => setAvailability(db, sid as string, pid as string, a as 'available' | 'resting' | 'unavailable')),
    renamePlayer: (pid, input) =>
      run(() => renamePlayer(db, pid as string, input as Parameters<OrganizerApi['renamePlayer']>[1])),
    removePlayer: (sid, pid) =>
      run(() => {
        removePlayerFromSession(db, sid as string, pid as string);
        return null;
      }),
    startScoring: (gid, opts) => run(() => startScoring(db, gid as string, opts as Parameters<OrganizerApi['startScoring']>[1])),
    recordScoringEvent: (gid, event) =>
      run(() => recordScoringEvent(db, gid as string, event as Parameters<OrganizerApi['recordScoringEvent']>[1])),
    undoLastScoringEvent: (gid) => run(() => undoLastScoringEvent(db, gid as string)),
    correctScoringEvent: (gid, index, event, reason) =>
      run(() =>
        correctScoringEvent(db, gid as string, index as number, event as Parameters<OrganizerApi['recordScoringEvent']>[1], {
          reason: typeof reason === 'string' ? reason : undefined,
        }),
      ),
    loadScoreLog: (gid) => run(() => loadScoreLog(db, gid as string)),
    finalizeGame: (gid) => run(() => finalizeGame(db, gid as string)),
    recordGameResult: (gid, input) =>
      run(() => recordGameResult(db, gid as string, input as Parameters<OrganizerApi['recordGameResult']>[1])),
    reopenGame: (gid, confirm, reason) =>
      run(() => reopenGame(db, gid as string, { confirm: confirm === true, reason: typeof reason === 'string' ? reason : undefined })),
    getRotationSettings: (sid) => run(() => getRotationSettings(db, sid as string)),
    setRotationSettings: (sid, patch) =>
      run(() => setRotationSettings(db, sid as string, patch as Parameters<OrganizerApi['setRotationSettings']>[1])),
    getQueue: (sid) => run(() => getQueue(db, sid as string)),
    recommendNextGames: (sid) => run(() => recommendNextGames(db, sid as string)),
    assignRecommendation: (sid, rec) =>
      run(() => assignRecommendation(db, sid as string, rec as Parameters<OrganizerApi['assignRecommendation']>[1])),
    assignManually: (sid, input) =>
      run(() => assignManually(db, sid as string, input as Parameters<OrganizerApi['assignManually']>[1])),
    declineTurn: (sid, pid) => run(() => declineTurn(db, sid as string, pid as string)),
    getAppearance: () => run(() => getAppearance(db)),
    getAwardLineup: () => run(() => getAwardLineup(db)),
    setAwardLineup: (lineup) => run(() => setAwardLineup(db, lineup)),
    restoreAwardLineup: () => run(() => restoreAwardLineup(db)),
    addAwardToLineup: (templateId) => run(() => addAwardToLineup(db, templateId)),
    getAwardLibrary: (scope) => run(() => getAwardLibrary(db, toScope(scope))),
    setAwardPick: (scope, key, pick) => run(() => setAwardPick(db, toScope(scope), key, pick)),
  };
}

const stamp = (): string => new Date().toISOString().slice(0, 10);
const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'awards';

/** Main-process side of the organizer API: database handlers plus the ones that need native dialogs. */
export function createApiHandlers(store: DbStore, host: HostServices): Handlers {
  const forwarded = {} as Record<SyncHandlerName, (...args: unknown[]) => ApiResult<unknown>>;
  for (const method of Object.keys(createDbHandlers(store.current())) as SyncHandlerName[]) {
    // Rebuilt per call so a restored database is picked up without re-registering IPC handlers.
    forwarded[method] = (...args) => createDbHandlers(store.current())[method](...args);
  }

  // The awards the ceremony on the display is showing; recomputed only on request so a running
  // ceremony does not change under the audience.
  let ceremony: { scopeKey: string; report: AwardsReport } | null = null;

  return {
    ...forwarded,

    runCeremonyOnDisplay: (scope, state, refresh) =>
      run(() => {
        const checked = toScope(scope);
        const scopeKey = JSON.stringify(checked);
        const show = requireHost(host.showOnDisplay, 'The display window');
        const fresh = refresh === true || ceremony === null || ceremony.scopeKey !== scopeKey;
        if (fresh) ceremony = { scopeKey, report: getAwards(store.current(), checked) };
        const report = (ceremony as { report: AwardsReport }).report;
        const steps = buildSteps(report.lineup);
        let valid;
        try {
          valid = validateCeremonyState(state, steps.length);
        } catch (err) {
          throw new ValidationError(err instanceof Error ? err.message : String(err));
        }
        if (!phasesOf(steps[valid.step]).includes(valid.phase)) throw new ValidationError('The ceremony phase does not fit this step.');
        show({ kind: 'ceremony', scope: checked, report, state: valid }, { quiet: !fresh });
        return null;
      }),

    endCeremonyOnDisplay: (scope) =>
      run(() => {
        const checked = toScope(scope);
        ceremony = null;
        requireHost(host.showOnDisplay, 'The display window')({ kind: 'awards', scope: checked }, { quiet: true });
        return null;
      }),

    // Export is read-only on the database (brief §6); only the chosen folder or file is written.
    exportData: (format, sessionId) =>
      runAsync(async () => {
        const sid = typeof sessionId === 'string' ? sessionId : undefined;
        if ((format as ExportFormat) === 'csv') {
          const dir = await host.chooseDirectory('Choose a folder for the CSV files');
          return dir === null ? null : { files: exportCsv(store.current(), { dir, sessionId: sid }) };
        }
        const file = await host.chooseSaveFile('Save results workbook', `${FILE_PREFIX}-export-${stamp()}.xlsx`, 'xlsx');
        if (file === null) return null;
        await exportXlsx(store.current(), { file, sessionId: sid });
        return { files: [file] };
      }),

    // The renderer cannot pass a confirmation flag: only the native dialog below can approve a delete.
    // Deleting an active session with games in progress is allowed, and the dialog warns about it.
    deleteSession: (sid) =>
      runAsync(async () => {
        const session = getSession(store.current(), sid as string);
        if (!session) throw new ValidationError(`Unknown session: ${String(sid)}`);
        const games = listGames(store.current(), session.id);
        const live = games.filter((g) => g.status === 'in_progress' || g.status === 'scheduled').length;
        const warnings = [
          `Delete "${session.name}" with its ${games.length} game(s), scores, roster and rotation history? This cannot be undone.`,
          live > 0 ? `${live} game(s) are still in progress and will be deleted too.` : '',
          'Players stay in the player list. Make a backup first if you may need this session later.',
        ].filter((line) => line !== '');
        const agreed = await host.confirm(`Delete session "${session.name}"?`, warnings.join(' '), 'Delete session');
        if (!agreed) return false;
        deleteSession(store.current(), session.id, { confirm: true });
        return true;
      }),

    setAppearance: (appearance) =>
      run(() => {
        const saved = setAppearance(store.current(), appearance);
        host.applyAppearance?.(saved);
        return saved;
      }),

    openDisplay: (sid) =>
      run(() => {
        loadSessionState(store.current(), sid as string); // fails for an unknown session
        host.openDisplay(sid as string);
        return null;
      }),

    showAwardsOnDisplay: (scope) =>
      run(() => {
        const checked = toScope(scope);
        getAwards(store.current(), checked); // fails for an unknown session
        requireHost(host.showOnDisplay, 'The display window')({ kind: 'awards', scope: checked });
        return null;
      }),

    showCourtsOnDisplay: () =>
      run(() => {
        requireHost(host.showOnDisplay, 'The display window')({ kind: 'courts' });
        return null;
      }),

    saveAwardsImage: (scope) =>
      runAsync(async () => {
        const checked = toScope(scope);
        const report = getAwards(store.current(), checked);
        if (report.finalizedGames === 0) throw new ValidationError('There are no finalized games to award yet.');
        const png = await requireHost(host.captureAwardsImage, 'Saving an image')(checked);
        const file = await host.chooseSaveFile('Save awards image', `${FILE_PREFIX}-awards-${slug(report.scopeLabel)}-${stamp()}.png`, 'png');
        if (file === null) return null;
        writeFileSync(file, png);
        return file;
      }),

    saveCertificates: () =>
      runAsync(async () => {
        const pdf = await requireHost(host.printOrganizerPdf, 'Saving certificates')();
        const file = await host.chooseSaveFile('Save award certificates', `${FILE_PREFIX}-certificates-${stamp()}.pdf`, 'pdf');
        if (file === null) return null;
        writeFileSync(file, pdf);
        return file;
      }),

    createBackup: () =>
      runAsync(async () => {
        const file = await host.chooseSaveFile('Save backup', `${FILE_PREFIX}-backup-${stamp()}.pbbackup`, 'pbbackup');
        if (file === null) return null;
        return { ...createBackup(store.current(), file, { appVersion: host.appVersion }), file };
      }),

    // D10: validate first, ask the organizer in a native dialog (not bypassable from the renderer),
    // back up the current data, then replace it. Nothing is touched on any failure.
    restoreBackup: () =>
      runAsync(async () => {
        const file = await host.chooseOpenFile('Choose a backup to restore', 'pbbackup');
        if (file === null) return null;
        const checked = validateBackup(file);
        if (!checked.ok) throw new BackupValidationError(checked.reason, checked.message);
        const agreed = await host.confirm(
          'Replace all current data with this backup?',
          `Backup made ${checked.manifest.createdAt} by version ${checked.manifest.appVersion}. ` +
            'Your current data is saved to an automatic backup first, but everything since this backup will be gone.',
        );
        if (!agreed) return null;
        store.close();
        try {
          return restoreBackup(file, {
            dbFile: host.dbFile,
            autoBackupDir: host.autoBackupDir,
            confirm: true,
            appVersion: host.appVersion,
          });
        } finally {
          store.open();
        }
      }),
  };
}
