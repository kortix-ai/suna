import type { GlyphSelection } from '@/components/ui/glyph-picker';
import type { ProjectInput } from '@kortix/sdk';

import type { ProjectIconValue } from './project-icon-field';

/**
 * What the Edit-project modal sends, derived from what the user actually
 * changed.
 *
 * This is its own module because the modal needs the SAME answer twice, and
 * the two used to be computed separately: once to decide whether Save is
 * enabled, and once to build the request body. Two derivations of "did this
 * change?" drift — the old modal compared only the name, so changing the icon
 * alone left Save disabled.
 *
 * The icon is the reason this cannot be a naive object spread, and it got
 * harder once a project could hold a GLYPH as well as an emoji. `PATCH
 * /v1/projects/:projectId` reads THREE states off EACH of `icon` and
 * `icon_glyph`, independently, and only the body can tell them apart
 * (`apps/api/src/projects/routes/r5.ts`):
 *
 *   - key absent  → the stored value is left alone
 *   - `null`      → the stored value is removed
 *   - a value     → the stored value is replaced (and the OTHER key's stored
 *                    value is cleared server-side, even if this body never
 *                    mentions it)
 *
 * That last clause is why this is not simply "diff icon, then diff
 * icon_glyph" as two independent fields: the draft (`ProjectEditDraft.icon`)
 * is the SAME union `ProjectIconField` itself uses — `{ emoji } | { glyph } |
 * null` — never two nullable slots. Switching an emoji project to a glyph
 * must produce a patch carrying `icon_glyph` and NOTHING under `icon`, because
 * the server already clears the stored emoji the moment `icon_glyph` is
 * written; sending `icon: null` alongside it would be a pointless extra write
 * of a key nobody touched, and if this client ever held the two as separate
 * fields it would be one dropped guard away from sending "clear icon" and
 * "clear icon_glyph" as false positives on every switch between the two.
 */
export interface ProjectEditSubject {
  /** The project's stored name. */
  name?: string;
  /** The project's stored emoji, or null/undefined when it has none. */
  icon?: string | null;
  /** The project's stored glyph, or null/undefined when it has none. At most
   *  one of `icon` / `icon_glyph` is ever set on a real project — see the
   *  module doc comment — but both are read here independently so a removal
   *  always targets the key that was actually holding a value. */
  icon_glyph?: GlyphSelection | null;
}

export interface ProjectEditDraft {
  /** The name input's raw value — trimmed here, not by the caller. */
  name: string;
  /** The icon field's current value — `ProjectIconField`'s own union.
   *  `null` is "no icon", either never set or removed by the field's
   *  Remove-icon control. */
  icon: ProjectIconValue;
}

export type ProjectEditPatch =
  /** The name was emptied. Nothing is savable: a project must have a name. */
  | { status: 'empty-name' }
  /** Nothing differs from the stored project. */
  | { status: 'unchanged' }
  /** The body to PATCH — only the members that actually changed. */
  | { status: 'ready'; patch: Partial<ProjectInput> };

function sameGlyph(a: GlyphSelection | null, b: GlyphSelection | null): boolean {
  return a === b || (!!a && !!b && a.name === b.name && a.color === b.color);
}

export function buildProjectEditPatch(
  subject: ProjectEditSubject,
  draft: ProjectEditDraft,
): ProjectEditPatch {
  const name = draft.name.trim();
  // Checked before the diff, not after: emptying the name while ALSO picking a
  // new icon is still unsavable, and a status of 'ready' carrying no name
  // would silently save the icon and leave the empty name behind.
  if (!name) return { status: 'empty-name' };

  const patch: Partial<ProjectInput> = {};

  if (name !== (subject.name ?? '').trim()) patch.name = name;

  // `?? null` so an absent stored value (undefined) and an unset draft
  // (null) compare equal — otherwise opening the modal on a project with no
  // icon and touching nothing would send a spurious `icon: null`.
  const storedEmoji = subject.icon ?? null;
  const storedGlyph = subject.icon_glyph ?? null;
  const draftEmoji = draft.icon && 'emoji' in draft.icon ? draft.icon.emoji : null;
  const draftGlyph = draft.icon && 'glyph' in draft.icon ? draft.icon.glyph : null;

  if (draftGlyph) {
    // The draft's choice is a glyph. Send `icon_glyph` only if it actually
    // changed — comparing name AND colour, since either alone is a different
    // glyph. `icon` is left untouched here, on purpose: this client is
    // INCAPABLE of also writing `icon: null` in this branch (there is no code
    // path that could set it), which is what makes "switching an emoji
    // project to a glyph" send exactly one key.
    if (!sameGlyph(draftGlyph, storedGlyph)) patch.icon_glyph = draftGlyph;
  } else if (draftEmoji) {
    if (draftEmoji !== storedEmoji) patch.icon = draftEmoji;
  } else {
    // The draft holds neither — "no icon" (never set, or removed via the
    // field's Remove-icon control). Clear whichever of the two was actually
    // stored; the other key stays absent, because "leave alone" is already
    // true for a value that was never there.
    if (storedEmoji !== null) patch.icon = null;
    if (storedGlyph !== null) patch.icon_glyph = null;
  }

  if (Object.keys(patch).length === 0) return { status: 'unchanged' };
  return { status: 'ready', patch };
}

/**
 * What the success toast says, derived from the patch that was actually sent.
 *
 * The old modal always said `Renamed to "…"`, which stops being true the
 * moment the same modal can also change or remove an icon. Deriving the
 * sentence from the patch is what keeps it honest: there is exactly one
 * source for "what did this save do?", and it is the same object the request
 * carried.
 *
 * `savedName` comes from the API response rather than the draft, so a name the
 * server normalised is the one the user is told about.
 */
export function summarizeProjectEdit(patch: Partial<ProjectInput>, savedName: string): string {
  // The rename is the headline when both changed: it is the thing the user
  // reads on the card, and the icon change is visible right beside it.
  if (patch.name) return `Renamed to "${savedName}"`;
  // `=== null` and not `!patch.icon`: an absent key is not a removal, and this
  // function is reached with both icon keys absent whenever only the name
  // moved.
  if (patch.icon === null || patch.icon_glyph === null) return 'Project icon removed';
  if (patch.icon || patch.icon_glyph) return 'Project icon updated';
  // Unreachable from `status: 'ready'`, which never returns an empty patch —
  // but a toast that says nothing is worse than one that says something dull.
  return 'Project updated';
}
