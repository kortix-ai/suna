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

export const artifactCommentAnchorSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    version,
    quote: anchorText.min(1).max(32),
    prefix: anchorText.max(32),
    suffix: anchorText.max(32),
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

export function reanchorArtifactText(text: string, anchor: ArtifactTextAnchor): ArtifactTextPosition {
  const { quote, prefix, suffix } = anchor;
  const length = quote.length;
  if (!length || length > 32) return { ...outdated };
  const exact = text.indexOf(quote);
  if (exact !== -1) {
    if (text.indexOf(quote, exact + 1) === -1) return position({ start: exact, end: exact + length });
    const context = prefix + quote + suffix;
    const start = text.indexOf(context);
    if (start === -1 || text.indexOf(context, start + 1) !== -1) return { ...outdated };
    return position({ start: start + prefix.length, end: start + prefix.length + length });
  }

  const limit = Math.floor(length / 10);
  if (!limit) return { ...outdated };
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
