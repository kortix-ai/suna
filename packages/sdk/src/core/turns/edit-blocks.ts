/**
 * The replaced blocks of an edit call's input, `[before, after]` in order: OpenCode's one
 * `oldString`/`newString`, Claude Code's `old_string`/`new_string`, or the `edits[]` of a pi
 * edit (`oldText`/`newText`) or a Claude Code `MultiEdit` (`old_string`/`new_string`).
 * Internal: `classify.ts` and `view-model.ts` read it; the barrel does not export it.
 */
export function editBlocks(input: Record<string, unknown> | undefined): Array<[string, string]> {
  const one = pair(input);
  if (one) return [one];
  const edits = Array.isArray(input?.edits) ? input.edits : [];
  return edits.flatMap((edit) => {
    const block = edit && typeof edit === 'object' ? pair(edit as Record<string, unknown>) : undefined;
    return block ? [block] : [];
  });
}

function pair(input: Record<string, unknown> | undefined): [string, string] | undefined {
  const before = input?.oldString ?? input?.old_string ?? input?.oldText;
  const after = input?.newString ?? input?.new_string ?? input?.newText;
  return typeof before === 'string' && typeof after === 'string' ? [before, after] : undefined;
}
