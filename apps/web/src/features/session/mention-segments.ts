/**
 * Split a message's visible text into plain runs and mention runs.
 *
 * One implementation, because there were two: `turn/user-message.tsx` and
 * `optimistic-turn.tsx`'s `HighlightMentions` each carried a near-identical
 * copy of this walk, and they had already disagreed. The sent-message copy
 * took an early return the moment it had ANY ref — so a message carrying a
 * `<session_ref>` never ran the `@` regex, and every other mention in that
 * message silently rendered as plain text. The optimistic copy ran both and
 * got it right. This is the superset: server refs, then session titles, then
 * a regex fill over whatever range is still uncovered.
 *
 * React-free on purpose — `mention-chip.tsx` owns how a segment LOOKS, this
 * owns where segments ARE, and only the latter is worth testing without a DOM.
 */

export type MentionSegmentType = 'file' | 'agent' | 'session';

export interface MentionSegment {
  text: string;
  /** Absent for a plain run of prose. */
  type?: MentionSegmentType;
}

/**
 * A mention the SERVER located for us, as a half-open `[start, end)` range
 * into the same text passed to `buildMentionSegments`. More accurate than the
 * regex when present — it knows a file part's exact source span.
 */
export interface MentionSourceRef {
  start: number;
  end: number;
  type: MentionSegmentType;
}

interface Range {
  start: number;
  end: number;
  type: MentionSegmentType;
}

/**
 * `@` must open a token, not sit inside one.
 *
 * Group 1 is the leading boundary (start-of-string or whitespace) and exists
 * only to be measured — its length is added back to get the `@`'s real offset.
 * Written this way rather than as a lookbehind because the offset arithmetic
 * is explicit and the pattern stays readable.
 *
 * This is what keeps `ship it, mail me at jay@kortix.com` from rendering
 * `@kortix.com` as a file chip. The old inline regex was a bare `/@(\S+)/g`,
 * which matched mid-token and turned every email address in a message into a
 * mention.
 */
const MENTION_REGEX = /(^|\s)@(\S+)/g;

/** Trailing punctuation is sentence, not name: `@README.md,` ends at `md`. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

function overlaps(ranges: Range[], start: number, end: number): boolean {
  return ranges.some((r) => start < r.end && end > r.start);
}

/**
 * Classify a bare `@token`. `ses_`-prefixed ids are session links the composer
 * emitted without a resolvable title; a name we know belongs to an agent is an
 * agent; everything else is addressed as a workspace file, which is what the
 * click handler will try to open.
 */
export function classifyMentionToken(
  token: string,
  agentNames: ReadonlySet<string>,
): MentionSegmentType {
  if (token.startsWith('ses_')) return 'session';
  if (agentNames.has(token)) return 'agent';
  return 'file';
}

export function buildMentionSegments({
  text,
  sourceRefs = [],
  sessionTitles = [],
  agentNames = [],
}: {
  text: string;
  /** Server-located spans — takes precedence over everything below. */
  sourceRefs?: readonly MentionSourceRef[];
  /** `<session_ref>` titles, matched as `@<title>` (titles contain spaces). */
  sessionTitles?: readonly string[];
  /** Known agent names, so `@build` chips as an agent rather than a file. */
  agentNames?: readonly string[];
}): MentionSegment[] {
  if (!text) return [];

  const ranges: Range[] = [];

  // Session titles first. A title can contain spaces, so no regex can find it
  // — and the server, which cannot either, reports `@Fix the parser` as a file
  // mention of the first word only. Claiming the range here is what stops that
  // wrong, narrower ref from winning.
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
    ranges.push({ start: ref.start, end: ref.end, type: ref.type });
  }

  // Regex fill — every `@token` the two structured sources did not already
  // claim. This runs unconditionally, which is the bug fix: the sent-message
  // copy used to skip it entirely whenever a single structured ref existed.
  const agentSet = new Set(agentNames);
  MENTION_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MENTION_REGEX.exec(text)) !== null) {
    const start = match.index + match[1].length;
    const token = match[2].replace(TRAILING_PUNCTUATION, '');
    if (!token) continue;
    const end = start + 1 + token.length;
    if (overlaps(ranges, start, end)) continue;
    ranges.push({ start, end, type: classifyMentionToken(token, agentSet) });
  }

  if (ranges.length === 0) return [{ text }];

  // Longest-first on a tie so a broad session range beats the narrow file ref
  // the server reported for its first word.
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
