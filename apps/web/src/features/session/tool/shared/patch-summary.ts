/**
 * What a patch DID, in words a non-developer already knows.
 *
 * The row used to read `Apply Patch  4 files  +4` under a code-file glyph. Every
 * part of that is wrong for the person reading it: "apply patch" is version
 * control jargon that names the MECHANISM rather than the outcome, and the
 * mechanism is the one thing the reader neither chose nor cares about. Four new
 * `.txt` files had been created; the row said none of that.
 *
 * So the label is derived from what the patch actually contains. `apply_patch`
 * can create, edit, delete and rename in one call, and each of those is an
 * ordinary English verb:
 *
 *   all add     → Created
 *   all delete  → Deleted
 *   all move    → Renamed
 *   all update  → Edited
 *   mixed       → Changed
 *
 * "Changed" for a mixed patch is deliberately the weakest word here. A patch
 * that creates one file and deletes another has no honest single verb, and
 * inventing one ("Updated 2 files") would claim a shape the patch does not have.
 * The per-file rows below already say which is which.
 *
 * No React import: this is a pure function, and it is unit-tested as one.
 */

import { FILE_VERBS, type FileVerb } from '@/features/session/tool/shared/file-verb';

export type PatchOp = 'add' | 'update' | 'delete' | 'move';

export interface PatchVerb extends FileVerb {
  /**
   * Which glyph the row leads with. `FileCode` was wrong twice over — it says
   * "code" about files that are usually not code, and it says nothing about the
   * operation, which is the only thing this row is reporting.
   */
  icon: 'create' | 'delete' | 'edit';
}

/**
 * The words come from `file-verb.ts`, the table every file row shares; only the
 * glyph is this module's own. A patch that creates a file and a `write` that
 * creates a file did the same thing to the user's disk, so they must not reach
 * for two different words for it — and before this they each owned a private
 * copy of the vocabulary that could drift apart one edit at a time.
 */
const VERBS: Record<PatchOp, PatchVerb> = {
  add: { ...FILE_VERBS.create, icon: 'create' },
  delete: { ...FILE_VERBS.delete, icon: 'delete' },
  move: { ...FILE_VERBS.rename, icon: 'edit' },
  update: { ...FILE_VERBS.edit, icon: 'edit' },
};

const MIXED: PatchVerb = { ...FILE_VERBS.change, icon: 'edit' };

/**
 * The one verb that covers every file in the patch.
 *
 * An empty patch — the call is still streaming and no file list has arrived —
 * gets the neutral `Changed`/`Changing` rather than a guess. A file whose `type`
 * the backend did not send counts as an edit, which is what the per-file row
 * already falls back to (`PATCH_TYPE_STYLE.update`), so the two agree.
 */
export function patchVerb(types: ReadonlyArray<string | undefined>): PatchVerb {
  if (types.length === 0) return MIXED;

  const first = normalizeOp(types[0]);
  for (let i = 1; i < types.length; i++) {
    if (normalizeOp(types[i]) !== first) return MIXED;
  }
  return VERBS[first];
}

function normalizeOp(type: string | undefined): PatchOp {
  return type === 'add' || type === 'delete' || type === 'move' ? type : 'update';
}
