/**
 * Pure state transitions for the Review Center inbox. Kept free of React so the
 * decision logic (the part worth getting right — bulk approve, roll-up to a final
 * status, filtering) is unit-testable in isolation. The component holds the items
 * in state and calls these to produce the next array.
 */

import {
  type ApprovalAction,
  type ReviewItem,
  type ReviewKind,
  type ReviewSegment,
  type ReviewStatus,
  isSafeRisk,
  segmentForStatus,
} from './types';

/**
 * Once every action in an approval has been decided, the item rolls up to a
 * terminal status: approved if at least one was approved, otherwise rejected.
 * Returns null while any action is still pending.
 */
export function rollupApprovalStatus(actions: ApprovalAction[]): 'approved' | 'rejected' | null {
  if (actions.length === 0) return null;
  if (!actions.every((a) => a.decided)) return null;
  return actions.some((a) => a.decided === 'approved') ? 'approved' : 'rejected';
}

/** Set an item's status outright (ship, answer, request changes, deny-all, …). */
export function setStatus(items: ReviewItem[], id: string, status: ReviewStatus): ReviewItem[] {
  return items.map((i) => (i.id === id ? ({ ...i, status } as ReviewItem) : i));
}

/** Approve or deny a single action inside an approval, rolling up if complete. */
export function decideApprovalAction(
  items: ReviewItem[],
  itemId: string,
  actionId: string,
  decision: 'approved' | 'denied',
): ReviewItem[] {
  return items.map((i) => {
    if (i.id !== itemId || i.kind !== 'approval') return i;
    const actions = i.detail.actions.map((a) =>
      a.id === actionId ? { ...a, decided: decision } : a,
    );
    return { ...i, detail: { actions }, status: rollupApprovalStatus(actions) ?? i.status };
  });
}

/** Approve every still-pending safe (none/low-risk) action; risky ones untouched. */
export function approveAllSafe(items: ReviewItem[], itemId: string): ReviewItem[] {
  return items.map((i) => {
    if (i.id !== itemId || i.kind !== 'approval') return i;
    const actions = i.detail.actions.map((a) =>
      isSafeRisk(a.risk) && !a.decided ? { ...a, decided: 'approved' as const } : a,
    );
    return { ...i, detail: { actions }, status: rollupApprovalStatus(actions) ?? i.status };
  });
}

/** Count of pending safe actions across the given items (drives the bulk bar). */
export function safePendingCount(items: ReviewItem[]): number {
  return items.reduce(
    (n, i) =>
      n +
      (i.kind === 'approval'
        ? i.detail.actions.filter((a) => isSafeRisk(a.risk) && !a.decided).length
        : 0),
    0,
  );
}

/** How many items sit in each inbox segment. */
export function countsBySegment(items: ReviewItem[]): Record<ReviewSegment, number> {
  const counts: Record<ReviewSegment, number> = { needs_you: 0, waiting: 0, done: 0 };
  for (const i of items) counts[segmentForStatus(i.status)] += 1;
  return counts;
}

/** True if the free-text query matches an item's title / summary / project / agent. */
export function matchesQuery(item: ReviewItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${item.title} ${item.summary} ${item.project} ${item.agent}`.toLowerCase().includes(q);
}

/** Items visible for the current segment + kind + query + optional session. */
export function filterItems(
  items: ReviewItem[],
  segment: ReviewSegment,
  kind: ReviewKind | 'all',
  query = '',
  sessionFilter: string | 'all' = 'all',
): ReviewItem[] {
  return items.filter(
    (i) =>
      segmentForStatus(i.status) === segment &&
      (kind === 'all' || i.kind === kind) &&
      (sessionFilter === 'all' || (i.sessionId ?? '') === sessionFilter) &&
      matchesQuery(i, query),
  );
}

/** One "group by session" bucket. `sessionId === null` is the catch-all for
 *  items with no originating session (e.g. a project-level submission). */
export interface SessionGroup {
  sessionId: string | null;
  label: string;
  items: ReviewItem[];
}

/** Resolve a session id → human label, falling back to a short id. */
function sessionLabel(sessionId: string, labelFor: (id: string) => string | undefined): string {
  return labelFor(sessionId) ?? `Session ${sessionId.slice(0, 8)}`;
}

/**
 * Group items by their originating session — newest-activity first, with the
 * "No session" bucket always last. Reviews and approvals for a session end up
 * side by side under one header. `labelFor` resolves a session id to its name.
 */
export function groupBySession(
  items: ReviewItem[],
  labelFor: (sessionId: string) => string | undefined,
): SessionGroup[] {
  const byId = new Map<string | null, ReviewItem[]>();
  for (const i of items) {
    const key = i.sessionId ?? null;
    const list = byId.get(key);
    if (list) list.push(i);
    else byId.set(key, [i]);
  }
  const newest = (list: ReviewItem[]) =>
    list.reduce((m, i) => (i.createdAt > m ? i.createdAt : m), '');
  return [...byId.entries()]
    .map(([sessionId, list]) => ({
      sessionId,
      label: sessionId === null ? 'No session' : sessionLabel(sessionId, labelFor),
      items: list,
    }))
    .sort((a, b) => {
      if (a.sessionId === null) return 1; // "No session" sinks last
      if (b.sessionId === null) return -1;
      return newest(b.items).localeCompare(newest(a.items));
    });
}

/** Distinct sessions present across items (for the session-filter dropdown),
 *  each with a resolved label, ordered by newest activity. */
export function sessionOptions(
  items: ReviewItem[],
  labelFor: (sessionId: string) => string | undefined,
): { sessionId: string; label: string }[] {
  return groupBySession(items, labelFor)
    .filter((g): g is SessionGroup & { sessionId: string } => g.sessionId !== null)
    .map((g) => ({ sessionId: g.sessionId, label: g.label }));
}

/** Set the same status on many items at once (multi-select bulk approve / dismiss). */
export function bulkSetStatus(
  items: ReviewItem[],
  ids: Iterable<string>,
  status: ReviewStatus,
): ReviewItem[] {
  const set = ids instanceof Set ? ids : new Set(ids);
  return items.map((i) => (set.has(i.id) ? ({ ...i, status } as ReviewItem) : i));
}
