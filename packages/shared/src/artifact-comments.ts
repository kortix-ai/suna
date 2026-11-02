import { z } from 'zod';

const anchorText = z.string().regex(/^[^\u0000\uD800-\uDFFF]*$/u, 'Anchor text must be valid Unicode without NUL');
const version = anchorText.min(1).max(512);
const fraction = z.number().finite().min(0).max(1);
const scroll = z.object({ x: z.number().finite().min(0), y: z.number().finite().min(0) }).strict();
const page = {
  version,
  selector: anchorText.min(1).max(2048),
  snippet: anchorText.max(120),
  viewport_width: z.number().finite().positive(),
  scroll,
};

/** The longest text quote, in UTF-16 code units: a paragraph. A longer selection is refused, never cut. */
export const ARTIFACT_TEXT_QUOTE_MAX = 500;
/** The longest prefix and suffix, in UTF-16 code units. */
export const ARTIFACT_TEXT_CONTEXT_MAX = 32;

export const artifactCommentAnchorSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    version,
    quote: anchorText.min(1).max(ARTIFACT_TEXT_QUOTE_MAX),
    prefix: anchorText.max(ARTIFACT_TEXT_CONTEXT_MAX),
    suffix: anchorText.max(ARTIFACT_TEXT_CONTEXT_MAX),
  }).strict(),
  z.object({ type: z.literal('point'), ...page, offset: z.object({ x: fraction, y: fraction }).strict() }).strict(),
  z.object({
    type: z.literal('region'),
    ...page,
    offset: z.object({ x: fraction, y: fraction, width: fraction.positive(), height: fraction.positive() }).strict(),
  }).strict(),
  z.object({ type: z.literal('none'), version }).strict(),
]).superRefine((anchor, ctx) => {
  if (anchor.type === 'region' && (anchor.offset.x + anchor.offset.width > 1 || anchor.offset.y + anchor.offset.height > 1)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['offset'], message: 'Region exceeds the element box' });
  }
});

const markPoint = z.object({ x: fraction, y: fraction }).strict();
const markStyle = {
  color: z.enum(['black', 'red', 'blue']),
  width: z.number().finite().min(0.001).max(0.05),
};
export const artifactCommentMarkSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('pen'), ...markStyle, points: z.array(markPoint).min(2).max(1024) }).strict(),
  z.object({ tool: z.literal('arrow'), ...markStyle, points: z.array(markPoint).length(2) }).strict(),
  z.object({ tool: z.literal('rectangle'), ...markStyle, points: z.array(markPoint).length(2) }).strict(),
]).superRefine((mark, ctx) => {
  if (mark.tool === 'pen') return;
  const [start, end] = mark.points;
  if (!start || !end) return;
  if (mark.tool === 'rectangle' ? start.x === end.x || start.y === end.y : start.x === end.x && start.y === end.y) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['points'], message: 'Mark endpoints must define a visible shape' });
  }
});
export const artifactCommentMarksSchema = z.array(artifactCommentMarkSchema).max(64).superRefine((marks, ctx) => {
  if (marks.reduce((total, mark) => total + mark.points.length, 0) > 8192) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Marks exceed the total point limit' });
  }
});
export type ArtifactCommentMark = z.infer<typeof artifactCommentMarkSchema>;

export type ArtifactCommentAnchor = z.infer<typeof artifactCommentAnchorSchema>;
export type ArtifactTextAnchor = Extract<ArtifactCommentAnchor, { type: 'text' }>;
export type ArtifactTextPosition = { start: number | null; end: number | null; outdated: boolean };

type Match = { start: number; end: number };
const outdated: ArtifactTextPosition = { start: null, end: null, outdated: true };
const position = ({ start, end }: Match): ArtifactTextPosition => ({ start, end, outdated: false });

function matchesContext(text: string, anchor: ArtifactTextAnchor, { start, end }: Match): boolean {
  return start >= anchor.prefix.length && text.startsWith(anchor.prefix, start - anchor.prefix.length) &&
    text.startsWith(anchor.suffix, end);
}

function preferMatch(text: string, anchor: ArtifactTextAnchor, match: Match, previous: Match): boolean {
  const context = Number(matchesContext(text, anchor, match));
  const previousContext = Number(matchesContext(text, anchor, previous));
  return context > previousContext || (context === previousContext &&
    Math.abs(match.end - match.start - anchor.quote.length) < Math.abs(previous.end - previous.start - anchor.quote.length));
}

function fuzzySpans(text: string, quote: string, end: number, limit: number, distance: number): Match[] {
  const length = Math.min(quote.length + limit, end);
  let previous = new Uint8Array(length + 1);
  let current = new Uint8Array(length + 1);
  for (let j = 0; j <= length; j++) previous[j] = j;
  for (let i = 1; i <= quote.length; i++) {
    current[0] = i;
    const character = quote.charCodeAt(quote.length - i);
    for (let j = 1; j <= length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1,
        previous[j - 1] + Number(character !== text.charCodeAt(end - j)));
    }
    [previous, current] = [current, previous];
  }
  const matches: Match[] = [];
  for (let size = Math.max(1, quote.length - limit); size <= length; size++) {
    if (previous[size] === distance) matches.push({ start: end - size, end });
  }
  return matches;
}

/** The bit-vector fuzzy search below holds one quote character per bit of a 32-bit word. */
const FUZZY_WORD = 32;
/** The edit budget of one search word: ten percent of 32 code units. */
const WORD_LIMIT = Math.floor(FUZZY_WORD / 10);
/** More hits than this for one search word: the text repeats too much for that word to point anywhere. */
const MAX_WORD_HITS = 1 << 16;
/** The alignment work one long quote may spend, in edit-distance cells (a few ms). More marks it outdated. */
const MAX_ALIGN_CELLS = 1 << 20;

/**
 * The re-anchoring work one read may spend across all its threads (about 100 ms):
 * fuzzy-scanned code units plus alignment cells, and an eighth of a code unit
 * per natively exact-scanned one. A list re-anchors every stored thread, and a
 * commenter can store many unmatched quotes, so the cost of one read must not
 * grow with the thread count. A thread past the budget is outdated for that read.
 */
export const ARTIFACT_REANCHOR_READ_UNITS = 1 << 24;

export interface ArtifactReanchorBudget {
  remaining: number;
}

/** One budget per read: pass the same object to every reanchorArtifactText call of that read. */
export function createArtifactReanchorBudget(): ArtifactReanchorBudget {
  return { remaining: ARTIFACT_REANCHOR_READ_UNITS };
}

/**
 * The read budget split into equal shares, one per thread author (a person or an
 * agent session). A commenter whose quotes match nothing spends only their own
 * share, so other people's threads still re-anchor; the read's total stays at
 * ARTIFACT_REANCHOR_READ_UNITS. Name every author of the read up front.
 */
export function createArtifactReanchorBudgets(authors: Iterable<string>): (author: string) => ArtifactReanchorBudget {
  const share = Math.floor(ARTIFACT_REANCHOR_READ_UNITS / Math.max(1, new Set(authors).size));
  const budgets = new Map<string, ArtifactReanchorBudget>();
  return (author) => {
    let budget = budgets.get(author);
    if (!budget) budgets.set(author, (budget = { remaining: share }));
    return budget;
  };
}

/**
 * Every place where `word` (at most 32 code units) matches with at most
 * `limit` edits, grouped by edit count. Forward, a place is the end of a match;
 * backward, it is the start. null when there are more than MAX_WORD_HITS.
 */
function wordHits(text: string, word: string, limit: number, forward: boolean): number[][] | null {
  const length = word.length;
  const masks = new Int32Array(65536);
  for (let i = 0; i < length; i++) masks[word.charCodeAt(forward ? i : length - 1 - i)] |= 1 << i;
  const high = 1 << (length - 1);
  const hits: number[][] = Array.from({ length: limit + 1 }, () => []);
  let positive = -1;
  let negative = 0;
  let distance = length;
  let count = 0;
  // The same Myers recurrence as the short-quote search. Read backward over the
  // reversed word, the free leading text is free trailing text: starts, not ends.
  for (let step = 0; step < text.length; step++) {
    const at = forward ? step : text.length - 1 - step;
    const equal = masks[text.charCodeAt(at)];
    const vertical = equal | negative;
    const horizontal = (((equal & positive) + positive) ^ positive) | equal;
    let positiveHorizontal = negative | ~(horizontal | positive);
    let negativeHorizontal = positive & horizontal;
    if (positiveHorizontal & high) distance++;
    if (negativeHorizontal & high) distance--;
    positiveHorizontal <<= 1;
    negativeHorizontal <<= 1;
    positive = negativeHorizontal | ~(vertical | positiveHorizontal);
    negative = positiveHorizontal & vertical;
    if (distance > limit) continue;
    if (++count > MAX_WORD_HITS) return null;
    hits[distance]!.push(forward ? at + 1 : at);
  }
  return hits;
}

type AlignWork = { cells: number; previous: Uint16Array; current: Uint16Array };

/**
 * Align the whole `quote` with `text` read from `at` forward (or backward).
 * Returns the text length with the fewest edits, at most `limit` (ties: the
 * length closest to the quote's), or null. A path of at most `limit` edits never
 * leaves the diagonal band of half-width `limit`, so only that band is computed,
 * and a row whose every cell exceeds `limit` ends the alignment.
 */
function align(text: string, quote: string, at: number, forward: boolean, limit: number, work: AlignWork): { length: number; distance: number } | null {
  const length = quote.length;
  const width = Math.min(length + limit, forward ? text.length - at : at);
  if (width < length - limit) return null;
  const over = limit + 1;
  let { previous, current } = work;
  for (let j = 0; j <= Math.min(limit, width); j++) previous[j] = j;
  for (let i = 1; i <= length; i++) {
    const low = Math.max(0, i - limit);
    const high = Math.min(width, i + limit);
    // The cells just outside the band hold another row's values: read them as "over the limit".
    if (high === i + limit) previous[high] = over;
    if (low) current[low - 1] = over;
    else current[0] = i;
    const character = quote.charCodeAt(forward ? i - 1 : length - i);
    let least = low ? over : i;
    for (let j = Math.max(1, low); j <= high; j++) {
      const cell = Math.min(previous[j]! + 1, current[j - 1]! + 1,
        previous[j - 1]! + Number(character !== text.charCodeAt(forward ? at + j - 1 : at - j)));
      current[j] = cell;
      if (cell < least) least = cell;
    }
    work.cells += high - low + 1;
    if (least > limit) return null;
    [previous, current] = [current, previous];
  }
  let best = -1;
  for (let j = Math.max(1, length - limit); j <= width; j++) {
    if (previous[j]! > limit) continue;
    if (best < 0 || previous[j]! < previous[best]! ||
      (previous[j] === previous[best] && Math.abs(j - length) < Math.abs(best - length))) best = j;
  }
  return best < 0 ? null : { length: best, distance: previous[best]! };
}

/**
 * A quote longer than one search word. Every start where its first 32 code
 * units match with at most 3 edits, and every end where its last 32 do, is a
 * candidate. The whole quote is aligned at each one, and the fewest whole-quote
 * edits win, within ten percent of the quote. A decoy that shares the opening
 * words loses to the passage that matches throughout.
 *
 * Spans whose edges differ by at most that edit count are one passage read with
 * different edges; the context and then the length closest to the quote's pick
 * the edges. Two passages at the fewest edits are outdated unless exactly one
 * matches the prefix and suffix: the anchor never guesses.
 *
 * A word's edit count bounds the whole quote's from below, so candidates run in
 * that order and stop once they cannot win. Every span of at most 3 edits starts
 * at an opening hit and ends at a closing hit. So when the opening hits already
 * give at most 3 edits, the closing search cannot change the answer and is
 * skipped. When one side has too many hits, the other side alone decides, and
 * only a result of at most 3 edits is certain.
 */
function reanchorLongText(text: string, anchor: ArtifactTextAnchor, budget: ArtifactReanchorBudget): ArtifactTextPosition {
  const { quote } = anchor;
  let best = Math.floor(quote.length / 10);
  const work: AlignWork = { cells: 0, previous: new Uint16Array(quote.length + best + 2), current: new Uint16Array(quote.length + best + 2) };
  try {
    return longTextPlace(text, anchor, budget, work, best);
  } finally {
    budget.remaining -= work.cells;
  }
}

function longTextPlace(text: string, anchor: ArtifactTextAnchor, budget: ArtifactReanchorBudget, work: AlignWork, limit: number): ArtifactTextPosition {
  const { quote } = anchor;
  let best = limit;
  let spans: Match[] = [];
  let skipped = false;
  for (const fromStart of [true, false]) {
    if (!fromStart && spans.length && best <= WORD_LIMIT) break;
    // Each word search reads the whole text once.
    if (budget.remaining - work.cells <= 0) return { ...outdated };
    budget.remaining -= text.length;
    // The opening words give starts (a backward search); the closing words give ends.
    const hits = wordHits(text, fromStart ? quote.slice(0, FUZZY_WORD) : quote.slice(-FUZZY_WORD), WORD_LIMIT, !fromStart);
    if (!hits) {
      skipped = true;
      continue;
    }
    for (let bound = 0; bound <= WORD_LIMIT && bound <= best; bound++) {
      for (const at of hits[bound]!) {
        if (bound > best) break;
        const found = align(text, quote, at, fromStart, best, work);
        if (work.cells > MAX_ALIGN_CELLS || budget.remaining - work.cells <= 0) return { ...outdated };
        if (!found) continue;
        if (found.distance < best) {
          best = found.distance;
          spans = [];
        }
        spans.push(fromStart ? { start: at, end: at + found.length } : { start: at - found.length, end: at });
      }
    }
  }
  if (!spans.length || (skipped && best > WORD_LIMIT)) return { ...outdated };
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  const places: Match[] = [];
  let first: Match | null = null;
  for (const span of spans) {
    if (first && span.start - first.start <= best && Math.abs(span.end - first.end) <= best) {
      if (preferMatch(text, anchor, span, places[places.length - 1]!)) places[places.length - 1] = span;
      continue;
    }
    first = span;
    places.push(span);
  }
  if (places.length === 1) return position(places[0]!);
  const contextual = places.filter((span) => matchesContext(text, anchor, span));
  return contextual.length === 1 ? position(contextual[0]!) : { ...outdated };
}

/**
 * Where a text anchor sits in `text` now. Every scan spends `budget`; a caller
 * that re-anchors many threads in one read passes one shared budget
 * (createArtifactReanchorBudget), so the read's cost is bounded.
 */
export function reanchorArtifactText(
  text: string,
  anchor: ArtifactTextAnchor,
  budget: ArtifactReanchorBudget = createArtifactReanchorBudget(),
): ArtifactTextPosition {
  const { quote, prefix, suffix } = anchor;
  const length = quote.length;
  if (!length || length > ARTIFACT_TEXT_QUOTE_MAX) return { ...outdated };
  // A native exact scan costs about an eighth of a fuzzy scan per code unit.
  const scan = Math.ceil(text.length / 8);
  if (budget.remaining <= 0) return { ...outdated };
  budget.remaining -= scan;
  const exact = text.indexOf(quote);
  if (exact !== -1) {
    budget.remaining -= scan;
    if (text.indexOf(quote, exact + 1) === -1) return position({ start: exact, end: exact + length });
    const context = prefix + quote + suffix;
    budget.remaining -= 2 * scan;
    const start = text.indexOf(context);
    if (start === -1 || text.indexOf(context, start + 1) !== -1) return { ...outdated };
    return position({ start: start + prefix.length, end: start + prefix.length + length });
  }
  if (budget.remaining <= 0) return { ...outdated };
  if (length > FUZZY_WORD) return reanchorLongText(text, anchor, budget);

  const limit = Math.floor(length / 10);
  if (!limit) return { ...outdated };
  // The short-quote search reads the whole text once.
  budget.remaining -= text.length;
  const masks = new Int32Array(65536);
  for (let i = 0; i < length; i++) masks[quote.charCodeAt(i)] |= 1 << i;
  const high = 1 << (length - 1);
  let positive = -1;
  let negative = 0;
  let distance = length;
  let best = limit;
  let first: Match | null = null;
  let multiple = false;
  let contextual: Match | null = null;
  let contextMultiple = false;
  let prefixAt = prefix ? text.indexOf(prefix) : 0;
  // Each budget's bits track matched quote prefixes after an exact context prefix.
  // Separate root bits allow insertions before the first matched quote character.
  const contextStates = new Int32Array(limit + 1);
  const rootMask = (1 << (limit + 1)) - 1;
  const patternMask = length === 32 ? -1 : (1 << length) - 1;
  let contextRoots = 0;
  let contextActive = false;

  // Myers' bit-vector recurrence uses free leading text for substring matching.
  // Quote length is at most 32, so one word carries every edit-distance cell.
  for (let end = 1; end <= text.length; end++) {
    const equal = masks[text.charCodeAt(end - 1)];
    const vertical = equal | negative;
    const horizontal = (((equal & positive) + positive) ^ positive) | equal;
    let positiveHorizontal = negative | ~(horizontal | positive);
    let negativeHorizontal = positive & horizontal;
    if (positiveHorizontal & high) distance++;
    if (negativeHorizontal & high) distance--;
    positiveHorizontal <<= 1;
    negativeHorizontal <<= 1;
    positive = negativeHorizontal | ~(vertical | positiveHorizontal);
    negative = positiveHorizontal & vertical;
    if (prefix) {
      if (prefixAt !== -1 && prefixAt + prefix.length === end - 1) {
        contextRoots = rootMask;
        for (let errors = 1; errors <= limit; errors++) contextStates[errors] |= (1 << errors) - 1;
        contextActive = true;
        prefixAt = text.indexOf(prefix, prefixAt + 1);
      }
      if (contextActive) {
        const previousRoots = contextRoots;
        contextRoots = (contextRoots << 1) & rootMask;
        let lowerOld = 0;
        let lowerNew = 0;
        let active = contextRoots;
        for (let errors = 0; errors <= limit; errors++) {
          const old = contextStates[errors];
          let next = (((old << 1) | ((previousRoots >> errors) & 1)) & equal);
          if (errors) next |= (lowerOld << 1) | ((previousRoots >> (errors - 1)) & 1) |
            lowerOld | (lowerNew << 1) | ((contextRoots >> (errors - 1)) & 1) | lowerNew;
          contextStates[errors] = next & patternMask;
          lowerOld = old;
          lowerNew = contextStates[errors];
          active |= lowerNew;
        }
        contextActive = active !== 0;
      }
    }
    if (distance > best) continue;
    if (distance < best) {
      best = distance;
      first = contextual = null;
      multiple = contextMultiple = false;
    }
    const possibleContext = (!prefix || (contextStates[best] & high) !== 0) && text.startsWith(suffix, end);
    if (multiple && (contextMultiple || !possibleContext)) continue;
    for (const match of fuzzySpans(text, quote, end, limit, distance)) {
      if (!first) first = match;
      else if (first.start !== match.start) multiple = true;
      else if (preferMatch(text, anchor, match, first)) first = match;
      if (matchesContext(text, anchor, match)) {
        if (!contextual) contextual = match;
        else if (contextual.start !== match.start) contextMultiple = true;
        else if (preferMatch(text, anchor, match, contextual)) contextual = match;
      }
    }
    if (best === 1 && contextMultiple) return { ...outdated };
  }
  if (!first || (multiple && (!contextual || contextMultiple))) return { ...outdated };
  return position(multiple ? contextual! : first);
}
