/**
 * Unresolved git conflict markers, found in tracked file content.
 *
 * `a5290753fa` (#7314) committed a whole conflict — `<<<<<<< HEAD`,
 * `=======`, `>>>>>>> 6f52904b61` — into
 * `.claude/skills/learnings/SKILL.md` and shipped it to `staging`. Every lane
 * stayed green, because nothing reads that file at build or test time. It
 * surfaced only when the next `main -> staging` promote tried to merge and git
 * produced a nested conflict.
 *
 * Only the OPENING, BASE and CLOSING markers are evidence. The middle
 * `=======` is not: a Setext heading underlines its title with exactly that, so
 * a rule that flagged it would reject ordinary markdown. `<<<<<<< `,
 * `|||||||` and `>>>>>>> ` at the start of a line have no legitimate meaning in
 * any language this repo ships.
 *
 * The BASE marker was added after the open/close rule shipped and immediately
 * found 5 of them already committed on `main` in that same learnings file
 * (`||||||| <sha>` and `||||||| base`), plus 2 more added while resolving a
 * merge here. They survive because a hand-resolution deletes the markers it can
 * SEE: `git` writes the base section only under `merge.conflictStyle = diff3`,
 * and a resolver grepping for the two familiar markers leaves every `|||||||`
 * line behind. Orphan base markers are exactly as invisible to CI as the
 * conflict that motivated this file.
 */
export interface ConflictMarker {
  line: number;
  kind: 'open' | 'base' | 'close';
  text: string;
}

const OPEN = `${'<'.repeat(7)} `;
// No trailing space: git writes a bare `|||||||` when the base has no label.
const BASE = '|'.repeat(7);
const CLOSE = `${'>'.repeat(7)} `;

/** Every conflict marker in `content`, with 1-based line numbers. */
export function findConflictMarkers(content: string): ConflictMarker[] {
  const found: ConflictMarker[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i];
    if (text.startsWith(OPEN)) found.push({ line: i + 1, kind: 'open', text });
    else if (text.startsWith(BASE)) found.push({ line: i + 1, kind: 'base', text });
    else if (text.startsWith(CLOSE)) found.push({ line: i + 1, kind: 'close', text });
  }
  return found;
}
