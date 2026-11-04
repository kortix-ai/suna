/**
 * After a reset of a co-edited doc (KRTX-3670, contract v2), every tab puts
 * its own text (`mine`) onto the rebuilt doc (`current`), from the last text
 * they shared (`base`). Several tabs do this one after another, and each
 * holds part of the same recent typing: one tab already merged "beta more"
 * when the next one, which saw only "beta", merges. A 3-way merge with
 * conflicts would put that paragraph in twice.
 *
 * `unionMerge` is a 3-way merge of the Markdown text, word by word, whose
 * clashes keep both sides: two changes to the same words become their
 * shortest common supersequence, so text both sides hold appears once and
 * text only one side holds is kept. A run that is the start of the other
 * side's run (a word typed in part on one tab) counts as the same run. A
 * change on one side only (an edit, a deletion) applies as in any 3-way
 * merge.
 *
 * Cost: three Myers diffs over the word tokens (`diffSequences`, capped).
 */

import { diffSequences, type Hunk } from './doc-outside-edit';

/** Words (letters, digits, `_`), whitespace runs, and any other single code point (as doc-outside-edit.ts). */
const WORDS = new RegExp('[\\p{L}\\p{M}\\p{N}_]+|\\s+|[^]', 'gu');

const tokensOf = (text: string): string[] => Array.from(text.matchAll(WORDS), (match) => match[0]);

function keysOf(tokens: string[], ids: Map<string, number>): Int32Array {
  return Int32Array.from(tokens, (token) => {
    let id = ids.get(token);
    if (id === undefined) {
      id = ids.size;
      ids.set(token, id);
    }
    return id;
  });
}

/** Both runs, with what they share once; a run that starts the other is part of it. */
function supersequence(a: string[], b: string[]): string {
  const ids = new Map<string, number>();
  const ka = keysOf(a, ids);
  const kb = keysOf(b, ids);
  let out = '';
  let ai = 0;
  const run = (from: string[], start: number, end: number) => from.slice(start, end).join('');
  for (const h of diffSequences(ka, kb)) {
    // Between hunks both sides are equal: `a`'s copy stands for both.
    out += run(a, ai, h.aStart);
    const left = run(a, h.aStart, h.aEnd);
    const right = run(b, h.bStart, h.bEnd);
    out += left.startsWith(right) ? left : right.startsWith(left) ? right : left + right;
    ai = h.aEnd;
  }
  return out + run(a, ai, a.length);
}

type SideHunk = Hunk & { side: 'current' | 'mine' };

const isInsertion = (h: Hunk) => h.aStart === h.aEnd;
const growth = (h: Hunk) => h.bEnd - h.bStart - (h.aEnd - h.aStart);

/** `mine` onto `current`, both changed from `base`: a 3-way merge whose clashes keep both sides. */
export function unionMerge(base: string, current: string, mine: string): string {
  if (mine === base || mine === current) return current;
  if (current === base) return mine;
  const ids = new Map<string, number>();
  const tb = tokensOf(base);
  const tc = tokensOf(current);
  const tm = tokensOf(mine);
  const kb = keysOf(tb, ids);
  const hunks: SideHunk[] = [
    ...diffSequences(kb, keysOf(tc, ids)).map((h) => ({ ...h, side: 'current' as const })),
    ...diffSequences(kb, keysOf(tm, ids)).map((h) => ({ ...h, side: 'mine' as const })),
  ].sort((x, y) => x.aStart - y.aStart || x.aEnd - y.aEnd);

  let out = '';
  let at = 0;
  let shiftCurrent = 0;
  let shiftMine = 0;
  for (let i = 0; i < hunks.length; ) {
    const start = hunks[i].aStart;
    let end = hunks[i].aEnd;
    const group = [hunks[i++]];
    // One clash: changes that overlap, or two insertions at one point. A deletion beside an insertion is two changes.
    while (
      i < hunks.length &&
      (hunks[i].aStart < end ||
        (isInsertion(hunks[i]) && hunks[i].aStart === end && group.some((h) => isInsertion(h) && h.aStart === end)))
    ) {
      end = Math.max(end, hunks[i].aEnd);
      group.push(hunks[i++]);
    }
    out += tb.slice(at, start).join('');
    let growCurrent = 0;
    let growMine = 0;
    for (const h of group) {
      if (h.side === 'current') growCurrent += growth(h);
      else growMine += growth(h);
    }
    const ofCurrent = tc.slice(start + shiftCurrent, end + shiftCurrent + growCurrent);
    const ofMine = tm.slice(start + shiftMine, end + shiftMine + growMine);
    const changedCurrent = group.some((h) => h.side === 'current');
    const changedMine = group.some((h) => h.side === 'mine');
    out += !changedMine
      ? ofCurrent.join('')
      : !changedCurrent
        ? ofMine.join('')
        : supersequence(ofCurrent, ofMine);
    shiftCurrent += growCurrent;
    shiftMine += growMine;
    at = end;
  }
  return out + tb.slice(at).join('');
}
