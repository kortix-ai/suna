/**
 * Queue undo — Clear and remove act at once and offer Undo in a toast.
 *
 * `restoreQueued` puts the removed messages back where they were in the
 * snapshot taken before the removal, and keeps whatever changed since: a
 * message queued afterwards stays (at the end), a message sent afterwards is
 * not brought back.
 */

interface QueuedLike {
  id: string;
}

export function restoreQueued<T extends QueuedLike>(
  current: readonly T[],
  snapshot: readonly T[],
  removedIds: readonly string[],
): T[] {
  const removed = new Set(removedIds);
  const currentIds = new Set(current.map((m) => m.id));
  const snapshotIds = new Set(snapshot.map((m) => m.id));
  const restored = snapshot.filter((m) => currentIds.has(m.id) || removed.has(m.id));
  const byId = new Map(current.map((m) => [m.id, m]));
  return [
    // Current objects win for messages still queued (they may have been edited).
    ...restored.map((m) => byId.get(m.id) ?? m),
    ...current.filter((m) => !snapshotIds.has(m.id)),
  ];
}

export function queueHeaderLabel(count: number): string {
  return `Up next · ${count}`;
}
