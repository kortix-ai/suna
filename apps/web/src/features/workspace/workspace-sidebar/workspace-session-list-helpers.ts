import type { WorkspaceSession, WorkspaceSessionStatus } from '@kortix/sdk';

/**
 * Pure helpers extracted from `workspace-session-list.tsx` so every decision the
 * sidebar session list makes is unit-testable without mounting react-query or
 * the row components. Five decisions live here:
 *
 * - when to keep polling (`shouldPollWorkspaceSessions`);
 * - what "last activity" means and how to sort by it
 *   (`sessionLastActivityAt`, `sortSessionsByLastActivity`) — the same value
 *   the sidebar's date sections bucket on, see `session-grouping.ts`;
 * - what a row is titled, and how its timestamp is abbreviated
 *   (`getSessionDisplayTitle`, `shortRelative`);
 * - which of loading/error/empty/no-matches/content renders
 *   (`resolveSessionListViewState`).
 *
 * Display status itself is NOT decided here — `sessionDisplayStatus` in
 * `components/workspaces/session-label` owns that mapping, and this file reads it.
 */

export const LIVE_SESSION_STATUSES: WorkspaceSessionStatus[] = [
  'queued',
  'branching',
  'provisioning',
];

/** Whether the session list should keep polling — true while any session is
 *  still mid-provisioning (queued/branching/provisioning). */
export function shouldPollWorkspaceSessions(sessions: WorkspaceSession[] | undefined): boolean {
  return (sessions ?? []).some((session) => LIVE_SESSION_STATUSES.includes(session.status));
}

/** Fast poll: a provisioning session changes status within seconds. */
const PROVISIONING_POLL_MS = 5_000;
/** Slow poll: fast enough that the relative-time column and the date sections
 *  follow the conversation you are having, slow enough to be one cheap request
 *  a minute. */
const OPEN_SESSION_POLL_MS = 60_000;

/**
 * How often the sidebar refetches the session list, or false for not at all.
 *
 * Provisioning wins, as it always has. Beyond that the list refetches ONLY
 * while a session is open, because that is the only time this list goes stale
 * on its own: every prompt advances the open session's last activity server
 * side, which is what moves its row between the Today / Yesterday / This week
 * sections. Without this the row keeps yesterday's section until the page is
 * reloaded, no matter how long you work in it. A workspace page with no session
 * open generates no activity, so it polls nothing.
 */
export function workspaceSessionsRefetchInterval(params: {
  sessions: WorkspaceSession[] | undefined;
  hasOpenSession: boolean;
}): number | false {
  if (shouldPollWorkspaceSessions(params.sessions)) return PROVISIONING_POLL_MS;
  return params.hasOpenSession ? OPEN_SESSION_POLL_MS : false;
}

/** Epoch ms from an ISO string or an epoch-ms number, or null. `metadata` is
 *  jsonb, so its values arrive as `unknown` and must be proven, not asserted. */
function activityMs(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** When the API last accepted a prompt for this session.
 *
 * Stamped server-side in the preview proxy the moment a prompt is admitted
 * (`apps/api/src/workspaces/session-activity.ts`), so it needs no sandbox
 * round-trip and cannot silently go missing the way the snapshot below can. */
function promptActivityMs(session: WorkspaceSession): number | null {
  return activityMs((session.metadata as Record<string, unknown> | null)?.last_activity_at);
}

/** Newest conversation update in OpenCode's scoped session snapshot, or null
 *  when the session carries no usable snapshot. */
function conversationActivityMs(session: WorkspaceSession): number | null {
  let latest: number | null = null;
  for (const openCodeSession of session.opencode_sessions ?? []) {
    const parsed = activityMs(openCodeSession.updated_at);
    if (parsed === null) continue;
    latest = latest === null ? parsed : Math.max(latest, parsed);
  }
  return latest;
}

/** The latest real activity for a session, newest evidence first.
 *
 * Two independent signals mean "someone used this session", and the newer one
 * wins because each can lead the other: the prompt stamp lands before the turn
 * runs, and the conversation snapshot keeps advancing while the agent replies.
 *
 *   1. `metadata.last_activity_at` — the API's prompt stamp.
 *   2. `opencode_sessions[].updated_at` — OpenCode's conversation snapshot.
 *      Real activity, but a LAGGING cache: it is written only by a deferred,
 *      best-effort sandbox read (`opencode-session-snapshot.ts`), so a session
 *      whose sandbox was unreachable at that moment has no snapshot at all.
 *   3. `updated_at` — row bookkeeping, and only reached when neither signal
 *      above exists.
 *   4. `created_at` — last resort.
 *
 * Step 3 is the fix for the reported bug and it is deliberately a FALLBACK, not
 * a peer. Bookkeeping writes (runtime stop/resume, title sync, branch
 * telemetry, mapping repairs) advance `updated_at` without a turn, so it must
 * never outrank a session that has real activity data. But for a session with
 * NO activity data, `updated_at` is an upper bound on when it was last touched
 * while `created_at` is provably not activity at all — which is what pinned a
 * session that is used every day to the "Older" section of its creation date.
 * On local data 164 of 181 sessions were in exactly that state. Step 3 retires
 * itself: any such session gets an exact stamp on its next prompt. */
export function sessionLastActivityAt(session: WorkspaceSession): string {
  const prompt = promptActivityMs(session);
  const conversation = conversationActivityMs(session);
  if (prompt !== null || conversation !== null) {
    return new Date(Math.max(prompt ?? -Infinity, conversation ?? -Infinity)).toISOString();
  }
  return session.updated_at || session.created_at;
}

/** Newest-first sort by `sessionLastActivityAt`. */
export function sortSessionsByLastActivity(sessions: WorkspaceSession[]): WorkspaceSession[] {
  return sessions.slice().sort((a, b) => {
    const parsedA = new Date(sessionLastActivityAt(a)).getTime();
    const parsedB = new Date(sessionLastActivityAt(b)).getTime();
    const aTime = Number.isFinite(parsedA) ? parsedA : 0;
    const bTime = Number.isFinite(parsedB) ? parsedB : 0;
    return bTime - aTime;
  });
}

/**
 * Display title for a session row. Precedence: user rename (custom_name) →
 * server name → legacy metadata.session_name → a slice of the branch name →
 * the literal "session" fallback when nothing else is available.
 */
export function getSessionDisplayTitle(session: WorkspaceSession): string {
  const legacyMetadataName =
    typeof session.metadata?.session_name === 'string'
      ? (session.metadata.session_name as string)
      : null;
  const titleCandidate =
    session.custom_name?.trim() || session.name?.trim() || legacyMetadataName?.trim();

  if (titleCandidate) return titleCandidate;
  // Untitled (the real title lands seconds after the first prompt): a humane
  // static label beats a raw branch-hash slice in the sidebar.
  return 'New session';
}

/** Compresses date-fns' `formatDistanceToNowStrict` output ("5 minutes") down
 *  to the sidebar's fixed-width form ("5m") so the relative-time column never
 *  reflows the row. "0 seconds" and "less than a minute" both collapse to
 *  "now". Unrecognized input (a future date-fns phrasing change, or a locale
 *  string) is passed through unchanged rather than dropped. */
export function shortRelative(input: string): string {
  if (input === 'less than a minute') return 'now';
  const match = input.match(/^(\d+)\s+(second|minute|hour|day|month|year)s?$/);
  if (!match) return input;
  if (match[1] === '0' && match[2] === 'second') return 'now';
  const [, n, unit] = match;
  const suffix =
    unit === 'second'
      ? 's'
      : unit === 'minute'
        ? 'm'
        : unit === 'hour'
          ? 'h'
          : unit === 'day'
            ? 'd'
            : unit === 'month'
              ? 'mo'
              : 'y';
  return `${n}${suffix}`;
}

/** Which of the sidebar's mutually-exclusive render states applies. Mirrors
 *  the early-return ladder in `WorkspaceSessionList`: loading and error both
 *  win outright (independent of data), then "no sessions at all" wins over
 *  "sessions exist but none match the active filter". */
export type SessionListViewState = 'loading' | 'error' | 'empty' | 'no-matches' | 'content';

export function resolveSessionListViewState(params: {
  isLoading: boolean;
  isError: boolean;
  totalCount: number;
  visibleCount: number;
}): SessionListViewState {
  if (params.isLoading) return 'loading';
  if (params.isError) return 'error';
  if (params.totalCount === 0) return 'empty';
  if (params.visibleCount === 0) return 'no-matches';
  return 'content';
}

/** A coordinator (or standalone) session plus the sessions it spawned. */
export interface SessionGroup {
  session: WorkspaceSession;
  children: WorkspaceSession[];
}

/**
 * Fold a flat, already-sorted session list into coordinator groups: a session
 * spawned by another session in the list (metadata.spawned_by_session) nests
 * under it — the sidebar renders the coordinator as a folder and its children
 * as files. A child whose coordinator is absent (deleted, other workspace, or a
 * stale stamp) stays top-level rather than disappearing.
 */
export function groupSessionsByCoordinator(sessions: WorkspaceSession[]): SessionGroup[] {
  const present = new Set(sessions.map((s) => s.session_id));
  const parentOf = (session: WorkspaceSession): string | null => {
    const meta = (session.metadata ?? {}) as Record<string, unknown>;
    const parent = typeof meta.spawned_by_session === 'string' ? meta.spawned_by_session : null;
    return parent && present.has(parent) && parent !== session.session_id ? parent : null;
  };
  const groups = new Map<string, SessionGroup>();
  const order: SessionGroup[] = [];
  for (const session of sessions) {
    if (parentOf(session)) continue;
    const group = { session, children: [] as WorkspaceSession[] };
    groups.set(session.session_id, group);
    order.push(group);
  }
  for (const session of sessions) {
    const parent = parentOf(session);
    if (parent) groups.get(parent)?.children.push(session);
  }
  return order;
}
