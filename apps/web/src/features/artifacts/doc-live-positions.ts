/**
 * Doc cursors and selections as layout-independent text anchors (KRTX-3669).
 * A caret travels as up to 64 code units of the doc's Markdown around it, the
 * 32 before that as context, and its offset into the quote. Every viewer finds
 * the quote in their own Markdown (`reanchorArtifactText`), so the caret lands
 * on the same words on every screen and at every window width.
 */
import type { ArtifactLivePosition, ArtifactLiveRange } from '@kortix/sdk';
import {
  ARTIFACT_TEXT_CONTEXT_MAX,
  ARTIFACT_TEXT_QUOTE_MAX,
  ARTIFACT_REANCHOR_READ_UNITS,
  reanchorArtifactText,
  type ArtifactReanchorBudget,
} from '@kortix/shared/artifact-comments';
import type { Node as PMNode } from '@tiptap/pm/model';
import { docMarkdownPositions, type DocMarkdownPositions } from './doc-comment-positions';

/** The protocol's limits for a doc caret: `quote` 1–64, `prefix` ≤ 32, `offset` 0–64. */
export const DOC_LIVE_CURSOR_QUOTE = 64;

// The last map built in this tab.
let lastMap: { markdown: string; doc: PMNode; map: DocMarkdownPositions | null } | null = null;

/**
 * `docMarkdownPositions`, built once per (Markdown, doc) pair: the comment
 * highlights, a caret move and every presence frame of one revision share it,
 * so only an edit parses the Markdown again.
 */
export function cachedDocMarkdownPositions(markdown: string, doc: PMNode): DocMarkdownPositions | null {
  if (lastMap && lastMap.doc === doc && lastMap.markdown === markdown) return lastMap.map;
  const map = docMarkdownPositions(markdown, doc);
  lastMap = { markdown, doc, map };
  return map;
}

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** A slice start that does not split a surrogate pair: it moves past the low half. */
function safeStart(text: string, at: number): number {
  return at > 0 && at < text.length && isLow(text.charCodeAt(at)) && isHigh(text.charCodeAt(at - 1))
    ? at + 1
    : at;
}

/** A slice end that does not split a surrogate pair: it moves before the high half. */
function safeEnd(text: string, at: number): number {
  return at > 0 && at < text.length && isHigh(text.charCodeAt(at - 1)) && isLow(text.charCodeAt(at))
    ? at - 1
    : at;
}

const linear = (run: DocMarkdownPositions['runs'][number]) =>
  run.to - run.from === run.end - run.start;

/**
 * The Markdown offset of editor position `pos`. A position in syntax or in an
 * empty block (no text run) snaps to the start of the next run.
 */
export function docSourceOffset(map: DocMarkdownPositions | null, pos: number): number | null {
  const runs = map?.runs;
  if (!runs?.length) return null;
  for (const run of runs) {
    if (pos < run.from) return run.start;
    if (pos <= run.to) {
      if (linear(run)) return run.start + (pos - run.from);
      return pos === run.to ? run.end : run.start;
    }
  }
  return runs.at(-1)!.end;
}

/**
 * The editor position of Markdown offset `offset`. An offset in syntax (`**`,
 * a line break between blocks) lands at the end of the text before it.
 */
export function docPositionForSource(map: DocMarkdownPositions | null, offset: number): number | null {
  const runs = map?.runs;
  if (!runs?.length) return null;
  let before: number | null = null;
  for (const run of runs) {
    if (offset < run.start) return before ?? run.from;
    if (offset <= run.end) {
      if (linear(run)) return run.from + (offset - run.start);
      return offset === run.end ? run.to : run.from;
    }
    before = run.to;
  }
  return before;
}

/** The caret at Markdown offset `caret`, as the doc cursor others draw. Null for an empty doc. */
export function docLiveCursor(markdown: string, caret: number): Extract<ArtifactLivePosition, { kind: 'doc' }> | null {
  if (!markdown.length) return null;
  const at = Math.min(Math.max(0, caret), markdown.length);
  let start = Math.max(0, at - DOC_LIVE_CURSOR_QUOTE / 2);
  const end = safeEnd(markdown, Math.min(markdown.length, start + DOC_LIVE_CURSOR_QUOTE));
  start = safeStart(markdown, Math.max(0, Math.min(start, end - DOC_LIVE_CURSOR_QUOTE)));
  if (end <= start) return null;
  const prefixStart = safeStart(markdown, Math.max(0, start - ARTIFACT_TEXT_CONTEXT_MAX));
  return {
    kind: 'doc',
    quote: markdown.slice(start, end),
    prefix: markdown.slice(prefixStart, start),
    offset: Math.min(Math.max(0, at - start), end - start),
  };
}

/**
 * The Markdown span `start`–`end` as the selection others tint. A span longer
 * than a quote holds (500) sends its first 500 code units.
 */
export function docLiveRange(
  markdown: string,
  start: number,
  end: number,
): Extract<ArtifactLiveRange, { kind: 'doc' }> | null {
  const from = safeStart(markdown, Math.max(0, Math.min(start, end)));
  const to = safeEnd(markdown, Math.min(markdown.length, Math.max(start, end), from + ARTIFACT_TEXT_QUOTE_MAX));
  if (to <= from) return null;
  const prefixStart = safeStart(markdown, Math.max(0, from - ARTIFACT_TEXT_CONTEXT_MAX));
  const suffixEnd = safeEnd(markdown, Math.min(markdown.length, to + ARTIFACT_TEXT_CONTEXT_MAX));
  return {
    kind: 'doc',
    quote: markdown.slice(from, to),
    prefix: markdown.slice(prefixStart, from),
    suffix: markdown.slice(to, suffixEnd),
  };
}

/** The words on each side of a caret that place it inside its matched quote. */
const CARET_CONTEXT = 12;

/** Where a remote doc caret is in this viewer's Markdown, or null when its words are gone. */
export function resolveDocLiveCursor(
  markdown: string,
  at: Pick<Extract<ArtifactLivePosition, { kind: 'doc' }>, 'quote' | 'prefix' | 'offset'>,
  budget?: ArtifactReanchorBudget,
): number | null {
  const found = reanchorArtifactText(
    markdown,
    { type: 'text', version: 'live', quote: at.quote, prefix: at.prefix, suffix: '' },
    budget,
  );
  if (found.start === null || found.end === null) return null;
  // The quote matched with edits: an edit before the caret moves it. Place the caret by the
  // words right after it (else right before it), at the match nearest to its old offset.
  const region = markdown.slice(found.start, found.end);
  const nearest = (needle: string, shift: number) => {
    let best: number | null = null;
    for (let i = region.indexOf(needle); i !== -1; i = region.indexOf(needle, i + 1)) {
      const caret = i + shift;
      if (best === null || Math.abs(caret - at.offset) < Math.abs(best - at.offset)) best = caret;
    }
    return best;
  };
  const after = at.quote.slice(at.offset, at.offset + CARET_CONTEXT);
  const before = at.quote.slice(Math.max(0, at.offset - CARET_CONTEXT), at.offset);
  const caret =
    (after ? nearest(after, 0) : null) ??
    (before ? nearest(before, before.length) : null) ??
    Math.min(at.offset, region.length);
  return found.start + caret;
}

/** Where a remote doc selection is in this viewer's Markdown, or null when its words are gone. */
export function resolveDocLiveRange(
  markdown: string,
  range: Pick<Extract<ArtifactLiveRange, { kind: 'doc' }>, 'quote' | 'prefix' | 'suffix'>,
  budget?: ArtifactReanchorBudget,
): { start: number; end: number } | null {
  const found = reanchorArtifactText(
    markdown,
    { type: 'text', version: 'live', quote: range.quote, prefix: range.prefix, suffix: range.suffix },
    budget,
  );
  return found.start === null || found.end === null ? null : { start: found.start, end: found.end };
}

type DocLiveCursorAnchor = Pick<Extract<ArtifactLivePosition, { kind: 'doc' }>, 'quote' | 'prefix' | 'offset'>;
type DocLiveRangeAnchor = Pick<Extract<ArtifactLiveRange, { kind: 'doc' }>, 'quote' | 'prefix' | 'suffix'>;

/** The anchors one remote participant reports in the doc. */
export interface DocLivePeerAnchors {
  id: string;
  cursor: DocLiveCursorAnchor | null;
  selection: DocLiveRangeAnchor | null;
}

/** Where one participant is in this viewer's Markdown. Null parts: nothing to draw. */
export interface DocLivePlace {
  selection: { start: number; end: number } | null;
  cursor: number | null;
}

/** The re-anchoring a pass spends its budget on. Tests count its scans. */
export interface DocLiveReanchor {
  cursor: (markdown: string, at: DocLiveCursorAnchor, budget: ArtifactReanchorBudget) => number | null;
  range: (
    markdown: string,
    range: DocLiveRangeAnchor,
    budget: ArtifactReanchorBudget,
  ) => { start: number; end: number } | null;
}

export const DOC_LIVE_REANCHOR: DocLiveReanchor = { cursor: resolveDocLiveCursor, range: resolveDocLiveRange };

/** A presence pass never spends less than this: a small doc still affords one fuzzy 500-unit quote. */
const DOC_LIVE_PASS_FLOOR = 1 << 19;

/**
 * The re-anchoring one presence pass may spend: 4 × the Markdown length, about four
 * whole-document fuzzy scans. Never below DOC_LIVE_PASS_FLOOR, never above one read budget.
 */
export function docLivePassBudget(markdown: string): ArtifactReanchorBudget {
  return {
    remaining: Math.min(ARTIFACT_REANCHOR_READ_UNITS, Math.max(DOC_LIVE_PASS_FLOOR, 4 * markdown.length)),
  };
}

/** A resolved part of a participant, and the position value it was resolved from. */
interface Resolved<T> {
  key: string;
  value: T | null;
}

interface DocLiveCacheEntry {
  selection?: Resolved<{ start: number; end: number }>;
  cursor?: Resolved<number>;
}

/** What one pass hands the next. */
export interface DocLiveResolution {
  /** The Markdown the cache was resolved in: an edit empties it. */
  markdown: string;
  /** Each participant's resolved parts, by participant id. */
  cache: ReadonlyMap<string, DocLiveCacheEntry>;
  /** The budget units each participant has cost so far: the cheapest goes next. */
  cost: ReadonlyMap<string, number>;
  /** The number of passes so far. */
  pass: number;
}

/** A part the participant does not report: nothing to draw, nothing to re-anchor. */
const NO_PART: Resolved<never> = { key: '', value: null };

/** A part's last result while its position value is unchanged. Undefined: it needs a re-anchor. */
function reuse<T>(anchor: object | null, last: Resolved<T> | undefined): Resolved<T> | undefined {
  if (!anchor) return NO_PART;
  return last?.key === JSON.stringify(anchor) ? last : undefined;
}

/**
 * Where each remote participant is in `markdown`, for one presence pass.
 *
 * The cost of a pass is bounded, whatever the room holds:
 * - A part (caret or selection) whose position value is unchanged reuses its last result while
 *   the Markdown is unchanged. It costs no scan, even when its words are gone.
 * - All other work shares one pass budget (`docLivePassBudget`: 4 × the Markdown length).
 *   `reanchorArtifactText` tests the budget before it charges a scan, so a pass spends at most
 *   that budget plus the one scan that crosses it.
 * - Work goes one part at a time to the participant that has cost the least so far. One that
 *   sends a fresh unmatched quote every frame pays for each, falls behind, and cannot starve
 *   the others. A participant that joins starts one pass budget behind everyone present:
 *   joining or rejoining buys no turn, and a burst of joiners cannot crowd out the
 *   participants already drawn. Without contention every participant is served at once.
 *
 * A participant missing from `places` was not resolved in this pass: draw nothing for it,
 * never its last place.
 */
export function resolveDocLivePlaces(
  markdown: string,
  peers: readonly DocLivePeerAnchors[],
  previous: DocLiveResolution | null,
  reanchor: DocLiveReanchor = DOC_LIVE_REANCHOR,
): { places: Map<string, DocLivePlace>; resolution: DocLiveResolution } {
  const cached = previous?.markdown === markdown ? previous.cache : new Map<string, DocLiveCacheEntry>();
  const budget = docLivePassBudget(markdown);
  // A participant that joins starts one pass budget behind the costliest one present.
  let joining = 0;
  for (const value of previous?.cost.values() ?? []) joining = Math.max(joining, value + budget.remaining);
  const cost = new Map<string, number>();
  const entries = new Map<string, DocLiveCacheEntry>();
  const work: { peer: DocLivePeerAnchors; part: 'selection' | 'cursor' }[] = [];
  for (const peer of peers) {
    cost.set(peer.id, previous?.cost.get(peer.id) ?? joining);
    const last = cached.get(peer.id);
    const entry = { selection: reuse(peer.selection, last?.selection), cursor: reuse(peer.cursor, last?.cursor) };
    if (!entry.selection) work.push({ peer, part: 'selection' });
    if (!entry.cursor) work.push({ peer, part: 'cursor' });
    entries.set(peer.id, entry);
  }
  // A miss with budget left means the words are gone. A miss that emptied the budget may be the
  // budget's doing, so it is not kept: a later pass tries again.
  const kept = (value: unknown) => value !== null || budget.remaining > 0;
  while (work.length && budget.remaining > 0) {
    // The cheapest participant so far; equal costs keep the room's order.
    let next = 0;
    for (let i = 1; i < work.length; i++)
      if (cost.get(work[i]!.peer.id)! < cost.get(work[next]!.peer.id)!) next = i;
    const { peer, part } = work.splice(next, 1)[0]!;
    const entry = entries.get(peer.id)!;
    const before = budget.remaining;
    if (part === 'selection') {
      const value = reanchor.range(markdown, peer.selection!, budget);
      if (kept(value)) entry.selection = { key: JSON.stringify(peer.selection), value };
    } else {
      const value = reanchor.cursor(markdown, peer.cursor!, budget);
      if (kept(value)) entry.cursor = { key: JSON.stringify(peer.cursor), value };
    }
    cost.set(peer.id, cost.get(peer.id)! + before - budget.remaining);
  }
  const cache = new Map<string, DocLiveCacheEntry>();
  const places = new Map<string, DocLivePlace>();
  for (const [id, entry] of entries) {
    if (entry.selection || entry.cursor) cache.set(id, entry);
    if (entry.selection && entry.cursor)
      places.set(id, { selection: entry.selection.value, cursor: entry.cursor.value });
  }
  return { places, resolution: { markdown, cache, cost, pass: (previous?.pass ?? 0) + 1 } };
}
