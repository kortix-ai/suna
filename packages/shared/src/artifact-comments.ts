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

export type ArtifactCommentAnchor = z.infer<typeof artifactCommentAnchorSchema>;
export type ArtifactTextAnchor = Extract<ArtifactCommentAnchor, { type: 'text' }>;
export type ArtifactTextPosition = { start: number | null; end: number | null; outdated: boolean };

type Match = { start: number; end: number; distance: number };
const outdated: ArtifactTextPosition = { start: null, end: null, outdated: true };

function matchesContext(text: string, anchor: ArtifactTextAnchor, { start, end }: Match): boolean {
  return text.slice(Math.max(0, start - anchor.prefix.length), start) === anchor.prefix &&
    text.slice(end, end + anchor.suffix.length) === anchor.suffix;
}

function chooseMatch(text: string, anchor: ArtifactTextAnchor, matches: Match[]): ArtifactTextPosition {
  if (matches.length > 1) {
    matches = matches.filter((match) => matchesContext(text, anchor, match));
  }
  if (matches.length !== 1) return { ...outdated };
  const { start, end } = matches[0];
  return { start, end, outdated: false };
}

export function reanchorArtifactText(text: string, anchor: ArtifactTextAnchor): ArtifactTextPosition {
  if (!anchor.quote) return { ...outdated };
  const exact: Match[] = [];
  for (let start = text.indexOf(anchor.quote); start !== -1; start = text.indexOf(anchor.quote, start + 1)) {
    exact.push({ start, end: start + anchor.quote.length, distance: 0 });
  }
  if (exact.length) return chooseMatch(text, anchor, exact);

  const limit = Math.floor(anchor.quote.length / 10);
  if (!limit) return { ...outdated };
  let distances = Array.from({ length: anchor.quote.length + 1 }, (_, i) => i);
  let starts = distances.map((distance) => distance <= limit ? [0] : []);
  const candidates = new Map<number, Match>();
  let best = limit;
  for (let end = 1; end <= text.length; end++) {
    const next = [0];
    const nextStarts: number[][] = [[end]];
    for (let i = 1; i <= anchor.quote.length; i++) {
      const substitution = distances[i - 1] + Number(anchor.quote[i - 1] !== text[end - 1]);
      const insertion = distances[i] + 1;
      const deletion = next[i - 1] + 1;
      next[i] = Math.min(substitution, insertion, deletion);
      nextStarts[i] = [];
      if (next[i] <= limit) {
        for (const [distance, offsets] of [[substitution, starts[i - 1]], [insertion, starts[i]], [deletion, nextStarts[i - 1]]] as const) {
          if (distance !== next[i]) continue;
          for (const offset of offsets) if (!nextStarts[i].includes(offset)) nextStarts[i].push(offset);
        }
      }
    }
    distances = next;
    starts = nextStarts;
    const distance = distances[anchor.quote.length];
    if (distance > best) continue;
    if (distance < best) {
      best = distance;
      candidates.clear();
    }
    for (const start of starts[anchor.quote.length]) {
      if (start === end) continue;
      const match = { start, end, distance };
      const previous = candidates.get(start);
      const context = Number(matchesContext(text, anchor, match));
      const previousContext = previous ? Number(matchesContext(text, anchor, previous)) : -1;
      if (context > previousContext || (context === previousContext && previous && Math.abs(end - start - anchor.quote.length) < Math.abs(previous.end - start - anchor.quote.length))) {
        candidates.set(start, match);
      }
    }
  }
  return chooseMatch(text, anchor, [...candidates.values()]);
}
