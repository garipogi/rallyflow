/*
 * Club / group name on the awards (organizer request): validated and length-limited, stored in the
 * settings table, with a per-session override, and carried on every awards report.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLUB_NAME_MAX,
  CLUB_TAGLINE_MAX,
  ClubNameError,
  clubHeader,
  cleanClubText,
  normalizeClub,
  presentedBy,
  resolveClub,
  validateClub,
  validateSessionClubName,
} from '../../src/shared/club';
import { openDatabase, type Db } from '../../src/data/db';
import { createSession } from '../../src/data/sessions';
import { getClub, getClubBranding, setClub, setSessionClubName } from '../../src/data/club';
import { getAwards } from '../../src/data/awards';
import { createApiHandlers, type DbStore, type HostServices } from '../../src/main/handlers';
import { API_METHODS } from '../../src/shared/api';

describe('club name rules (pure)', () => {
  it('trims, collapses spaces and removes invisible characters', () => {
    expect(cleanClubText('  CCF   Sandoval\tPickleball​ Club \n')).toBe('CCF Sandoval Pickleball Club');
    expect(validateClub({ name: ' CCF Sandoval Pickleball Club ', tagline: '  Play hard, play kind ' })).toEqual({
      name: 'CCF Sandoval Pickleball Club',
      tagline: 'Play hard, play kind',
    });
  });

  it('empty or missing means not set', () => {
    expect(validateClub({ name: '', tagline: '' })).toEqual({ name: '', tagline: '' });
    expect(validateClub({})).toEqual({ name: '', tagline: '' });
    expect(validateSessionClubName(undefined)).toBe('');
  });

  it('refuses non-text and names that are too long', () => {
    expect(() => validateClub(null)).toThrow(ClubNameError);
    expect(() => validateClub('CCF')).toThrow(ClubNameError);
    expect(() => validateClub({ name: 42 })).toThrow(/must be text/);
    expect(() => validateClub({ name: 'x'.repeat(CLUB_NAME_MAX + 1) })).toThrow(/60 characters/);
    expect(() => validateClub({ name: 'ok', tagline: 'y'.repeat(CLUB_TAGLINE_MAX + 1) })).toThrow(/80 characters/);
    expect(validateClub({ name: 'x'.repeat(CLUB_NAME_MAX) }).name).toHaveLength(CLUB_NAME_MAX);
    expect(() => validateSessionClubName('z'.repeat(CLUB_NAME_MAX + 1))).toThrow(ClubNameError);
  });

  it('stored values are read leniently', () => {
    expect(normalizeClub({ name: 7 })).toEqual({ name: '', tagline: '' });
    expect(normalizeClub(null)).toEqual({ name: '', tagline: '' });
  });

  it('the session override wins; empty falls back to RallyFlow', () => {
    const club = { name: 'CCF Sandoval Pickleball Club', tagline: 'Play hard' };
    expect(resolveClub(club)).toEqual({ name: 'CCF Sandoval Pickleball Club', tagline: 'Play hard' });
    expect(resolveClub(club, 'Thursday Night Crew')).toEqual({ name: 'Thursday Night Crew', tagline: 'Play hard' });
    expect(clubHeader(resolveClub(club))).toBe('CCF Sandoval Pickleball Club');
    expect(clubHeader({ name: '', tagline: '' })).toBe('RallyFlow Awards');
    expect(clubHeader(undefined)).toBe('RallyFlow Awards');
    expect(presentedBy(resolveClub(club))).toBe('Presented by CCF Sandoval Pickleball Club');
    expect(presentedBy({ name: '', tagline: '' })).toBeNull();
  });
});

describe('club name storage and API', () => {
  let dir: string;
  let db: Db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pbop-club-'));
    db = openDatabase(join(dir, 'app.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to not set, saves globally and per session, and clears', () => {
    const s = createSession(db, { name: 'Thursday', courtCount: 2 });
    expect(getClub(db)).toEqual({ name: '', tagline: '', sessionName: '' });
    expect(setClub(db, { name: 'CCF Sandoval Pickleball Club', tagline: 'Play hard, play kind' })).toEqual({
      name: 'CCF Sandoval Pickleball Club',
      tagline: 'Play hard, play kind',
    });
    expect(getClubBranding(db, s.id)).toEqual({ name: 'CCF Sandoval Pickleball Club', tagline: 'Play hard, play kind' });
    expect(setSessionClubName(db, s.id, ' Thursday Night Crew ')).toEqual({
      name: 'CCF Sandoval Pickleball Club',
      tagline: 'Play hard, play kind',
      sessionName: 'Thursday Night Crew',
    });
    expect(getClubBranding(db, s.id).name).toBe('Thursday Night Crew');
    expect(getClubBranding(db, null).name).toBe('CCF Sandoval Pickleball Club');
    expect(setSessionClubName(db, s.id, '').sessionName).toBe('');
    expect(getClubBranding(db, s.id).name).toBe('CCF Sandoval Pickleball Club');
    expect(() => setSessionClubName(db, 'missing', 'X')).toThrow(/Choose a session/);
    expect(() => setClub(db, { name: 'x'.repeat(61) })).toThrow(/60 characters/);
  });

  it('every awards report carries the club in effect', () => {
    const s = createSession(db, { name: 'Thursday', courtCount: 2 });
    expect(getAwards(db, { kind: 'session', sessionId: s.id }).club).toEqual({ name: '', tagline: '' });
    setClub(db, { name: 'CCF Sandoval Pickleball Club', tagline: '' });
    expect(getAwards(db, { kind: 'historical' }).club.name).toBe('CCF Sandoval Pickleball Club');
    setSessionClubName(db, s.id, 'Thursday Night Crew');
    expect(getAwards(db, { kind: 'session', sessionId: s.id }).club.name).toBe('Thursday Night Crew');
  });

  it('is reachable through the organizer API with friendly validation errors', async () => {
    expect(API_METHODS).toEqual(expect.arrayContaining(['getClub', 'setClub', 'setSessionClubName']));
    const store: DbStore = { current: () => db, close: () => undefined, open: () => undefined };
    const host: HostServices = {
      appVersion: 'test',
      dbFile: join(dir, 'app.db'),
      autoBackupDir: join(dir, 'auto'),
      chooseDirectory: async () => null,
      chooseSaveFile: async () => null,
      chooseOpenFile: async () => null,
      confirm: async () => false,
      openDisplay: () => undefined,
    };
    const api = createApiHandlers(store, host);
    const s = createSession(db, { name: 'Thursday', courtCount: 2 });
    expect(await api.setClub({ name: 'CCF Sandoval Pickleball Club', tagline: '' })).toMatchObject({ ok: true });
    expect(await api.setClub({ name: 5 })).toMatchObject({ ok: false, code: 'validation' });
    expect(await api.setSessionClubName(s.id, 'Crew')).toMatchObject({ ok: true, value: { sessionName: 'Crew' } });
    expect(await api.getClub(s.id)).toMatchObject({ ok: true, value: { name: 'CCF Sandoval Pickleball Club', sessionName: 'Crew' } });
    expect(await api.getClub()).toMatchObject({ ok: true, value: { sessionName: '' } });
  });
});
