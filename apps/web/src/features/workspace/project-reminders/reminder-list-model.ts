import type { ProjectReminder, SessionReminderState } from '@kortix/sdk';

const time = (iso: string | null | undefined) => {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? at : null;
};

/** Ascending by a time; a missing time sorts last. */
const byTime =
  (pick: (reminder: ProjectReminder) => string | null | undefined, direction: 1 | -1) =>
  (a: ProjectReminder, b: ProjectReminder) => {
    const left = time(pick(a));
    const right = time(pick(b));
    if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
    return (left - right) * direction;
  };

/**
 * One tab's rows, in reading order: active by the next fire (soonest first),
 * done by the last fire (latest first), paused by creation (newest first —
 * there is no paused-at timestamp).
 */
export function rowsForTab(
  reminders: readonly ProjectReminder[],
  tab: SessionReminderState,
): ProjectReminder[] {
  const rows = reminders.filter((reminder) => reminder.state === tab);
  if (tab === 'active') return rows.sort(byTime((r) => r.next_fire_at, 1));
  if (tab === 'done') return rows.sort(byTime((r) => r.last_fired_at, -1));
  return rows.sort(byTime((r) => r.created_at, -1));
}

/**
 * The selection after a checkbox press on `id`. A plain press toggles one
 * row. A shift-press sets every row from `anchor` (the last pressed row) to
 * `id` to the pressed row's new state, the way file lists do. Pure.
 */
export function toggleSelection(
  selected: ReadonlySet<string>,
  ids: readonly string[],
  id: string,
  anchor: string | null,
): Set<string> {
  const next = new Set(selected);
  const on = !selected.has(id);
  const from = anchor === null ? -1 : ids.indexOf(anchor);
  const to = ids.indexOf(id);
  const range =
    from === -1 || to === -1 ? [id] : ids.slice(Math.min(from, to), Math.max(from, to) + 1);
  for (const each of range) {
    if (on) next.add(each);
    else next.delete(each);
  }
  return next;
}

/** The header checkbox: none, some or all of the rows on screen are selected. */
export function selectionState(selected: ReadonlySet<string>, ids: readonly string[]) {
  const count = ids.filter((id) => selected.has(id)).length;
  return count === 0 ? 'none' : count === ids.length ? 'all' : 'some';
}
