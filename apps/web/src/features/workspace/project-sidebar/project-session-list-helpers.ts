import type { ProjectSession, ProjectSessionStatus } from '@kortix/sdk';

/**
 * Pure helpers extracted from `project-session-list.tsx` so the sidebar's
 * sort/poll/label/time-formatting decisions and its loading/error/empty/
 * content state selection are unit-testable without mounting react-query or
 * the row components.
 */

export const LIVE_SESSION_STATUSES: ProjectSessionStatus[] = [
  'queued',
  'branching',
  'provisioning',
];

/** Whether the session list should keep polling — true while any session is
 *  still mid-provisioning (queued/branching/provisioning). */
export function shouldPollProjectSessions(sessions: ProjectSession[] | undefined): boolean {
  return (sessions ?? []).some((session) => LIVE_SESSION_STATUSES.includes(session.status));
}

/** The latest conversation activity for a session.
 *
 * `project_sessions.updated_at` is bookkeeping. Runtime stop/resume, title
 * sync, branch telemetry, and mapping repairs all advance it without a user or
 * agent turn. OpenCode's scoped session snapshot records conversation activity,
 * so it is the only safe source for a "last activity" label. A session without
 * a snapshot falls back to creation time rather than inventing activity. */
export function sessionLastActivityAt(session: ProjectSession): string {
  let latestActivityMs: number | null = null;
  for (const openCodeSession of session.opencode_sessions ?? []) {
    const activityMs = openCodeSession.updated_at;
    if (typeof activityMs !== 'number' || !Number.isFinite(activityMs)) continue;
    const parsed = new Date(activityMs).getTime();
    if (!Number.isFinite(parsed)) continue;
    latestActivityMs = latestActivityMs === null ? parsed : Math.max(latestActivityMs, parsed);
  }
  return latestActivityMs === null ? session.created_at : new Date(latestActivityMs).toISOString();
}

/** Newest-first sort by conversation activity. */
export function sortSessionsByLastActivity(sessions: ProjectSession[]): ProjectSession[] {
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
export function getSessionDisplayTitle(session: ProjectSession): string {
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
 *  the early-return ladder in `ProjectSessionList`: loading and error both
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
