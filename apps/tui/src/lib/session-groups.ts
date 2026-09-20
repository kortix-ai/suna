/**
 * Turning a page of `ProjectSession` rows into the sidebar's tree.
 *
 * Two independent shapes compose here, exactly as they do in `apps/web`'s
 * sidebar (`project-session-list.tsx`):
 *
 *   1. day sections — `Today`, `Yesterday`, a weekday inside the last week,
 *      then the ISO date;
 *   2. spawn nesting — a session started BY another session renders one level
 *      in under it.
 *
 * Everything here is pure and takes `now` as a parameter, so a test pins the
 * clock instead of racing it.
 */

import { type ProjectSessionMetadata, sessionParentId } from '@kortix/sdk';

/** The fields of `ProjectSession` this module reads. A real `ProjectSession`
 *  satisfies it structurally; a test fixture can be three lines. */
export interface SessionLike {
  session_id: string;
  /** Resolved display name the API computes (custom name → runtime title → generated). */
  name?: string | null;
  /** The user's own override. Wins over `name` when set. */
  custom_name?: string | null;
  branch_name?: string;
  status?: string;
  metadata?: ProjectSessionMetadata | null;
  opencode_sessions?: readonly { updated_at?: number | null }[] | null;
  updated_at?: string;
  created_at?: string;
}

/** One session row, with the indent level the sidebar draws it at. */
export interface SessionRow<T extends SessionLike = SessionLike> {
  session: T;
  /** 0 for a root session, 1 for a session spawned by one. */
  depth: 0 | 1;
}

/** One day section: a label and the rows under it, newest first. */
export interface SessionDayGroup<T extends SessionLike = SessionLike> {
  /** `Today`, `Yesterday`, `Wednesday`, or `2026-08-14`. */
  label: string;
  rows: SessionRow<T>[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** Printed when a session has no name yet — the title lands seconds after the
 *  first prompt, and a branch UUID slice is worse than a humane placeholder. */
export const UNTITLED_SESSION = 'Untitled';

/** Epoch ms from an ISO string or an epoch-ms number; null when neither.
 *  `metadata` is jsonb, so its values arrive as `unknown` and must be proven. */
function timestampMs(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * When this session was last really used, newest evidence first.
 *
 * Same precedence `apps/web` uses (`sessionLastActivityAt`), for the same
 * reasons: the API's prompt stamp lands before the turn runs, the OpenCode
 * conversation snapshot keeps advancing while the agent replies, and row
 * bookkeeping (`updated_at`) is only a fallback because a runtime stop or a
 * title sync advances it without anyone having used the session.
 */
export function sessionActivityMs(session: SessionLike): number {
  const prompt = timestampMs(session.metadata?.last_activity_at);
  let conversation: number | null = null;
  for (const snapshot of session.opencode_sessions ?? []) {
    const parsed = timestampMs(snapshot?.updated_at);
    if (parsed === null) continue;
    conversation = conversation === null ? parsed : Math.max(conversation, parsed);
  }
  if (prompt !== null || conversation !== null) {
    return Math.max(prompt ?? Number.NEGATIVE_INFINITY, conversation ?? Number.NEGATIVE_INFINITY);
  }
  return timestampMs(session.updated_at) ?? timestampMs(session.created_at) ?? 0;
}

/** What the row is called. */
export function sessionTitle(session: SessionLike): string {
  const custom = session.custom_name?.trim();
  if (custom) return custom;
  const name = session.name?.trim();
  if (name) return name;
  return UNTITLED_SESSION;
}

/** Midnight of the local calendar day containing `ms`. Local components, not
 *  UTC: "Today" means today on this terminal's clock. */
function startOfLocalDay(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function isoDate(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * The section header a timestamp belongs under.
 *
 * Calendar days, not rolling 24h windows: a session from 23:50 last night is
 * `Yesterday` at 00:10, not `12m ago`. A future timestamp (clock skew) reads
 * `Today` instead of falling out of every bucket.
 */
export function dayLabel(ms: number, nowMs: number): string {
  const today = startOfLocalDay(nowMs);
  const that = startOfLocalDay(ms);
  const daysBack = Math.round((today - that) / DAY_MS);
  if (daysBack <= 0) return 'Today';
  if (daysBack === 1) return 'Yesterday';
  if (daysBack < 7) return WEEKDAYS[new Date(ms).getDay()] as string;
  return isoDate(ms);
}

/**
 * The session that spawned this one, when that session is on screen too.
 *
 * The link itself is the SDK's `sessionParentId` (it reads
 * `metadata.spawned_by_session`, and rejects a non-string and a self-reference
 * — `metadata` is jsonb, so a malformed row must not escape as a session id).
 * The ON-SCREEN half is the sidebar's own rule: a parent that is not in
 * `present` (an older page, or filtered out) leaves the child a root, so no row
 * is ever orphaned off-screen.
 */
export function parentSessionId(session: SessionLike, present: ReadonlySet<string>): string | null {
  const parent = sessionParentId({
    session_id: session.session_id,
    ...(session.metadata ? { metadata: session.metadata } : {}),
  });
  if (!parent || !present.has(parent)) return null;
  return parent;
}

/** Case-insensitive substring match over the displayed title. */
export function filterSessionsByTitle<T extends SessionLike>(sessions: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return sessions;
  return sessions.filter((session) => sessionTitle(session).toLowerCase().includes(needle));
}

/**
 * Sessions as day sections of indented rows, newest activity first.
 *
 * A child follows its parent inside the parent's section even when the child's
 * own activity falls on another day: the indent means "spawned by the row
 * above", and splitting the pair across two headers would break that claim.
 */
export function groupSessionsByDay<T extends SessionLike>(
  sessions: readonly T[],
  options: { now: number },
): SessionDayGroup<T>[] {
  const byActivity = sessions.slice().sort((a, b) => sessionActivityMs(b) - sessionActivityMs(a));
  const present = new Set(byActivity.map((session) => session.session_id));

  const parentOf = new Map<string, string>();
  for (const session of byActivity) {
    const parent = parentSessionId(session, present);
    if (parent) parentOf.set(session.session_id, parent);
  }

  /**
   * The nearest ancestor that is itself a root.
   *
   * The tree is only ever drawn two levels deep, so a grandchild attaches to
   * its root ancestor rather than vanishing: a row whose parent is itself a
   * child would otherwise belong to no root and never render at all.
   * The `seen` set stops a metadata cycle from looping forever.
   */
  function rootAncestor(sessionId: string): string {
    const seen = new Set<string>([sessionId]);
    let current = sessionId;
    for (;;) {
      const parent = parentOf.get(current);
      if (!parent || seen.has(parent)) return current;
      seen.add(parent);
      current = parent;
    }
  }

  const childrenOf = new Map<string, T[]>();
  const roots: T[] = [];
  for (const session of byActivity) {
    if (!parentOf.has(session.session_id)) {
      roots.push(session);
      continue;
    }
    const anchor = rootAncestor(session.session_id);
    // Only a metadata cycle can hand back an anchor that is not a root. Such a
    // row has no root to hang under, so it becomes one — a cycle must not make
    // a session disappear from the list.
    if (parentOf.has(anchor)) {
      roots.push(session);
      continue;
    }
    const siblings = childrenOf.get(anchor);
    if (siblings) siblings.push(session);
    else childrenOf.set(anchor, [session]);
  }

  const groups: SessionDayGroup<T>[] = [];
  let current: SessionDayGroup<T> | null = null;
  for (const root of roots) {
    const label = dayLabel(sessionActivityMs(root), options.now);
    if (!current || current.label !== label) {
      current = { label, rows: [] };
      groups.push(current);
    }
    current.rows.push({ session: root, depth: 0 });
    for (const child of childrenOf.get(root.session_id) ?? []) {
      current.rows.push({ session: child, depth: 1 });
    }
  }
  return groups;
}
