import type { ProjectInput } from '@kortix/sdk';

/**
 * What the Edit-project modal sends, derived from what the user actually
 * changed.
 *
 * This is its own module because the modal needs the SAME answer twice, and
 * the two used to be computed separately: once to decide whether Save is
 * enabled, and once to build the request body. Two derivations of "did this
 * change?" drift — the old modal compared only the name, so changing the emoji
 * alone left Save disabled.
 *
 * The icon is the reason this cannot be a naive object spread. `PATCH
 * /v1/projects/:projectId` reads THREE states off `icon`, and only the body can
 * tell them apart (`apps/api/src/projects/routes/r5.ts`):
 *
 *   - key absent  → the stored icon is left alone
 *   - `null`      → the stored icon is removed
 *   - `'🚀'`      → the stored icon is replaced
 *
 * So an unchanged icon must produce a body with NO `icon` key at all, while a
 * removed icon must produce one whose `icon` key is present and null. Sending
 * `icon: null` on every save would wipe the emoji of anyone who only renamed.
 */
export interface ProjectEditSubject {
  /** The project's stored name. */
  name?: string;
  /** The project's stored emoji, or null/undefined when it has none. */
  icon?: string | null;
}

export interface ProjectEditDraft {
  /** The name input's raw value — trimmed here, not by the caller. */
  name: string;
  /** The icon field's value. `null` is "no icon", either never set or removed. */
  icon: string | null;
}

export type ProjectEditPatch =
  /** The name was emptied. Nothing is savable: a project must have a name. */
  | { status: 'empty-name' }
  /** Nothing differs from the stored project. */
  | { status: 'unchanged' }
  /** The body to PATCH — only the members that actually changed. */
  | { status: 'ready'; patch: Partial<ProjectInput> };

export function buildProjectEditPatch(
  subject: ProjectEditSubject,
  draft: ProjectEditDraft,
): ProjectEditPatch {
  const name = draft.name.trim();
  // Checked before the diff, not after: emptying the name while ALSO picking a
  // new emoji is still unsavable, and a status of 'ready' carrying no name
  // would silently save the emoji and leave the empty name behind.
  if (!name) return { status: 'empty-name' };

  const patch: Partial<ProjectInput> = {};

  if (name !== (subject.name ?? '').trim()) patch.name = name;

  // `?? null` on both sides so an absent stored icon (undefined) and a cleared
  // draft (null) compare equal — otherwise opening the modal on a project with
  // no icon and touching nothing would send `icon: null` and count as a change.
  const storedIcon = subject.icon ?? null;
  const draftIcon = draft.icon ?? null;
  // Assignment, not a spread: `patch.icon = null` puts the key on the object,
  // which is exactly the difference between "remove it" and "leave it alone".
  if (draftIcon !== storedIcon) patch.icon = draftIcon;

  if (Object.keys(patch).length === 0) return { status: 'unchanged' };
  return { status: 'ready', patch };
}

/**
 * What the success toast says, derived from the patch that was actually sent.
 *
 * The old modal always said `Renamed to "…"`, which stops being true the moment
 * the same modal can also change or remove an emoji. Deriving the sentence from
 * the patch is what keeps it honest: there is exactly one source for "what did
 * this save do?", and it is the same object the request carried.
 *
 * `savedName` comes from the API response rather than the draft, so a name the
 * server normalised is the one the user is told about.
 */
export function summarizeProjectEdit(patch: Partial<ProjectInput>, savedName: string): string {
  // The rename is the headline when both changed: it is the thing the user
  // reads on the card, and the icon change is visible right beside it.
  if (patch.name) return `Renamed to "${savedName}"`;
  // `=== null` and not `!patch.icon`: an absent key is not a removal, and this
  // function is reached with the icon key absent whenever only the name moved.
  if (patch.icon === null) return 'Project icon removed';
  if (patch.icon) return 'Project icon updated';
  // Unreachable from `status: 'ready'`, which never returns an empty patch —
  // but a toast that says nothing is worse than one that says something dull.
  return 'Project updated';
}
