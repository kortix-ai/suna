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
