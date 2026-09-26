/**
 * `/new` → project home hand-off (COR-161): after the first project is
 * created, its home opens with the composer focused. The starter prompt, if
 * one was picked, goes through the persisted draft store instead
 * (`stores/composer-draft-store.ts`, key `project:<id>`), which the home
 * composer restores on mount.
 *
 * One-shot: `takeComposerFocus` returns true once per `markComposerFocus`,
 * so a later remount of project home (a new session, back from a thread)
 * does not pop the keyboard again. In memory only — a cold start never
 * focuses. Pure, tested in composer-handoff.test.ts.
 */

const pending = new Set<string>();

/** The next project home for `projectId` opens with the composer focused. */
export function markComposerFocus(projectId: string): void {
  pending.add(projectId);
}

/** True once after `markComposerFocus(projectId)`; false otherwise. */
export function takeComposerFocus(projectId: string): boolean {
  return pending.delete(projectId);
}
