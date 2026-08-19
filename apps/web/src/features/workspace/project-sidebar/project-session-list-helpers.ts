import type { ProjectSession, ProjectSessionStatus } from '@kortix/sdk';

/**
 * Pure helpers extracted from `project-session-list.tsx` so every decision the
 * sidebar session list makes is unit-testable without mounting react-query or
 * the row components. Five decisions live here:
 *
 * - when to keep polling (`shouldPollProjectSessions`);
 * - what "last activity" means and how to sort by it
 *   (`sessionLastActivityAt`, `sortSessionsByLastActivity`) — the same value
 *   the sidebar's date sections bucket on, see `session-grouping.ts`;
 * - what a row is titled, and how its timestamp is abbreviated
 *   (`getSessionDisplayTitle`, `shortRelative`);
 * - which of loading/error/empty/no-matches/content renders
 *   (`resolveSessionListViewState`).
 *
 * Display status itself is NOT decided here — `sessionDisplayStatus` in
 * `components/projects/session-label` owns that mapping, and this file reads it.
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
  // see `sessionTitleHasLanded`. It outranks the open-session interval because
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
 * (`apps/api/src/projects/session-activity.ts`), so it needs no sandbox
 * round-trip and cannot silently go missing the way the snapshot below can. */
function promptActivityMs(session: ProjectSession): number | null {
  return activityMs((session.metadata as Record<string, unknown> | null)?.last_activity_at);
}

/** Newest conversation update in OpenCode's scoped session snapshot, or null
 *  when the session carries no usable snapshot. */
function conversationActivityMs(session: ProjectSession): number | null {
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
export function sessionLastActivityAt(session: ProjectSession): string {
  const prompt = promptActivityMs(session);
  const conversation = conversationActivityMs(session);
  if (prompt !== null || conversation !== null) {
    return new Date(Math.max(prompt ?? -Infinity, conversation ?? -Infinity)).toISOString();
  }
  return session.updated_at || session.created_at;
}

/** Newest-first sort by `sessionLastActivityAt`. */
export function sortSessionsByLastActivity(sessions: ProjectSession[]): ProjectSession[] {
  return sessions.slice().sort((a, b) => {
    const parsedA = new Date(sessionLastActivityAt(a)).getTime();
    const parsedB = new Date(sessionLastActivityAt(b)).getTime();
    const aTime = Number.isFinite(parsedA) ? parsedA : 0;
    const bTime = Number.isFinite(parsedB) ? parsedB : 0;
    return bTime - aTime;
  });
}

/** What a row shows before the server has written any name for the session. */
export const UNTITLED_SESSION_LABEL = 'New session';

/**
 * The session's real name, or null while the server has not written one.
 *
 * The single resolver behind BOTH `getSessionDisplayTitle` (what the row
 * renders) and `sessionTitleHasLanded` (whether to keep polling for it). They
 * must not be two implementations: a predicate that reported "titled" while the
 * row still showed the placeholder would stop the poll with the UI wrong, which
 * is the failure mode being fixed here rather than a new one to introduce.
 *
 * Precedence: user rename (`custom_name`) → server name → legacy
 * `metadata.session_name`.
 */
function resolveSessionTitle(session: ProjectSession): string | null {
  const legacyMetadataName =
    typeof session.metadata?.session_name === 'string'
      ? (session.metadata.session_name as string)
      : null;
  return (
    session.custom_name?.trim() || session.name?.trim() || legacyMetadataName?.trim() || null
  );
}

/**
 * Has the server-generated title arrived for this session yet?
 *
 * `generateSessionTitleFromFirstPrompt` (apps/api) writes `metadata.name`
 * fire-and-forget, 3–15s after the first prompt, and emits nothing — no SSE
 * event, no invalidation. The browser's live event stream comes from opencode
 * INSIDE the sandbox, so the API has no channel on which to announce it. This
 * predicate is therefore the only signal a client has, and it is what bounds
 * the fast poll in `projectSessionsRefetchInterval`.
 */
export function sessionTitleHasLanded(session: ProjectSession): boolean {
  return resolveSessionTitle(session) !== null;
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
  if (sessionTitleHasLanded(session)) return false;
  const createdAt = Date.parse(
    (session as { created_at?: string | null }).created_at ?? '',
  );
  if (!Number.isFinite(createdAt)) return false;
  const windowStart = Math.max(createdAt, promptActivityMs(session) ?? createdAt);
  return now - windowStart <= TITLE_WAIT_WINDOW_MS;
}

/** Is any session in the list still waiting for its title? */
export function hasSessionAwaitingTitle(
  sessions: ProjectSession[] | undefined,
  now: number,
): boolean {
  return (sessions ?? []).some((session) => isAwaitingTitle(session, now));
}

/**
 * Display title for a session row. Precedence: user rename (custom_name) →
 * server name → legacy metadata.session_name → the untitled placeholder.
 */
export function getSessionDisplayTitle(session: ProjectSession): string {
  // Untitled (the real title lands seconds after the first prompt): a humane
  // static label beats a raw branch-hash slice in the sidebar.
  return resolveSessionTitle(session) ?? UNTITLED_SESSION_LABEL;
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

/** A coordinator (or standalone) session plus the sessions it spawned. */
export interface SessionGroup {
  session: ProjectSession;
  children: ProjectSession[];
}

/**
 * Fold a flat, already-sorted session list into coordinator groups: a session
 * spawned by another session in the list (metadata.spawned_by_session) nests
 * under it — the sidebar renders the coordinator as a folder and its children
 * as files. A child whose coordinator is absent (deleted, other project, or a
 * stale stamp) stays top-level rather than disappearing.
 */
export function groupSessionsByCoordinator(sessions: ProjectSession[]): SessionGroup[] {
  const present = new Set(sessions.map((s) => s.session_id));
  const parentOf = (session: ProjectSession): string | null => {
    const meta = (session.metadata ?? {}) as Record<string, unknown>;
    const parent = typeof meta.spawned_by_session === 'string' ? meta.spawned_by_session : null;
    return parent && present.has(parent) && parent !== session.session_id ? parent : null;
  };
  const groups = new Map<string, SessionGroup>();
  const order: SessionGroup[] = [];
  for (const session of sessions) {
    if (parentOf(session)) continue;
    const group = { session, children: [] as ProjectSession[] };
    groups.set(session.session_id, group);
    order.push(group);
  }
  for (const session of sessions) {
    const parent = parentOf(session);
    if (parent) groups.get(parent)?.children.push(session);
  }
  return order;
}
