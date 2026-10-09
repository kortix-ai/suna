import type { GenuiSegment } from './types';

/** v1 fence tags. `openui-lang` is the tag OpenUI's own docs teach, so models also write it. */
const V1_TAGS = new Set(['openui', 'openui-lang']);
const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;

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
  return match ? genuiVersionOf(match[1]) : null;
}

/**
 * Split a reply into markdown and generative-UI segments, in order.
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
      const open = OPEN_FENCE.exec(line);
      if (!open) {
        markdown.push(line);
        continue;
      }
      const version = genuiVersionOf(open[2] ?? '');
      fence = { marker: open[1]!, version, body: [] };
      if (version === null) markdown.push(line);
      else flushMarkdown();
      continue;
    }
    const trimmed = line.trim();
    const closes =
      trimmed.length >= fence.marker.length &&
      trimmed[0] === fence.marker[0] &&
      /^(`+|~+)$/.test(trimmed);
    if (!closes) {
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
