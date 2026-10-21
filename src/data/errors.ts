import type { Player } from './types';

/** Bad input: court count, team sizes, unknown ids and similar. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Brief §6 duplicate entries: the name (or nickname) already belongs to a registered player. */
export class DuplicatePlayerError extends Error {
  readonly matches: Player[];
  constructor(message: string, matches: Player[]) {
    super(message);
    this.name = 'DuplicatePlayerError';
    this.matches = matches;
  }
}

/** A write was attempted on a completed session (brief §5 E). Reopen the session first. */
export class SessionReadOnlyError extends Error {
  constructor(message = 'This session is completed and read-only. Reopen it to make corrections.') {
    super(message);
    this.name = 'SessionReadOnlyError';
  }
}

/** Illegal lifecycle step (finish twice, reopen an active session, remove something in play). */
export class SessionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionStateError';
  }
}

/** deleteSession was called without { confirm: true }. */
export class ConfirmationRequiredError extends Error {
  constructor(message = 'Deleting a session needs explicit confirmation ({ confirm: true }).') {
    super(message);
    this.name = 'ConfirmationRequiredError';
  }
}
