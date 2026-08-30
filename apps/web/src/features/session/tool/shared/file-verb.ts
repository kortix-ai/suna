/**
 * What a call DID to a file, in the tense the row is actually in.
 *
 * Every other surface in this feature already speaks this way. `step-label.ts`
 * turns a part into `Wrote` / `Writing`, `activity-file-chips.tsx` labels a run
 * of writes `Wrote 3 files`, `narration.ts` narrates the panel, and
 * `patch-summary.ts` derives a patch's verb from what the patch contains. The
 * `BasicTool` trigger was the one surface left speaking machine: `write`
 * rendered the literal registry key `Write`, and `edit` rendered `Editing`
 * forever — present participle on a transcript from last week, which is the
 * whole reason a settled row read as a paused one.
 *
 * So the trigger joins the others rather than growing a sixth copy of the
 * grammar: this module is the table, and `patch-summary.ts` reads it too.
 *
 * Three tenses, because a row has three things it can honestly say:
 *
 *   running — the call is in flight and the input is still arriving
 *   done    — the call settled and did what the verb says
 *   failed  — the call settled and did NOT do what the verb says
 *
 * `failed` is not decoration. `group-steps.ts` already forbids a failed step
 * from wearing success wording ("Wrote budget.csv" for a write that errored is
 * the panel lying, W7) and routes it through `narrateFailedStep`. The trigger
 * had no such route: it flipped its icon to a warning and kept claiming the
 * write landed. The wording here is `narration.ts:805` character for character
 * — `write` for a write, `update` for an edit — so the row and the panel say
 * the same thing about the same failure.
 *
 * No React import: this is a pure lookup, and it is unit-tested as one.
 */

/** The tenses one file action can be rendered in. */
export interface FileVerb {
  /** Past tense, shown once the call has settled. */
  verb: string;
  /** Present participle, shown while it runs. */
  running: string;
  /** The call did not land. Never claims the outcome the other two claim. */
  failed: string;
}

/**
 * What was done, not which tool did it.
 *
 * Keyed by action rather than by tool name because the two consumers key
 * differently: the trigger rows come in as `write` / `edit` / `morph_edit`,
 * while `patch-summary.ts` comes in as an `add` / `update` / `delete` / `move`
 * patch op. Both map onto the same six English verbs, and mapping onto a shared
 * vocabulary is the point — it is what stops `apply_patch` from inventing a
 * seventh word for something `write` already has a word for.
 */
export type FileAction =
  | 'write'
  | 'edit'
  | 'create'
  | 'delete'
  | 'rename'
  | 'change'
  | 'read'
  | 'list';

export const FILE_VERBS: Record<FileAction, FileVerb> = {
  write: { verb: 'Wrote', running: 'Writing', failed: "Couldn't write" },
  edit: { verb: 'Edited', running: 'Editing', failed: "Couldn't update" },
  create: { verb: 'Created', running: 'Creating', failed: "Couldn't create" },
  delete: { verb: 'Deleted', running: 'Deleting', failed: "Couldn't delete" },
  rename: { verb: 'Renamed', running: 'Renaming', failed: "Couldn't rename" },
  // The weakest word here, deliberately — see `patchVerb`. A patch that creates
  // one file and deletes another has no honest single verb.
  change: { verb: 'Changed', running: 'Changing', failed: "Couldn't apply" },
  // `read` and `list` mutate nothing, but they had the same two defects the
  // mutating rows did: `List` was the bare registry key, and `Read` is a past
  // tense that a call still streaming has not earned. The failed wording is
  // `narration.ts`'s explore family, trimmed to this row's scope — the row
  // knows WHICH file it could not open, so it says that instead of "your files".
  read: { verb: 'Read', running: 'Reading', failed: "Couldn't read" },
  list: { verb: 'Listed', running: 'Listing', failed: "Couldn't list" },
};

/**
 * Which tense a row is in.
 *
 * A union rather than two booleans because a call site that takes booleans is a
 * call site that can forget `failed` — which is exactly what the trigger rows
 * did for as long as they existed.
 */
export type FilePhase = 'running' | 'done' | 'failed';

export function fileVerb(action: FileAction, phase: FilePhase): string {
  const verbs = FILE_VERBS[action];
  if (phase === 'running') return verbs.running;
  if (phase === 'failed') return verbs.failed;
  return verbs.verb;
}

/**
 * The tense a tool row is in, from the two facts every trigger already has.
 *
 * `running` is `ToolRunningContext` — true only while the turn that owns this
 * part is live. A leftover `pending` part from a finished run reads `false`
 * here and therefore renders in the PAST tense, which is the honest thing for
 * it to say: whatever was going to happen has already not happened. The old
 * present-participle title claimed the opposite on every restored session.
 */
export function filePhase(running: boolean, isError: boolean): FilePhase {
  if (isError) return 'failed';
  return running ? 'running' : 'done';
}
