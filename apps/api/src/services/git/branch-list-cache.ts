/**
 * Recent upstream branch listings, for views only.
 *
 * `listBranches` asks the upstream with `git ls-remote --heads` on every call.
 * On prod that round trip is 451-1431 ms for a 2,900-branch repository and is
 * the whole cost of `GET /branches` (the local `for-each-ref` enrichment is
 * ~50 ms). The web's Files and Git views may show a listing a few seconds old;
 * CLIs, sandboxes and the change-request picker keep reading the upstream live
 * because they never opt in.
 *
 * - Fresh for 15 s: served as is.
 * - Up to 5 min: served at once, refreshed once in the background.
 * - Older, or never answered: the caller waits for the upstream.
 * - A failed listing is dropped, never served.
 * - `invalidateBranchList` (called by `invalidateProjectMirror`, so every
 *   base-branch move on any replica) drops the project's listing.
 */

const FRESH_MS = 15_000;
const MAX_STALE_MS = 5 * 60_000;
const MAX_ENTRIES = 500;

interface Entry<T> {
  projectId: string;
  at: number;
  value: Promise<T>;
  answered: boolean;
  refreshing: boolean;
}

const entries = new Map<string, Entry<unknown>>();

export function recentBranchList<T>(
  projectId: string,
  repoUrl: string,
  load: () => Promise<T>,
): Promise<T> {
  const key = `${projectId}\u0000${repoUrl}`;
  const now = Date.now();
  const hit = entries.get(key) as Entry<T> | undefined;
  if (hit && now - hit.at < FRESH_MS) return hit.value;
  if (hit?.answered && now - hit.at < MAX_STALE_MS) {
    if (!hit.refreshing) {
      hit.refreshing = true;
      load().then(
        (answer) => {
          if (entries.get(key) !== hit) return;
          entries.delete(key);
          entries.set(key, { projectId, at: Date.now(), value: Promise.resolve(answer), answered: true, refreshing: false });
        },
        () => {
          hit.refreshing = false;
        },
      );
    }
    return hit.value;
  }
  if (entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  const value = load();
  const entry: Entry<T> = { projectId, at: now, value, answered: false, refreshing: false };
  entries.delete(key);
  entries.set(key, entry as Entry<unknown>);
  value.then(
    () => {
      entry.answered = true;
    },
    () => {
      if (entries.get(key) === entry) entries.delete(key);
    },
  );
  return value;
}

export function invalidateBranchList(projectId: string): void {
  for (const [key, entry] of entries) {
    if (entry.projectId === projectId) entries.delete(key);
  }
}

export function clearBranchListCacheForTests(): void {
  entries.clear();
}
