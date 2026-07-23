import type { ProjectSession, ProjectSessionStatus } from '@kortix/sdk/projects-client';

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

/**
 * How long a freshly-created, still-untitled session keeps the list polling
 * once it's past provisioning — long enough for the harness-emitted title
 * (claude-agent-acp) or the first-prompt fallback (every other harness) to
 * land, short enough that an abandoned/long-idle session doesn't poll
 * forever. See ../../../../apps/api/src/projects/lib/acp-session-title.ts
 * for the server-side write path this is waiting on.
 */
export const UNTITLED_SESSION_POLL_WINDOW_MS = 3 * 60 * 1000;

/** Whether the session list should keep polling. True while any session is
 *  still mid-provisioning (queued/branching/provisioning) — status alone. Also
 *  true for a session that is past provisioning but still has NO title
 *  (`name` unset — neither a harness title nor the first-prompt fallback has
 *  landed yet) and is within `UNTITLED_SESSION_POLL_WINDOW_MS` of creation:
 *  without this, a session's status routinely settles to 'running' seconds
 *  before its title exists, so polling would already have stopped by the time
 *  the title could ever show up — the exact "sidebar frozen on New session"
 *  symptom this closes. */
export function shouldPollProjectSessions(sessions: ProjectSession[] | undefined): boolean {
  const now = Date.now();
  return (sessions ?? []).some((session) => {
    if (LIVE_SESSION_STATUSES.includes(session.status)) return true;
    if (session.name) return false;
    const age = now - new Date(session.created_at).getTime();
    return age >= 0 && age < UNTITLED_SESSION_POLL_WINDOW_MS;
  });
}

/** Newest-first sort by `created_at`. Extracted so the ordering rule (and its
 *  stability for equal timestamps) is independently testable. */
export function sortSessionsByCreatedAt(sessions: ProjectSession[]): ProjectSession[] {
  return sessions
    .slice()
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
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
