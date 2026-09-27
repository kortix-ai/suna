/**
 * One vocabulary for the state of a session, read by every host.
 *
 * Web and mobile each derived and worded these states themselves, and they
 * drifted: a finished session read "Done" in the web sidebar, "Completed" on
 * the web Sessions page and "Stopped" on mobile; the machine behind a session
 * was a "sandbox", a "runtime", a "workspace" or a "computer" depending on the
 * screen, and mobile called a booting box "Unreachable".
 *
 * The STATE models live beside this file (`connection.ts` for the session's
 * computer, the server's `ProjectSessionStatus` for its lifecycle). This module
 * only answers "what do we call it, and how loud is it". Labels are English
 * sentence case; a host with a translation catalog maps the same keys.
 *
 * Tone rule: green means live or actionable, and nothing else. A finished
 * session is muted, never green.
 */

import type { ProjectSession } from '../rest/projects-client/sessions';
import type { SessionConnection } from './connection';

/** How loud a status is. Hosts map tones to colors; they never pick a color per status. */
export type StatusTone = 'actionable' | 'live' | 'progress' | 'muted' | 'danger';

export interface StatusWording {
  label: string;
  tone: StatusTone;
}

// ── A session in a list ─────────────────────────────────────────────────────

/**
 * What a list shows for a session, as opposed to what its sandbox is doing.
 * `queued`, `branching` and `provisioning` are one idea to a user: starting.
 */
export type SessionListStatus =
  | 'needs-you'
  | 'starting'
  | 'running'
  | 'done'
  | 'stopped'
  | 'failed'
  | 'legacy';

export const SESSION_LIST_STATUS: Readonly<
  Record<SessionListStatus, StatusWording & { description: string }>
> = {
  'needs-you': { label: 'Needs you', tone: 'actionable', description: 'Waiting for your review' },
  starting: { label: 'Starting', tone: 'progress', description: 'Its computer is starting' },
  // Never "Active": `running` means the computer is up, not that the agent is working.
  running: { label: 'Running', tone: 'live', description: 'Its computer is up' },
  done: { label: 'Done', tone: 'muted', description: 'Finished' },
  stopped: { label: 'Stopped', tone: 'muted', description: 'Asleep. Opening it wakes its computer' },
  failed: { label: 'Failed', tone: 'danger', description: "Its computer didn't start" },
  legacy: { label: 'Legacy', tone: 'muted', description: 'Imported. Open it to restore' },
};

/**
 * A session created by the account migration. Its chat history is restored
 * into the computer when the session is opened. Stamped as
 * `metadata.legacy_migration`.
 */
export function isLegacyMigratedSession(session: Pick<ProjectSession, 'metadata'>): boolean {
  const meta = (session.metadata ?? {}) as Record<string, unknown>;
  return Boolean(meta.legacy_migration);
}

/**
 * The list status of a session. A pending review wins outright: a finished
 * session with items awaiting the human is actionable, and actionable outranks
 * finished.
 *
 * A status this build has never seen reads `stopped`: `ProjectSessionStatus` is
 * a published union, so a newer API can send an eighth member, and "not live"
 * is true of it where `failed` would invent a failure.
 */
export function sessionListStatus(
  session: Pick<ProjectSession, 'status' | 'metadata'>,
  reviewCount = 0,
): SessionListStatus {
  if (reviewCount > 0) return 'needs-you';
  switch (session.status as string) {
    case 'queued':
    case 'branching':
    case 'provisioning':
      return 'starting';
    case 'running':
      return 'running';
    case 'completed':
    case 'stopped':
      // A dormant migrated session is not "done": nothing ran; its chat is
      // waiting to be restored.
      if (isLegacyMigratedSession(session)) return 'legacy';
      return session.status === 'completed' ? 'done' : 'stopped';
    case 'failed':
      return 'failed';
    default:
      return 'stopped';
  }
}

// ── The session's computer ──────────────────────────────────────────────────

/**
 * A short label for the session's computer, for a status pill. `null` means
 * say nothing: `unknown` is a cold load, not a fault, and `live` needs no word.
 */
export function sessionConnectionLabel(connection: SessionConnection): StatusWording | null {
  switch (connection) {
    case 'waking':
      return { label: 'Waking computer', tone: 'progress' };
    case 'connecting':
      return { label: 'Connecting', tone: 'progress' };
    case 'unreachable':
      return { label: "Can't reach computer", tone: 'danger' };
    default:
      return null;
  }
}

/**
 * The sentence a composer shows while the session's computer is not ready. It
 * says what is happening AND what a send does, because the send button stays
 * live: without the second half, pressing it looks like nothing happened.
 */
export const SESSION_NOTICE = {
  /** The computer stopped answering, and no turn is open. */
  unreachable: "Lost contact with this session's computer. Messages you send are queued until it reconnects.",
  /** The computer stopped answering while a turn is still open. */
  unreachableMidTurn:
    "Lost contact with this session's computer while a turn is still open. Messages you send stay queued until it answers.",
  /** A wake is taking longer than its usual budget. */
  stalled: "Waking this session's computer is taking longer than usual. Messages you send are queued.",
  /** A first prompt is waiting for a new computer. */
  starting: "Starting this session's computer. Your message sends automatically.",
  /** The computer sleeps while the session is idle; a send wakes it. */
  idle: 'This session is idle. The next message you send wakes its computer and is delivered.',
  /** The computer is waking. */
  waking: "Waking this session's computer. Messages you send are queued and go out automatically.",
} as const;

// ── A turn ──────────────────────────────────────────────────────────────────

/** The waiting row of a turn that failed and will be retried. `null`: no countdown known. */
export function turnRetryLabel(secondsLeft: number | null): string {
  if (secondsLeft === null) return 'Waiting to retry';
  return secondsLeft > 0 ? `Retrying in ${secondsLeft}s` : 'Retrying now';
}
