/**
 * The club or group name shown on the awards ceremony, board, image and certificates
 * (e.g. "CCF Sandoval Pickleball Club"). Pure helpers shared by the data layer and both windows.
 * The global name and tagline live in the settings table; a session can override the name
 * ("Thursday Night Crew"). Empty means "not set": the screens fall back to the session name and
 * the RallyFlow brand.
 */
import { BRAND } from './brand';

export const CLUB_NAME_MAX = 60;
export const CLUB_TAGLINE_MAX = 80;

export interface ClubSettings {
  /** The club or group name; '' when not set. */
  name: string;
  /** Optional short subtitle, e.g. "Play hard, play kind"; '' when not set. */
  tagline: string;
}

/** What the organizer edits: the global settings plus this session's override. */
export interface ClubInfo extends ClubSettings {
  /** This session's name override; '' when the session uses the club name. */
  sessionName: string;
}

/** What the awards screens show: the name in effect for this scope. */
export interface ClubBranding {
  /** The session override, else the club name; '' when neither is set. */
  name: string;
  tagline: string;
}

export const EMPTY_CLUB: ClubSettings = { name: '', tagline: '' };

/** Thrown for a value the organizer must change; the data layer turns it into a ValidationError. */
export class ClubNameError extends Error {}

// Control characters (C0, DEL, C1) and zero-width / bidi formatting characters.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤﻿]/g;

/** Trims, removes invisible characters and collapses runs of spaces. */
export function cleanClubText(value: string): string {
  return value.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
}

function checkText(value: unknown, max: number, what: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ClubNameError(`The ${what} must be text.`);
  const clean = cleanClubText(value);
  if ([...clean].length > max) throw new ClubNameError(`Keep the ${what} to ${max} characters or fewer.`);
  return clean;
}

/** Validates the club name and tagline the organizer typed. */
export function validateClub(value: unknown): ClubSettings {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ClubNameError('Enter a club name (or leave it empty).');
  const v = value as { name?: unknown; tagline?: unknown };
  return { name: checkText(v.name, CLUB_NAME_MAX, 'club name'), tagline: checkText(v.tagline, CLUB_TAGLINE_MAX, 'tagline') };
}

/** Validates a session's name override ('' clears it). */
export function validateSessionClubName(value: unknown): string {
  return checkText(value, CLUB_NAME_MAX, 'session name');
}

/** Reads stored settings leniently: anything unexpected becomes "not set". */
export function normalizeClub(value: unknown): ClubSettings {
  try {
    return validateClub(value);
  } catch {
    return { ...EMPTY_CLUB };
  }
}

/** The name and tagline in effect: the session override wins over the club name. */
export function resolveClub(club: ClubSettings, sessionName = ''): ClubBranding {
  const name = cleanClubText(sessionName) || club.name;
  return { name, tagline: club.tagline };
}

/** The header title on the ceremony: the club, else "RallyFlow Awards". */
export function clubHeader(club: ClubBranding | undefined): string {
  return club && club.name ? club.name : `${BRAND.name} Awards`;
}

/** The line on certificates and the image credit: "Presented by <club>", or null when not set. */
export function presentedBy(club: ClubBranding | undefined): string | null {
  return club && club.name ? `Presented by ${club.name}` : null;
}
