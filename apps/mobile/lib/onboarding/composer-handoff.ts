/**
 * Project home opens with the composer focused, once per request:
 *   - `/new` → project home (COR-161): after the first project is created.
 *   - the project drawer's New session: project home is usually mounted
 *     already (under the drawer or a covering route), so it subscribes and
 *     takes the request when it arrives.
 * The starter prompt, if one was picked on `/new`, goes through the persisted
 * draft store instead (`stores/composer-draft-store.ts`, key `project:<id>`),
 * which the home composer restores on mount.
 *
 * One-shot: `takeComposerFocus` returns true once per `markComposerFocus`,
 * so a later remount of project home (back from a thread) does not pop the
 * keyboard again. In memory only — a cold start never focuses. Pure, tested
 * in composer-handoff.test.ts.
 */

const pending = new Set<string>();
const listeners = new Set<(projectId: string) => void>();

/** The next project home for `projectId` opens with the composer focused. */
export function markComposerFocus(projectId: string): void {
  pending.add(projectId);
  for (const listener of listeners) listener(projectId);
}

/** True once after `markComposerFocus(projectId)`; false otherwise. */
export function takeComposerFocus(projectId: string): boolean {
  return pending.delete(projectId);
}

/** Calls `listener` on every `markComposerFocus`. Returns the unsubscribe. */
export function subscribeComposerFocus(listener: (projectId: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
