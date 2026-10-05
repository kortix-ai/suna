/**
 * parsePatch — split a concatenated `git diff` per file into renderable rows,
 * for `PatchDiffView`. Pure: unit-tested under `bun test`.
 *
 * `maxRows` caps the rows across the whole patch. Every row is a native view,
 * so a sheet that must open and close fast (the Review sheet you merge from)
 * passes a lower cap than a full-screen diff.
 */

/** Rows `parsePatch` keeps by default, across every file of the patch. */
export const MAX_DIFF_ROWS = 2000;

export interface DiffRow {
  kind: 'hunk' | 'add' | 'del' | 'ctx';
  num: number | null;
  text: string;
}

type ParsedFile = { binary: boolean; rows: DiffRow[] };

/** The metadata lines of a file's section: not rendered. */
const META_PREFIXES = [
  'diff --git',
  'index ',
  '--- ',
  '+++ ',
  'new file mode',
  'deleted file mode',
  'old mode',
  'new mode',
  'rename from',
  'rename to',
  'copy from',
  'copy to',
  'similarity index',
  'dissimilarity index',
  '\\ No newline',
];

/** One file's section of the patch, split at each `diff --git` header. */
function patchChunks(patch: string): { path: string; chunk: string }[] {
  if (!patch) return [];
  const out: { path: string; chunk: string }[] = [];
  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    if (chunk.trim().length === 0) continue;
    const path = chunk.match(/^diff --git a\/(?:.*?) b\/(.+?)$/m)?.[1]?.trim();
    if (path) out.push({ path, chunk });
  }
  return out;
}

/** One file's rows, at most `budget`. `full` is false when the budget ran out. */
function parseChunk(chunk: string, budget: number): ParsedFile & { full: boolean } {
  const rows: DiffRow[] = [];
  let binary = false;
  let oldLine = 0;
  let newLine = 0;
  for (const line of chunk.split('\n')) {
    if (line.startsWith('Binary files')) {
      binary = true;
      continue;
    }
    if (META_PREFIXES.some((prefix) => line.startsWith(prefix))) continue;
    if (line.startsWith('@@')) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldLine = parseInt(m[1], 10);
        newLine = parseInt(m[2], 10);
      }
      rows.push({ kind: 'hunk', num: null, text: line });
    } else if (line.startsWith('+')) {
      rows.push({ kind: 'add', num: newLine, text: line.slice(1) });
      newLine++;
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'del', num: oldLine, text: line.slice(1) });
      oldLine++;
    } else if (line.startsWith(' ')) {
      rows.push({ kind: 'ctx', num: newLine, text: line.slice(1) });
      oldLine++;
      newLine++;
    } else {
      continue;
    }
    if (rows.length >= budget) return { binary, rows, full: false };
  }
  return { binary, rows, full: true };
}

/** Split the concatenated git patch per-file and parse each into renderable rows. */
export function parsePatch(
  patch: string,
  maxRows: number = MAX_DIFF_ROWS,
): { byPath: Map<string, ParsedFile>; truncated: boolean } {
  const byPath = new Map<string, ParsedFile>();
  let left = maxRows;
  for (const { path, chunk } of patchChunks(patch)) {
    const { binary, rows, full } = parseChunk(chunk, left);
    byPath.set(path, { binary, rows });
    left -= rows.length;
    if (!full || left <= 0) return { byPath, truncated: true };
  }
  return { byPath, truncated: false };
}

/**
 * One file of the patch, every row: what a virtualized list renders (the
 * Review sheet's file view), so it needs no cap. Null when the patch does
 * not touch `path`.
 */
export function parsePatchFile(patch: string, path: string): ParsedFile | null {
  const found = patchChunks(patch).find((entry) => entry.path === path);
  if (!found) return null;
  const { binary, rows } = parseChunk(found.chunk, Infinity);
  return { binary, rows };
}
