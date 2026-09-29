import {
  sessionHasTitle,
  sessionLastActivityAt,
  type ChangeRequest,
  type ProjectSession,
  type ProjectSessionStatus,
} from '@kortix/sdk';

/**
 * The web-only decisions of the session lists, unit-testable without mounting
 * react-query or the row components: when to keep polling, how change requests
 * attach to sessions, and the newest-activity sort. Titles, last activity,
 * relative time, view state, and starter sections are `@kortix/sdk`'s
 * (`sessionDisplayTitle`, `sessionLastActivityAt`, `shortRelative`,
 * `sessionListViewState`, `starterSectionOf`).
 */

export const LIVE_SESSION_STATUSES: ProjectSessionStatus[] = [
  'queued',
  'branching',
  'provisioning',
];

/**
 * Index every change-request state by the session that created it.
 *
 * New records use `origin_session_id`. Older records can lack that field, so a
 * unique `head_ref` → `branch_name` match restores the association. Ambiguous
 * branches stay unassigned instead of showing a change request on the wrong
 * session.
 */
export function groupChangeRequestsBySession(
  changeRequests: readonly ChangeRequest[],
  sessions: readonly ProjectSession[],
): Map<string, ChangeRequest[]> {
  const sessionIds = new Set(sessions.map((session) => session.session_id));
  const sessionIdsByBranch = new Map<string, string[]>();

  for (const session of sessions) {
    const branch = session.branch_name?.trim();
    if (!branch) continue;
    const matches = sessionIdsByBranch.get(branch) ?? [];
    matches.push(session.session_id);
    sessionIdsByBranch.set(branch, matches);
  }

  const grouped = new Map<string, ChangeRequest[]>();
  for (const changeRequest of changeRequests) {
    let sessionId: string | undefined;
    if (changeRequest.origin_session_id && sessionIds.has(changeRequest.origin_session_id)) {
      sessionId = changeRequest.origin_session_id;
    } else if (!changeRequest.origin_session_id) {
      const branchMatches = sessionIdsByBranch.get(changeRequest.head_ref) ?? [];
      if (branchMatches.length === 1) sessionId = branchMatches[0];
    }

    if (!sessionId) continue;
    const requests = grouped.get(sessionId) ?? [];
    requests.push(changeRequest);
    grouped.set(sessionId, requests);
  }

  for (const requests of grouped.values()) {
    requests.sort((left, right) => {
      const createdDifference = Date.parse(right.created_at) - Date.parse(left.created_at);
      return createdDifference || right.number - left.number;
    });
  }

  return grouped;
}

/** Whether the session list should keep polling — true while any session is
 *  still mid-provisioning (queued/branching/provisioning). */
export function shouldPollProjectSessions(sessions: ProjectSession[] | undefined): boolean {
  return (sessions ?? []).some((session) => LIVE_SESSION_STATUSES.includes(session.status));
}

/** Fast poll: a provisioning session changes status within seconds. */
const PROVISIONING_POLL_MS = 5_000;
/**
 * Poll while a session has no name yet. Matched to the title generator's own
 * budget: `DEFAULT_GENERATION_TIMEOUT_MS` is 15s for at most two bounded gateway
 * calls, so a 3s poll converges the three surfaces within one tick of the write
 * instead of leaving them to disagree for up to a minute.
 */
const PENDING_TITLE_POLL_MS = 3_000;
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
 * reloaded, no matter how long you work in it. A project page with no session
 * open generates no activity, so it polls nothing.
 */
export function projectSessionsRefetchInterval(params: {
  sessions: ProjectSession[] | undefined;
  hasOpenSession: boolean;
  /** Injected so the title window below is asserted rather than raced. */
  now?: number;
}): number | false {
  if (shouldPollProjectSessions(params.sessions)) return PROVISIONING_POLL_MS;
  // A title the server has not written yet. This is the ONLY case where the
  // client knows something is coming and has no way to be told it arrived —
  // see `sessionHasTitle` in `@kortix/sdk`. It outranks the open-session interval because
  // that one is 60s, four times the title generator's own 15s timeout: the
  // header sat on "New session" for most of a minute after the name existed.
  //
  // Bounded twice, because either bound alone leaks. By the CONDITION: the
  // moment every session has a name this falls through to the intervals below,
  // so a settled project page polls nothing. And by AGE
  // (`TITLE_WAIT_WINDOW_MS`): a session that is never prompted is never named,
  // and without the window one abandoned row would poll at 3s forever.
  if (hasSessionAwaitingTitle(params.sessions, params.now ?? Date.now())) {
    return PENDING_TITLE_POLL_MS;
  }
  return params.hasOpenSession ? OPEN_SESSION_POLL_MS : false;
}

/** Newest-first sort by the SDK's `sessionLastActivityAt`. */
export function sortSessionsByLastActivity(sessions: ProjectSession[]): ProjectSession[] {
  const at = new Map(sessions.map((session) => [session.session_id, sessionLastActivityAt(session)]));
  return sessions.slice().sort((a, b) => at.get(b.session_id)! - at.get(a.session_id)!);
}

/**
 * How long after creation a missing title is still worth waiting for.
 *
 * A session is named off its FIRST PROMPT. Create one and never prompt it and
 * no name is ever written — so "untitled" on its own is not evidence that
 * anything is coming, and treating it as such would put a project page holding
 * one abandoned session into a permanent 3s poll.
 *
 * 2 minutes is deliberately loose against the generator's 15s budget: it has to
 * cover the create → first-prompt gap for a user who types slowly, and the cost
 * of being generous is a few extra requests on a page that was just opened.
 */
const TITLE_WAIT_WINDOW_MS = 2 * 60_000;

/**
 * Is this session still plausibly waiting for a title the server will write?
 *
 * Fails CLOSED on an unknown age: an unparseable or missing `created_at` cannot
 * be proven young, and guessing wrong in that direction is the unbounded poll
 * this window exists to prevent.
 *
 * The window opens from the LATER of creation and last activity. An adopted
 * warm session was created when the user landed on the project home —
 * possibly long before the send — but its title generation starts at the
 * first prompt, i.e. at adoption, which stamps `metadata.last_activity_at`
 * (apps/api/src/projects/routes/warm-sessions.ts). Windowing on `created_at`
 * alone skipped the fast poll for exactly the sessions the home send
 * produces.
 */
export function isAwaitingTitle(session: ProjectSession, now: number): boolean {
  if (sessionHasTitle(session)) return false;
  const createdAt = Date.parse((session as { created_at?: string | null }).created_at ?? '');
  if (!Number.isFinite(createdAt)) return false;
  // The API's prompt stamp; `metadata` is jsonb, so prove its shape.
  const stamp = session.metadata?.last_activity_at;
  const promptAt = typeof stamp === 'number' ? stamp : Date.parse(typeof stamp === 'string' ? stamp : '');
  const windowStart = Number.isFinite(promptAt) ? Math.max(createdAt, promptAt) : createdAt;
  return now - windowStart <= TITLE_WAIT_WINDOW_MS;
}

/** Is any session in the list still waiting for its title? */
export function hasSessionAwaitingTitle(
  sessions: ProjectSession[] | undefined,
  now: number,
): boolean {
  return (sessions ?? []).some((session) => isAwaitingTitle(session, now));
}
