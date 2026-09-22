/**
 * Mention and command chips in a sent user message — where they are and what
 * they say. A port of apps/web `features/session/mention-segments.ts` and the
 * text helpers of `features/session/mention-chip.tsx`, so both apps split a
 * message the same way. `components/session/mention-chip.tsx` owns how a chip
 * looks.
 */

export type MentionSegmentType = 'file' | 'agent' | 'session';

/** `file` | `agent` | `session` | `command`. */
export type ChipKind = MentionSegmentType | 'command';

export interface MentionSegment {
  text: string;
  /** Absent for a plain run of prose. */
  type?: MentionSegmentType;
}

/** A server-located mention as a half-open `[start, end)` range into the text. */
export interface MentionSourceRef {
  start: number;
  end: number;
  type: MentionSegmentType;
}

/** `/` for a slash command, `@` for every reference kind. */
export function chipPrefix(kind: string): string {
  return kind === 'command' ? '/' : '@';
}

/** The chip's visible text. */
export function chipText(kind: string, label: string): string {
  return `${chipPrefix(kind)}${label}`;
}

/** The chip's accessibility label. */
export function chipAccessibilityLabel(kind: string, label: string): string {
  return kind === 'command' ? `command: /${label}` : `${kind} mention: ${label}`;
}

/** `@` must open a token: start of text or after whitespace. */
const MENTION_REGEX = /(^|\s)@(\S+)/g;

/** Trailing punctuation belongs to the sentence: `@README.md,` ends at `md`. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

function overlaps(ranges: MentionSourceRef[], start: number, end: number): boolean {
  return ranges.some((r) => start < r.end && end > r.start);
}

/** `ses_` ids are sessions, known agent names are agents, the rest are files. */
export function classifyMentionToken(
  token: string,
  agentNames: ReadonlySet<string>,
): MentionSegmentType {
  if (token.startsWith('ses_')) return 'session';
  if (agentNames.has(token)) return 'agent';
  return 'file';
}

/**
 * Split text into plain runs and mention runs: session titles first (they
 * contain spaces), then server-located refs, then a regex fill over whatever
 * range is still uncovered.
 */
export function buildMentionSegments({
  text,
  sourceRefs = [],
  sessionTitles = [],
  agentNames = [],
}: {
  text: string;
  sourceRefs?: readonly MentionSourceRef[];
  sessionTitles?: readonly string[];
  agentNames?: readonly string[];
}): MentionSegment[] {
  if (!text) return [];

  const ranges: MentionSourceRef[] = [];

  for (const title of sessionTitles) {
    if (!title) continue;
    const needle = `@${title}`;
    const idx = text.indexOf(needle);
    if (idx === -1) continue;
    if (overlaps(ranges, idx, idx + needle.length)) continue;
    ranges.push({ start: idx, end: idx + needle.length, type: 'session' });
  }

  for (const ref of sourceRefs) {
    if (ref.start >= ref.end) continue;
    if (ref.start < 0 || ref.end > text.length) continue;
    if (overlaps(ranges, ref.start, ref.end)) continue;
    ranges.push(ref);
  }

  const agentSet = new Set(agentNames);
  const regex = new RegExp(MENTION_REGEX.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const start = match.index + match[1].length;
    const token = match[2].replace(TRAILING_PUNCTUATION, '');
    if (!token) continue;
    const end = start + 1 + token.length;
    if (overlaps(ranges, start, end)) continue;
    ranges.push({ start, end, type: classifyMentionToken(token, agentSet) });
  }

  if (ranges.length === 0) return [{ text }];

  ranges.sort((a, b) => a.start - b.start || b.end - a.end);

  const segments: MentionSegment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    if (range.start > cursor) segments.push({ text: text.slice(cursor, range.start) });
    segments.push({ text: text.slice(range.start, range.end), type: range.type });
    cursor = range.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}
