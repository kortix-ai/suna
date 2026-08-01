import { stripKortixSystemTags } from '@/lib/utils/kortix-system-tags';
import { stripHtmlTags } from '@/lib/utils/strip-html-tags';
import { isFilePart, isTextPart, type FilePart, type TextPart, type Turn } from '@/ui';

import {
  parseAgentMentionReferences,
  parseFileMentionReferences,
  parseFileReferences,
  parseProjectReferences,
  parseReplyContext,
  parseSessionReferences,
  stripSystemPtyText,
} from './message-parsing';

export type MinimapMentionKind = 'agent' | 'file';

export interface MinimapSegment {
  /** For a mention this is the bare name — the `@` is drawn as an icon. */
  text: string;
  mention?: MinimapMentionKind;
}

export interface MinimapAttachment {
  key: string;
  name: string;
}

export interface MinimapItem {
  id: string;
  /** One-line label — the rail's accessible name and its tooltip. */
  text: string;
  /** The message body, split so @mentions can be drawn as chips. */
  segments: MinimapSegment[];
  attachments: MinimapAttachment[];
}

export interface MinimapDash {
  item: MinimapItem;
  index: number;
}

// How many dashes the collapsed rail shows at most. Longer sessions are
// down-sampled to this many so the rail stays quiet — every message is still
// reachable through the dash nearest to it.
export const MAX_DASHES = 12;

// The one-line label never shows more than this.
const MAX_ITEM_TEXT = 80;

// The card clamps to three lines in CSS, so this cap only exists to bound how
// much of a very long prompt we carry around per turn.
const MAX_BODY_TEXT = 320;

export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trimEnd() + '…';
}

// ============================================================================
// Rail geometry
// ============================================================================

/**
 * One dash row, in px. Rows TILE — the dash is centred inside a row and the
 * row is the button, so the whole rail column is a live target and there is no
 * dead gap between two messages.
 *
 * This value IS the visible gap: the row is `DASH_THICKNESS` of dash and the
 * rest is breathing room, so shrinking the rail is one number, not two.
 */
export const DASH_ROW_HEIGHT = 11;

/** Dash thickness, in px. */
export const DASH_THICKNESS = 3;

export const DASH_WIDTH_MAX = 16;
export const DASH_WIDTH_MIN = 6;
const DASH_WIDTH_FALLOFF = 0.45;

/**
 * The rail's width, in px — the longest dash plus its row padding.
 *
 * PINNED, not derived from content. Rows sized by their own dash would be
 * 31px wide at the tail and 46px at the focused one, so the column would have
 * unclickable pixels down its left edge and the whole rail would slide
 * sideways every time the taper moved.
 */
export const RAIL_WIDTH = DASH_WIDTH_MAX + 24;

/**
 * How long a dash is, given its distance in rows from the focused one.
 *
 * The focused dash is the longest and every neighbour decays geometrically
 * towards `DASH_WIDTH_MIN`, so the rail reads as a position indicator on its
 * own — before the preview card ever opens.
 */
export function dashWidth(distance: number): number {
  if (distance <= 0) return DASH_WIDTH_MAX;
  const span = DASH_WIDTH_MAX - DASH_WIDTH_MIN;
  return Math.round(DASH_WIDTH_MIN + span * DASH_WIDTH_FALLOFF ** distance);
}

/** How bright a dash is, given its distance in rows from the focused one. */
export function dashOpacity(distance: number): number {
  if (distance <= 0) return 1;
  return Math.max(0.2, 0.45 * 0.72 ** (distance - 1));
}

/** Where the preview card points, measured from the top of the rail. */
export function dashCenterY(row: number): number {
  return row * DASH_ROW_HEIGHT + DASH_ROW_HEIGHT / 2;
}

// ============================================================================
// Turn → item
// ============================================================================

interface Mention {
  name: string;
  kind: MinimapMentionKind;
}

const MENTION_FALLBACK_RE = /@([^\s@]+)/g;

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Split the message text so a mention can be drawn as a chip rather than as a
 * raw `@handle`.
 *
 * Named mentions are matched first, longest name first — an agent called
 * `Make Interfaces Feel Better` has to win over a bare `@Make`, and only an
 * explicit name list can tell us where the mention ends, because names contain
 * spaces. Anything left over falls back to a whitespace-delimited `@token`.
 */
export function buildSegments(text: string, mentions: Mention[]): MinimapSegment[] {
  if (!text) return [];

  const ranges: { start: number; end: number; name: string; kind: MinimapMentionKind }[] = [];
  const overlaps = (start: number, end: number) =>
    ranges.some((r) => start < r.end && end > r.start);

  const byLongestName = [...mentions].sort((a, b) => b.name.length - a.name.length);
  for (const mention of byLongestName) {
    if (!mention.name) continue;
    const needle = `@${mention.name}`;
    for (let from = 0; ; ) {
      const start = text.indexOf(needle, from);
      if (start === -1) break;
      const end = start + needle.length;
      if (!overlaps(start, end)) ranges.push({ start, end, name: mention.name, kind: mention.kind });
      from = end;
    }
  }

  MENTION_FALLBACK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MENTION_FALLBACK_RE.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (!overlaps(start, end)) ranges.push({ start, end, name: match[1], kind: 'file' });
  }

  if (ranges.length === 0) return [{ text }];

  ranges.sort((a, b) => a.start - b.start);
  const segments: MinimapSegment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) segments.push({ text: text.slice(cursor, range.start) });
    segments.push({ text: range.name, mention: range.kind });
    cursor = range.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}

function collectAttachments(
  fileParts: FilePart[],
  uploads: { filename: string }[],
  mentioned: { name: string }[],
): MinimapAttachment[] {
  const seen = new Set<string>();
  const out: MinimapAttachment[] = [];
  const push = (key: string, name: string) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ key, name });
  };
  fileParts.forEach((part, i) => push(part.id ?? `part:${i}`, part.filename || 'File'));
  uploads.forEach((file, i) => push(`upload:${i}`, file.filename));
  mentioned.forEach((file, i) => push(`ref:${i}`, file.name));
  return out;
}

/**
 * Everything the minimap knows about one user turn.
 *
 * The XML subsystems are consumed in the same order `UserMessage` consumes
 * them, so the preview shows the message the reader actually saw — not the
 * wire text with `<file_ref …>` tags still in it.
 *
 * Returns `null` for a turn with nothing to preview.
 */
export function extractMinimapItem(turn: Turn): MinimapItem | null {
  const parts = turn.userMessage.parts;

  const textParts = parts.filter(
    (p) => isTextPart(p) && !(p as TextPart).synthetic && !(p as { ignored?: boolean }).ignored,
  ) as TextPart[];
  const fileParts = parts.filter(isFilePart) as FilePart[];

  const raw = stripSystemPtyText(textParts.map((p) => p.text ?? '').join('\n'));
  const { cleanText: afterReply } = parseReplyContext(raw);
  const { cleanText: afterFiles, files: uploads } = parseFileReferences(afterReply);
  const { cleanText: afterProjects } = parseProjectReferences(afterFiles);
  const { cleanText: afterFileMentions, files: fileMentions } =
    parseFileMentionReferences(afterProjects);
  const { cleanText: afterAgentMentions, agents } = parseAgentMentionReferences(afterFileMentions);
  const { cleanText, sessions } = parseSessionReferences(afterAgentMentions);

  const body = truncate(
    stripHtmlTags(stripKortixSystemTags(cleanText)).replace(/\s+/g, ' ').trim(),
    MAX_BODY_TEXT,
  );

  const attachments = collectAttachments(fileParts, uploads, fileMentions);
  if (!body && attachments.length === 0) return null;

  const mentions: Mention[] = [
    ...agents.map((a) => ({ name: a.name, kind: 'agent' as const })),
    ...sessions.map((s) => ({ name: s.title, kind: 'agent' as const })),
    ...fileMentions.map((f) => ({ name: f.name, kind: 'file' as const })),
  ];

  return {
    id: turn.userMessage.info.id,
    text: truncate(body, MAX_ITEM_TEXT) || attachments[0].name,
    segments: buildSegments(body, mentions),
    attachments,
  };
}

/** The one-line label for a turn. Empty when the turn has nothing to preview. */
export function extractUserText(turn: Turn): string {
  return extractMinimapItem(turn)?.text ?? '';
}

// ============================================================================
// Down-sampling
// ============================================================================

// Down-sampled set of dashes for the collapsed rail (evenly spaced, always
// including the first and last message).
export function downsampleDashes(items: MinimapItem[], max = MAX_DASHES): MinimapDash[] {
  if (items.length <= max) {
    return items.map((item, index) => ({ item, index }));
  }
  return Array.from({ length: max }, (_, d) => {
    const index = Math.round((d * (items.length - 1)) / (max - 1));
    return { item: items[index], index };
  });
}

/**
 * Which ROW of the rail to light up — the dash nearest the active turn.
 *
 * Returns a position in `dashes`, not a message index, because the row is what
 * both the width taper and the preview card's offset are measured in.
 */
export function nearestDashRow(dashes: MinimapDash[], activeIndex: number): number {
  if (activeIndex < 0) return -1;
  let best = -1;
  let bestDist = Infinity;
  for (let row = 0; row < dashes.length; row++) {
    const dist = Math.abs(dashes[row].index - activeIndex);
    if (dist < bestDist) {
      bestDist = dist;
      best = row;
    }
  }
  return best;
}
