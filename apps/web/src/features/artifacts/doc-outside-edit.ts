/**
 * An outside edit of a co-edited doc's Markdown file (an agent's publish, a
 * Files write, a restore) merged into the live doc, without losing a
 * character a person typed (KRTX-3670, WP5).
 *
 * `base` is the Markdown the live doc was last flushed from; `theirs` is the
 * file's new Markdown. Both parse through the editor's own load path into
 * docs of `editor.schema`. The agent's change is the block diff
 * `base → theirs`; the person's change is the block diff `base → current`.
 *
 * - A block the person left untouched takes the agent's version.
 * - A block both changed merges inside: a list item by item, a table cell by
 *   cell, a paragraph word by word (diff3 over words with their marks).
 *   Attributes merge per key (the agent ticks a task box the person types in).
 * - When both changed the same or adjacent words, either side rewrote more
 *   than half of a paragraph, or both changed a table cell, an image or a
 *   code block's language: the person's block stays and the agent's version
 *   lands right after it. That is a conflict. In a list the agent's item
 *   lands after the person's item; in a table the agent's whole table lands
 *   after the person's table, so the columns stay whole.
 *
 * Everything lands as ONE transaction with `addToHistory: false`, as
 * position-precise replace steps, so the person's caret, selection, comment
 * highlights and remote carets map through it, and their undo never
 * reverts the agent.
 *
 * Cost of the diffs: each trims the common prefix and suffix, then runs
 * Myers' O((N+M)·D) algorithm (D: changed blocks, or words in one block),
 * capped at `MAX_EDITS` edits; past it, blocks that occur once on each side
 * anchor it (patience diff). One diff costs O((N+M)·MAX_EDITS) time and
 * O(N+M + MAX_EDITS²) memory for any doc. Cost of the transaction: one step
 * per run of adjacent changed blocks, each O(N) in ProseMirror, so O(R·N)
 * for R runs (a full rewrite is one run).
 */
import { createDocument, type Editor } from '@tiptap/core';
import { Fragment, Mark, type Attrs, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { markdownToHtml } from '@kortix/ui/markdown/doc-editor/markdown';

/** The most edits one diff traces; past it the trimmed middle is one changed range. */
export const MAX_EDITS = 1000;

/** `a[aStart..aEnd)` became `b[bStart..bEnd)`. Hunks are ordered and disjoint; between them a and b are equal. */
export interface Hunk {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

/**
 * The hunks that turn `a` into `b`. Within `maxEdits` edits it is minimal
 * (the longest common subsequence stays). Past that, the elements that occur
 * once on each side anchor it (patience diff), each gap between anchors gets
 * its own capped pass, and a gap still past the cap is one hunk.
 * Cost: O((N+M)·maxEdits) time, O(N+M + maxEdits²) memory.
 */
export function diffSequences(a: ArrayLike<number>, b: ArrayLike<number>, maxEdits = MAX_EDITS): Hunk[] {
  const hunks: Hunk[] = [];
  diffRange(a, b, { aStart: 0, aEnd: a.length, bStart: 0, bEnd: b.length }, maxEdits, true, hunks);
  return hunks;
}

function diffRange(a: ArrayLike<number>, b: ArrayLike<number>, range: Hunk, maxEdits: number, anchor: boolean, out: Hunk[]) {
  let { aStart, aEnd, bStart, bEnd } = range;
  while (aStart < aEnd && bStart < bEnd && a[aStart] === b[bStart]) {
    aStart += 1;
    bStart += 1;
  }
  while (aEnd > aStart && bEnd > bStart && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd -= 1;
    bEnd -= 1;
  }
  if (aStart === aEnd && bStart === bEnd) return;
  const whole = { aStart, aEnd, bStart, bEnd };
  if (aStart === aEnd || bStart === bEnd) {
    out.push(whole);
    return;
  }
  const exact = myersMatches(a, b, whole, maxEdits);
  const matches = exact ?? (anchor ? uniqueAnchors(a, b, whole) : null);
  if (!matches?.length) {
    out.push(whole);
    return;
  }
  // Gaps between Myers' matches are final; gaps between anchors get one capped pass each.
  const gap = (g: Hunk) => {
    if (g.aEnd === g.aStart && g.bEnd === g.bStart) return;
    if (!exact && g.aEnd > g.aStart && g.bEnd > g.bStart) diffRange(a, b, g, maxEdits, false, out);
    else out.push(g);
  };
  let ai = aStart;
  let bi = bStart;
  for (let i = 0; i < matches.length; i += 2) {
    gap({ aStart: ai, aEnd: matches[i], bStart: bi, bEnd: matches[i + 1] });
    ai = matches[i] + 1;
    bi = matches[i + 1] + 1;
  }
  gap({ aStart: ai, aEnd, bStart: bi, bEnd });
}

/**
 * The elements that occur exactly once in `a`'s range and once in `b`'s,
 * as `[x0, y0, …]` pairs: the longest run of them in the same order on both
 * sides (patience sorting, O(K log K)).
 */
function uniqueAnchors(a: ArrayLike<number>, b: ArrayLike<number>, range: Hunk): number[] {
  const inA = new Map<number, number>();
  for (let i = range.aStart; i < range.aEnd; i += 1) inA.set(a[i], inA.has(a[i]) ? -1 : i);
  const inB = new Map<number, number>();
  for (let j = range.bStart; j < range.bEnd; j += 1) inB.set(b[j], inB.has(b[j]) ? -1 : j);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = range.aStart; i < range.aEnd; i += 1) {
    const j = inB.get(a[i]);
    if (inA.get(a[i]) === i && j !== undefined && j >= 0) {
      xs.push(i);
      ys.push(j);
    }
  }
  // Longest increasing run of ys (xs already increase).
  const tails: number[] = [];
  const previous = new Int32Array(ys.length).fill(-1);
  for (let p = 0; p < ys.length; p += 1) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ys[tails[mid]] < ys[p]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) previous[p] = tails[lo - 1];
    tails[lo] = p;
  }
  const pairs: number[] = [];
  for (let p = tails.length ? tails[tails.length - 1] : -1; p >= 0; p = previous[p]) pairs.push(ys[p], xs[p]);
  return pairs.reverse();
}

/**
 * Myers' greedy diff of `a[aStart..aEnd)` and `b[bStart..bEnd)`: the matched
 * pairs `[x0, y0, x1, y1, …]` in order, or null past `maxEdits` edits. It
 * keeps the frontier of each step (≤ 2·maxEdits + 3 numbers) to trace back.
 */
function myersMatches(a: ArrayLike<number>, b: ArrayLike<number>, range: Hunk, maxEdits: number): number[] | null {
  const { aStart, bStart } = range;
  const n = range.aEnd - aStart;
  const m = range.bEnd - bStart;
  const limit = Math.min(n + m, maxEdits);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= limit; d += 1) {
    // The frontier before step d, diagonals -d-1 … d+1.
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[aStart + x] === b[bStart + y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return traceBack(trace, n, m, aStart, bStart);
    }
  }
  return null;
}

function traceBack(trace: Int32Array[], n: number, m: number, aStart: number, bStart: number): number[] {
  const backwards: number[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const frontier = trace[d];
    const at = (k: number) => frontier[k + d + 1];
    const k = x - y;
    // Step d came from (prevX, prevY) on diagonal prevK, made one edit to `snakeX`, then followed equal elements.
    let prevX = 0;
    let prevY = 0;
    let snakeX = 0;
    if (d > 0) {
      const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
      prevX = at(prevK);
      prevY = prevX - prevK;
      snakeX = prevK === k + 1 ? prevX : prevX + 1;
    }
    while (x > snakeX) {
      x -= 1;
      y -= 1;
      backwards.push(bStart + y, aStart + x);
    }
    x = prevX;
    y = prevY;
  }
  // `backwards` holds [y, x] pairs from the end; reversed, it is [x, y] pairs from the start.
  return backwards.reverse();
}

/** An agent change mapped onto the person's sequence: `mine[from..to)` becomes `theirs[insertFrom..insertTo)`. */
interface Patch {
  from: number;
  to: number;
  insertFrom: number;
  insertTo: number;
}

/**
 * Whether an agent hunk `[a1, a2)` and a person hunk `[p1, p2)` (base
 * coordinates) overlap or touch. Touching clashes too, as in git's diff3:
 * "Ana" → "Dee" beside "Ana" → "Ana K" would make "Dee K".
 */
function clash(a1: number, a2: number, p1: number, p2: number): boolean {
  if (a1 === a2 && p1 === p2) return a1 === p1;
  return a1 <= p2 && p1 <= a2;
}

function rangeEqual(a: ArrayLike<number>, a1: number, a2: number, b: ArrayLike<number>, b1: number, b2: number): boolean {
  if (a2 - a1 !== b2 - b1) return false;
  for (let i = 0; i < a2 - a1; i += 1) if (a[a1 + i] !== b[b1 + i]) return false;
  return true;
}

/** Base point `x` in mine. No person hunk touches `x` here (that is a clash), so the shift is the last hunk's before it. */
function mapPoint(person: Hunk[], x: number): number {
  let lo = 0;
  let hi = person.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (person[mid].aEnd <= x) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return x;
  const h = person[lo - 1];
  return x - h.aEnd + h.bEnd;
}

/**
 * diff3: the agent's hunks (`base → theirs`) as patches on `mine`, given the
 * person's hunks (`base → mine`), or null when the person changed any of the
 * same or adjacent elements differently. The same change on both sides lands once.
 */
function merge3(agent: Hunk[], person: Hunk[], mine: ArrayLike<number>, theirs: ArrayLike<number>): Patch[] | null {
  const patches: Patch[] = [];
  let first = 0;
  for (const a of agent) {
    while (first < person.length && person[first].aEnd < a.aStart) first += 1;
    let same = false;
    for (let i = first; i < person.length && person[i].aStart <= a.aEnd; i += 1) {
      const p = person[i];
      if (p.aStart === a.aStart && p.aEnd === a.aEnd && rangeEqual(mine, p.bStart, p.bEnd, theirs, a.bStart, a.bEnd)) same = true;
      else if (clash(a.aStart, a.aEnd, p.aStart, p.aEnd)) return null;
    }
    if (same) continue;
    const from = mapPoint(person, a.aStart);
    patches.push({ from, to: from + a.aEnd - a.aStart, insertFrom: a.bStart, insertTo: a.bEnd });
  }
  return patches;
}

/**
 * The block attribute that records how the file spells a block (`md`,
 * doc-fidelity.ts), not what it holds. The live doc keeps a stale one after
 * an edit, and a fresh parse of the flushed text has none: it must never
 * make an untouched block read as edited, so keys and attribute merges skip it.
 */
const SPELLING_ATTR = 'md';

/** A node's identity for the diff: its JSON without spelling attributes. Equal keys = `node.eq` ignoring `md`. */
function nodeKey(node: PMNode): string {
  return JSON.stringify(node.toJSON(), (key, value: unknown) => (key === SPELLING_ATTR ? undefined : value));
}

function intern(ids: Map<string, number>, key: string): number {
  let id = ids.get(key);
  if (id === undefined) {
    id = ids.size;
    ids.set(key, id);
  }
  return id;
}

/** A word, a run of spaces or one other character, with its marks; or one inline node (a soft break, a hard break). */
interface Token {
  key: string;
  size: number;
  text: string;
  marks: readonly Mark[];
  node: PMNode | null;
}

/** Words (letters, digits, `_`), whitespace runs, and any other single code point. */
const WORDS = new RegExp('[\\p{L}\\p{M}\\p{N}_]+|\\s+|[^]', 'gu');

function tokensOf(block: PMNode): Token[] {
  const tokens: Token[] = [];
  block.forEach((child) => {
    if (child.isText) {
      const marks = child.marks;
      const marksKey = JSON.stringify(marks.map((mark) => mark.toJSON()));
      for (const [text] of (child.text ?? '').matchAll(WORDS)) {
        tokens.push({ key: `${text}\u0000${marksKey}`, size: text.length, text, marks, node: null });
      }
    } else {
      tokens.push({ key: `\u0001${nodeKey(child)}`, size: child.nodeSize, text: '', marks: child.marks, node: child });
    }
  });
  return tokens;
}

/** Tokens back into inline nodes: runs of text with one mark set become one text node. */
function inlineContent(schema: Schema, tokens: Token[]): Fragment {
  const nodes: PMNode[] = [];
  let text = '';
  let marks: readonly Mark[] = Mark.none;
  const flush = () => {
    if (text) nodes.push(schema.text(text, marks));
    text = '';
  };
  for (const token of tokens) {
    if (token.node) {
      flush();
      nodes.push(token.node);
      continue;
    }
    if (text && !Mark.sameSet(marks, token.marks)) flush();
    marks = token.marks;
    text += token.text;
  }
  flush();
  return Fragment.fromArray(nodes);
}

/** A replacement inside a textblock, in offsets from the start of its content. */
interface InlinePatch {
  from: number;
  to: number;
  content: Fragment;
}

/**
 * The 3-way word merge of one textblock, or null on a clash. Also null when
 * either side kept less than half of the block's text: diff3 against a
 * rewrite would splice the person's words into unrelated text.
 */
function mergeInline(base: PMNode, mine: PMNode, theirs: PMNode): InlinePatch[] | null {
  const ids = new Map<string, number>();
  const tb = tokensOf(base);
  const tm = tokensOf(mine);
  const tt = tokensOf(theirs);
  const keys = (tokens: Token[]) => Int32Array.from(tokens, (token) => intern(ids, token.key));
  const kb = keys(tb);
  const kt = keys(tt);
  const agent = diffSequences(kb, kt);
  if (!agent.length) return [];
  const km = keys(tm);
  const person = diffSequences(kb, km);
  const baseOffsets = new Int32Array(tb.length + 1);
  for (let i = 0; i < tb.length; i += 1) baseOffsets[i + 1] = baseOffsets[i] + tb[i].size;
  const total = baseOffsets[tb.length];
  const kept = (hunks: Hunk[]) => total - hunks.reduce((sum, h) => sum + baseOffsets[h.aEnd] - baseOffsets[h.aStart], 0);
  if (2 * kept(agent) < total || 2 * kept(person) < total) return null;
  const patches = merge3(agent, person, km, kt);
  if (!patches) return null;
  const offsets = new Int32Array(tm.length + 1);
  for (let i = 0; i < tm.length; i += 1) offsets[i + 1] = offsets[i] + tm[i].size;
  return patches.map((patch) => ({
    from: offsets[patch.from],
    to: offsets[patch.to],
    content: inlineContent(base.type.schema, tt.slice(patch.insertFrom, patch.insertTo)),
  }));
}

/**
 * Per-key 3-way merge of node attributes: null when mine stand, undefined
 * when both changed one key differently. The spelling attribute keeps mine.
 */
function mergeAttrs(base: Attrs, mine: Attrs, theirs: Attrs): Attrs | null | undefined {
  let merged: Record<string, unknown> | null = null;
  for (const key of Object.keys(theirs)) {
    if (key === SPELLING_ATTR) continue;
    const b = JSON.stringify(base[key]);
    const m = JSON.stringify(mine[key]);
    const t = JSON.stringify(theirs[key]);
    if (t === b || t === m) continue;
    if (m !== b) return undefined;
    merged ??= { ...mine };
    merged[key] = theirs[key];
  }
  return merged;
}

/** What happens to one of the person's blocks: removed, or merged in place. */
type Fate =
  | { kind: 'delete' }
  | { kind: 'merge'; attrs: Attrs | null; text: InlinePatch[] | null; children: Plan | null };

/** The merge of one container's children, against the person's (current) children. */
interface Plan {
  /** Nodes inserted before the person's child i (i = childCount: at the end), in order. */
  inserts: Map<number, PMNode[]>;
  /** Absent: the person's child stays as it is. */
  fates: Map<number, Fate>;
  conflicts: number;
}

const DELETE: Fate = { kind: 'delete' };

/**
 * Containers that take the agent's block right after the person's on a
 * conflict: the doc, a quote, a list (an item after an item). A conflict
 * inside a table, a row, a cell or an item moves up to one of these, so a
 * table keeps its columns and an item keeps one paragraph.
 */
const CONFLICT_HOSTS = new Set(['blockquote', 'bulletList', 'orderedList', 'taskList']);

/** Where base child i is in the person's doc. */
interface Place {
  /** kept: unchanged at `at`. edited: changed in place into `at`. replaced: the person's `[at, end)` stands for it (empty = deleted). */
  kind: 'kept' | 'edited' | 'replaced';
  at: number;
  end: number;
}

/** Whether `other` reads as an edit of `base`: the shared start and end hold at least half of base's text. */
function similar(base: PMNode, other: PMNode): boolean {
  const a = base.textContent;
  const b = other.textContent;
  const most = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < most && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix += 1;
  let suffix = 0;
  while (suffix < most - prefix && a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)) suffix += 1;
  return 2 * (prefix + suffix) >= a.length;
}

/**
 * A hunk split into blocks edited in place (`paired`: same type) and the
 * rest. Equal counts split position by position. Otherwise pairs come from
 * both ends while they also read as an edit (`similar`), so a deleted block
 * never pairs with its neighbour, and the middle stays one unpaired range.
 */
function pairHunk(a: PMNode, b: PMNode, hunk: Hunk): Array<Hunk & { paired: boolean }> {
  const head: Array<Hunk & { paired: boolean }> = [];
  const tail: Array<Hunk & { paired: boolean }> = [];
  if (hunk.aEnd - hunk.aStart === hunk.bEnd - hunk.bStart) {
    for (let i = hunk.aStart, j = hunk.bStart; i < hunk.aEnd; i += 1, j += 1) {
      head.push({ aStart: i, aEnd: i + 1, bStart: j, bEnd: j + 1, paired: a.child(i).type === b.child(j).type });
    }
    return head;
  }
  const pairable = (i: number, j: number) => a.child(i).type === b.child(j).type && similar(a.child(i), b.child(j));
  let i = hunk.aStart;
  let j = hunk.bStart;
  let ie = hunk.aEnd;
  let je = hunk.bEnd;
  for (; i < ie && j < je && pairable(i, j); i += 1, j += 1) head.push({ aStart: i, aEnd: i + 1, bStart: j, bEnd: j + 1, paired: true });
  for (; ie > i && je > j && pairable(ie - 1, je - 1); ie -= 1, je -= 1) {
    tail.push({ aStart: ie - 1, aEnd: ie, bStart: je - 1, bEnd: je, paired: true });
  }
  if (i < ie || j < je) head.push({ aStart: i, aEnd: ie, bStart: j, bEnd: je, paired: false });
  return head.concat(tail.reverse());
}

function placeBase(base: PMNode, mine: PMNode, bk: Int32Array, mk: Int32Array, person: Hunk[]): Place[] {
  const places: Place[] = new Array<Place>(base.childCount);
  let ai = 0;
  let mi = 0;
  const keep = (until: number) => {
    for (; ai < until; ai += 1, mi += 1) places[ai] = { kind: 'kept', at: mi, end: mi + 1 };
  };
  for (const hunk of person) {
    keep(hunk.aStart);
    for (const sub of pairHunk(base, mine, hunk)) {
      if (sub.paired) {
        const kind = bk[sub.aStart] === mk[sub.bStart] ? 'kept' : 'edited';
        places[sub.aStart] = { kind, at: sub.bStart, end: sub.bEnd };
      } else {
        for (let i = sub.aStart; i < sub.aEnd; i += 1) places[i] = { kind: 'replaced', at: sub.bStart, end: sub.bEnd };
      }
    }
    ai = hunk.aEnd;
    mi = hunk.bEnd;
  }
  keep(base.childCount);
  return places;
}

/** The point in the person's children right after their version of base child i (i = -1: the start). */
function after(places: Place[], i: number): number {
  if (i < 0) return 0;
  const place = places[i];
  return place.kind === 'replaced' ? place.end : place.at + 1;
}

function childKeys(node: PMNode, ids: Map<string, number>): Int32Array {
  const keys = new Int32Array(node.childCount);
  node.forEach((child, _offset, index) => {
    keys[index] = intern(ids, nodeKey(child));
  });
  return keys;
}

function childrenOf(node: PMNode, from: number, to: number): PMNode[] {
  const nodes: PMNode[] = [];
  for (let i = from; i < to; i += 1) nodes.push(node.child(i));
  return nodes;
}

/** Both sides changed one block: merge it in place, or null for a conflict at this level. */
function mergeNode(base: PMNode, mine: PMNode, theirs: PMNode): { fate: Fate; conflicts: number } | null {
  if (base.type !== mine.type || base.type !== theirs.type || base.isLeaf) return null;
  if (!Mark.sameSet(base.marks, mine.marks) || !Mark.sameSet(base.marks, theirs.marks)) return null;
  const attrs = mergeAttrs(base.attrs, mine.attrs, theirs.attrs);
  if (attrs === undefined) return null;
  if (base.isTextblock) {
    const text = mergeInline(base, mine, theirs);
    return text ? { fate: { kind: 'merge', attrs, text, children: null }, conflicts: 0 } : null;
  }
  const children = planChildren(base, mine, theirs, false);
  return children ? { fate: { kind: 'merge', attrs, text: null, children }, conflicts: children.conflicts } : null;
}

/**
 * The merge of `theirs`'s changes to `base`'s children into `mine`'s
 * children. Null when this container cannot hold a conflict (or the result
 * would break its content rule): the parent then keeps the person's whole
 * container and adds the agent's after it.
 */
function planChildren(base: PMNode, mine: PMNode, theirs: PMNode, top: boolean): Plan | null {
  const plan: Plan = { inserts: new Map(), fates: new Map(), conflicts: 0 };
  const ids = new Map<string, number>();
  const bk = childKeys(base, ids);
  const tk = childKeys(theirs, ids);
  const agent = diffSequences(bk, tk);
  if (!agent.length) return plan;
  const mk = childKeys(mine, ids);
  const person = diffSequences(bk, mk);
  const places = placeBase(base, mine, bk, mk, person);
  const personAt = new Map(person.map((hunk) => [hunk.aStart, hunk]));
  const insert = (at: number, nodes: PMNode[]) => {
    if (!nodes.length) return;
    const list = plan.inserts.get(at);
    if (list) list.push(...nodes);
    else plan.inserts.set(at, nodes);
  };
  let conflicts = 0;

  for (const hunk of agent) {
    // The person already made this very change.
    const same = personAt.get(hunk.aStart);
    if (same && same.aEnd === hunk.aEnd && rangeEqual(mk, same.bStart, same.bEnd, tk, hunk.bStart, hunk.bEnd)) continue;

    for (const sub of pairHunk(base, theirs, hunk)) {
      if (sub.paired && bk[sub.aStart] === tk[sub.bStart]) continue;
      const incoming = childrenOf(theirs, sub.bStart, sub.bEnd);
      if (sub.aStart === sub.aEnd) {
        insert(after(places, sub.aStart - 1), incoming);
        continue;
      }
      const spots = places.slice(sub.aStart, sub.aEnd);
      // Blocks the person left untouched take the agent's version.
      if (spots.every((place) => place.kind === 'kept')) {
        for (const place of spots) plan.fates.set(place.at, DELETE);
        insert(spots[0].at, incoming);
        continue;
      }
      // One block edited on both sides: merge inside it.
      const spot = spots[0];
      if (sub.paired && spot.kind === 'edited') {
        if (mk[spot.at] === tk[sub.bStart]) continue;
        const merged = mergeNode(base.child(sub.aStart), mine.child(spot.at), incoming[0]);
        if (merged) {
          plan.fates.set(spot.at, merged.fate);
          plan.conflicts += merged.conflicts;
        } else {
          insert(spot.at + 1, incoming);
          conflicts += 1;
        }
        continue;
      }
      // The person changed or removed some of these blocks: theirs stand, the agent's land after them.
      let last = -1;
      let typed = false;
      spots.forEach((place, offset) => {
        if (place.kind === 'kept') plan.fates.set(place.at, DELETE);
        else {
          last = sub.aStart + offset;
          typed ||= place.kind === 'edited' || place.end > place.at;
        }
      });
      insert(after(places, last), incoming);
      if (incoming.length || typed) conflicts += 1;
    }
  }

  plan.conflicts += conflicts;
  const host = top || CONFLICT_HOSTS.has(base.type.name);
  if (conflicts && !host) return null;
  const result = resultChildren(mine, plan);
  if (!mine.type.validContent(Fragment.fromArray(result))) {
    if (!top) return null;
    // Only an emptied doc breaks the doc's rule (block+): give it the empty line the editor would.
    const filler = mine.type.createAndFill()?.firstChild;
    if (!result.length && filler) insert(0, [filler]);
  }
  return plan;
}

/** The container's children after the plan (a merged child keeps its type, so it stands for itself). */
function resultChildren(mine: PMNode, plan: Plan): PMNode[] {
  const out: PMNode[] = [];
  for (let i = 0; i <= mine.childCount; i += 1) {
    out.push(...(plan.inserts.get(i) ?? []));
    if (i < mine.childCount && plan.fates.get(i)?.kind !== 'delete') out.push(mine.child(i));
  }
  return out;
}

/** One change to the live doc, in its positions before any step applies. */
export type MergeStep = { from: number; to: number; content: Fragment } | { pos: number; attrs: Attrs };

/** Adjacent removed or inserted children, as one replace. */
interface Run {
  from: number;
  to: number;
  nodes: PMNode[];
}

function flushRun(run: Run | null, steps: MergeStep[]): null {
  if (run) steps.push({ from: run.from, to: run.to, content: Fragment.fromArray(run.nodes) });
  return null;
}

/**
 * The plan as steps, in document order (`start`: where the container's
 * content starts). Adjacent removals and insertions merge into one step: each
 * step rebuilds its container's child list, so a full rewrite is one step,
 * not one per block.
 */
function compile(plan: Plan, node: PMNode, start: number, steps: MergeStep[]) {
  let pos = start;
  let run: Run | null = null;
  for (let i = 0; i <= node.childCount; i += 1) {
    const incoming = plan.inserts.get(i);
    const child = i < node.childCount ? node.child(i) : null;
    const fate = plan.fates.get(i);
    const end = child && fate?.kind === 'delete' ? pos + child.nodeSize : pos;
    if (incoming || end > pos) {
      if (run && run.to === pos) {
        run.to = end;
        run.nodes.push(...(incoming ?? []));
      } else {
        run = flushRun(run, steps);
        run = { from: pos, to: end, nodes: [...(incoming ?? [])] };
      }
    }
    if (!child) break;
    if (fate?.kind === 'merge') {
      run = flushRun(run, steps);
      if (fate.attrs) steps.push({ pos, attrs: fate.attrs });
      for (const patch of fate.text ?? []) steps.push({ from: pos + 1 + patch.from, to: pos + 1 + patch.to, content: patch.content });
      if (fate.children) compile(fate.children, child, pos + 1, steps);
    }
    pos += child.nodeSize;
  }
  flushRun(run, steps);
}

/**
 * The pure merge: the steps that bring `theirs`'s changes to `base` into
 * `current` (the live doc), and how many blocks conflicted. Steps are in
 * document order, against `current`'s positions; apply them last to first.
 */
export function planOutsideEdit(base: PMNode, current: PMNode, theirs: PMNode): { steps: MergeStep[]; conflicts: number } {
  const plan = planChildren(base, current, theirs, true);
  const steps: MergeStep[] = [];
  if (plan) compile(plan, current, 0, steps);
  return { steps, conflicts: plan?.conflicts ?? 0 };
}

export interface OutsideEditOptions {
  /**
   * Markdown → the HTML the editor loads. Pass the editor's own, e.g.
   * `(md) => media.resolveHtml(markdownToHtml(md))` (doc-media.ts), so an
   * untouched image's URL matches the live doc's. Default: `markdownToHtml`.
   */
  toHtml?: (markdown: string) => string;
}

export interface OutsideEditResult {
  /** The live doc changed (one transaction, outside the undo history). */
  changed: boolean;
  /** Blocks both sides changed where the person's block stayed and the agent's landed right after it (or, for a deletion, did not apply). */
  conflicts: number;
}

/**
 * Merge an outside edit of the file (`base` → `theirs`) into the live doc,
 * keeping every character the person typed since `base`. Both texts parse
 * through the editor's load path: `toHtml`, then TipTap's `createDocument`
 * with the editor's schema and parse options.
 */
export function applyOutsideEdit(editor: Editor, base: string, theirs: string, options: OutsideEditOptions = {}): OutsideEditResult {
  if (base === theirs || editor.isDestroyed) return { changed: false, conflicts: 0 };
  const toHtml = options.toHtml ?? markdownToHtml;
  const parse = (markdown: string) => createDocument(toHtml(markdown), editor.schema, editor.options.parseOptions);
  return mergeOutsideEdit(editor, parse(base), parse(theirs));
}

/** `applyOutsideEdit` for docs already parsed into `editor.schema` (the one transaction, no Markdown). */
export function mergeOutsideEdit(editor: Editor, base: PMNode, theirs: PMNode): OutsideEditResult {
  if (editor.isDestroyed) return { changed: false, conflicts: 0 };
  const { steps, conflicts } = planOutsideEdit(base, editor.state.doc, theirs);
  if (!steps.length) return { changed: false, conflicts };
  const tr = editor.state.tr;
  // Last to first: a step never moves the positions of the steps before it.
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if ('attrs' in step) tr.setNodeMarkup(step.pos, undefined, step.attrs);
    else tr.replaceWith(step.from, step.to, step.content);
  }
  tr.setMeta('addToHistory', false);
  editor.view.dispatch(tr);
  return { changed: tr.docChanged, conflicts };
}
