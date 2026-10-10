import type { GenuiSegment } from './types';

/** v1 fence tags. `openui-lang` is the tag OpenUI's own docs teach, so models also write it. */
const V1_TAGS = new Set(['openui', 'openui-lang']);
// No part of these can match the same characters twice, so each runs in time linear in the line.
const FENCE_START = /^([ \t>]*)(`{3,}|~{3,})/;
const INFO_TAG = /^[ \t]*([^\s`]*)/;
const CLOSE_FENCE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const TOP_LEVEL = /^ {0,3}$/;

/** Schema version for a fence language tag, or null when the fence is not generative UI. */
export function genuiVersionOf(tag: string): number | null {
  const lang = tag.trim().toLowerCase();
  if (V1_TAGS.has(lang)) return 1;
  const match = /^openui-v(\d{1,3})$/.exec(lang);
  return match ? Number(match[1]) : null;
}

/** Same as `genuiVersionOf`, for a markdown renderer's `language-…` class name. */
export function genuiVersionFromClassName(className: string | undefined): number | null {
  const match = /(?:^|\s)language-([\w-]+)/.exec(className ?? '');
  return match?.[1] ? genuiVersionOf(match[1]) : null;
}

/**
 * A fence opener, or null: the container prefix before the marker (spaces, tabs, `>`), the marker,
 * and the generative-UI version of the tag (null for any other language). A backtick in the info
 * string means no fence.
 */
export function fenceOpener(line: string): { prefix: string; marker: string; version: number | null } | null {
  const match = FENCE_START.exec(line);
  if (!match) return null;
  const info = line.slice(match[0].length);
  if (info.includes('`')) return null;
  return { prefix: match[1]!, marker: match[2]!, version: genuiVersionOf(INFO_TAG.exec(info)![1]!) };
}

/** True when `prefix` puts a fence at top level: at most 3 spaces, no blockquote, no list indentation. */
export function isTopLevel(prefix: string): boolean {
  return TOP_LEVEL.test(prefix);
}

/** True when `line` closes a fence opened with `marker`. */
export function closesFence(line: string, marker: string): boolean {
  const close = CLOSE_FENCE.exec(line);
  return close !== null && close[1]![0] === marker[0] && close[1]!.length >= marker.length;
}

/** A fence that opens on a list-marker line: `- ```openui`, `1. ```openui`. Linear: the parts cannot overlap. */
const LIST_FENCE = /^([ \t>]*)([-*+]|\d{1,9}[.)])([ \t]+)(?=`{3}|~{3})/;
const LEAD = /^[ \t>]*/;
const quoteDepth = (prefix: string) => prefix.split('>').length - 1;

/** A fence opened at any container depth. Internal: shared by `separateGenuiClosers` and markdown.ts. */
export interface ContainerFence {
  /** The container prefix of each body line. A list-marker opener's marker becomes spaces. */
  prefix: string;
  /** Prefix of the opener line: the list marker itself when the fence opened on a list-marker line. */
  first: string;
  marker: string;
  /** Inside a blockquote or a list item: the fence ends with its container. */
  nested: boolean;
  version: number | null;
}

/** The fence `line` opens, in any container, or null. */
export function containerFenceOpener(line: string): ContainerFence | null {
  const item = LIST_FENCE.exec(line);
  const open = fenceOpener(item ? line.slice(item[0].length) : line);
  if (!open) return null;
  const prefix = item ? item[1]! + ' '.repeat(item[2]!.length + item[3]!.length) : open.prefix;
  return { marker: open.marker, version: open.version, prefix, first: item ? item[0] : prefix, nested: item !== null || !isTopLevel(open.prefix) };
}

/**
 * `line` without its container prefix while it is inside `fence`, or null when the container ended
 * (a line without the prefix that is not blank). Blockquote markers may be spaced differently on each
 * line (`> x`, `>x`). The result is always a suffix of `line`.
 */
export function fenceBodyLine(line: string, fence: ContainerFence): string | null {
  if (!fence.nested) return line;
  if (line.startsWith(fence.prefix)) return line.slice(fence.prefix.length);
  const lead = LEAD.exec(line)![0];
  if (fence.prefix.includes('>') && quoteDepth(lead) === quoteDepth(fence.prefix)) return line.slice(lead.length);
  return line.trim() === '' || line.trimEnd() === fence.prefix.trimEnd() ? '' : null;
}

/** Where a closer run glued after `)`, `]`, or `"` starts in `body`, or -1. Linear: two backward scans. */
function gluedCloserAt(body: string, marker: string): number {
  let end = body.length;
  while (end > 0 && (body[end - 1] === ' ' || body[end - 1] === '\t')) end--;
  let start = end;
  while (start > 0 && body[start - 1] === marker[0]) start--;
  const before = body[start - 1];
  return end - start >= marker.length && (before === ')' || before === ']' || before === '"') ? start : -1;
}

/**
 * Move a generative-UI fence closer that a model glued to the last statement (`…")````) onto its own
 * line, with the fence's container prefix. CommonMark does not close a fence there, so the block would
 * run to the end of the reply. Only lines inside an open generative-UI fence change. Run it on a reply
 * before any markdown parser or `splitGenui` reads it. Returns the same string when nothing changes.
 */
export function separateGenuiClosers(text: string): string {
  if (!/openui/i.test(text)) return text;
  const lines = text.split('\n');
  let fence: ContainerFence | null = null;
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!fence) {
      fence = containerFenceOpener(line);
      continue;
    }
    const body = fenceBodyLine(line, fence);
    if (body === null) {
      fence = null;
      i--; // this line belongs to whatever follows the container
      continue;
    }
    if (closesFence(body, fence.marker)) {
      fence = null;
      continue;
    }
    const at = fence.version === null ? -1 : gluedCloserAt(body, fence.marker);
    if (at < 0) continue;
    const cut = line.length - body.length + at;
    lines[i] = `${line.slice(0, cut)}\n${fence.prefix}${line.slice(cut).trimEnd()}`;
    changed = true;
    fence = null;
  }
  return changed ? lines.join('\n') : text;
}

/**
 * Split a reply into markdown and generative-UI segments, in order. Only top-level fences count:
 * a fence inside a blockquote or a list item stays markdown here (`genuiToMarkdown` converts it).
 * A generative-UI tag inside another fence stays markdown (an agent showing an example).
 * An unclosed generative-UI fence at the end is a block still streaming (`closed: false`).
 */
export function splitGenui(text: string): GenuiSegment[] {
  const segments: GenuiSegment[] = [];
  const lines = text.split('\n');
  let markdown: string[] = [];
  let fence: { marker: string; version: number | null; body: string[] } | null = null;

  const flushMarkdown = () => {
    if (markdown.length > 0) segments.push({ kind: 'markdown', text: markdown.join('\n') });
    markdown = [];
  };

  for (const line of lines) {
    if (!fence) {
      const open = fenceOpener(line);
      if (!open || !isTopLevel(open.prefix)) {
        markdown.push(line);
        continue;
      }
      fence = { marker: open.marker, version: open.version, body: [] };
      if (open.version === null) markdown.push(line);
      else flushMarkdown();
      continue;
    }
    if (!closesFence(line, fence.marker)) {
      if (fence.version === null) markdown.push(line);
      else fence.body.push(line);
      continue;
    }
    if (fence.version === null) markdown.push(line);
    else segments.push({ kind: 'genui', code: fence.body.join('\n'), version: fence.version, closed: true });
    fence = null;
  }

  if (fence && fence.version !== null) {
    segments.push({ kind: 'genui', code: fence.body.join('\n'), version: fence.version, closed: false });
  }
  flushMarkdown();
  return segments;
}
