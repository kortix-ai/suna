import { GENUI_SPECS } from './catalog';
import { closesFence, fenceOpener, isTopLevel, splitGenui } from './fence';
import { createGenuiParser } from './parse';
import { GENUI_SCHEMA_VERSION, type GenuiNode, type GenuiParseResult } from './types';

/** Shown in place of a block this build cannot read (a newer schema version). */
export const GENUI_UNSUPPORTED_NOTE = 'This content needs a newer version of Kortix.';

/** Shown under a block whose stream ended inside a statement. */
export const GENUI_CUT_OFF_NOTE = 'Response was cut off.';

/** Deterministic markdown for one node and its children. Unknown types and unfinished (partial) nodes yield ''. */
export function genuiNodeToMarkdown(node: GenuiNode): string {
  const spec = GENUI_SPECS[node.type];
  return spec && !node.partial ? spec.toMarkdown(node.props, genuiNodeToMarkdown) : '';
}

/** Screen-reader text for a chart or map node, else null. */
export function genuiA11yText(node: GenuiNode): string | null {
  return GENUI_SPECS[node.type]?.a11y?.(node.props) ?? null;
}

/**
 * Markdown for a parse result: the finished nodes, then the cut-off note when a settled block lost
 * its last statement. Never throws: a failure yields ''.
 */
export function genuiResultToMarkdown(result: GenuiParseResult): string {
  try {
    const body = result.root ? genuiNodeToMarkdown(result.root) : '';
    const cutOff = !result.streaming && result.issues.some((issue) => issue.code === 'cut-off');
    return cutOff ? [body, `*${GENUI_CUT_OFF_NOTE}*`].filter(Boolean).join('\n\n') : body;
  } catch {
    return '';
  }
}

/**
 * Markdown for one block. Never returns OpenUI source, never throws.
 * `streaming: true` is for a block still being written: its unfinished statement is left out
 * and no cut-off note is added.
 */
export function genuiBlockToMarkdown(
  code: string,
  version: number = GENUI_SCHEMA_VERSION,
  options: { streaming?: boolean } = {},
): string {
  if (version !== GENUI_SCHEMA_VERSION) return `*${GENUI_UNSUPPORTED_NOTE}*`;
  return genuiResultToMarkdown(createGenuiParser(version).update(code, options.streaming ?? false));
}

/** A fence that opens on a list-marker line: `- ```openui`, `1. ```openui`. Linear: the parts cannot overlap. */
const LIST_FENCE = /^([ \t>]*)([-*+]|\d{1,9}[.)])([ \t]+)(?=`{3}|~{3})/;
const LEAD = /^[ \t>]*/;
const quoteDepth = (prefix: string) => prefix.split('>').length - 1;

/**
 * Convert generative-UI fences inside blockquotes and list items: a `>` in the prefix, or 4+ columns
 * of indentation. `splitGenui` sees top-level fences only, but the renderers' CommonMark parsers
 * render these too, so every channel must convert them. Each output line keeps the container prefix.
 * The content of every other fence, top-level or nested, is left alone (an agent showing an example).
 */
function convertNestedBlocks(text: string, streaming: boolean): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let fence: {
    prefix: string;
    /** Prefix of the first output line when the fence opened on a list-marker line. */
    first: string;
    marker: string;
    nested: boolean;
    version: number | null;
    body: string[] | null;
  } | null = null;
  let changed = false;

  const finish = (unclosed: boolean) => {
    if (fence?.body) {
      changed = true;
      const markdown = genuiBlockToMarkdown(fence.body.join('\n'), fence.version!, { streaming: streaming && unclosed });
      const { prefix, first } = fence;
      if (markdown) {
        markdown.split('\n').forEach((line, index) => out.push(index === 0 ? first + line : line ? prefix + line : prefix.trimEnd()));
      }
    }
    fence = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!fence) {
      // A fence on a list-marker line: the body is indented to the item's content column.
      const item = LIST_FENCE.exec(line);
      const open = fenceOpener(item ? line.slice(item[0].length) : line);
      if (open) {
        const prefix = item ? item[1]! + ' '.repeat(item[2]!.length + item[3]!.length) : open.prefix;
        const nested = item !== null || !isTopLevel(open.prefix);
        fence = { ...open, prefix, first: item ? item[0] : prefix, nested, body: nested && open.version !== null ? [] : null };
        if (fence.body) continue;
      }
      out.push(line);
      continue;
    }
    // A nested fence ends with its container: a line without the prefix that is not blank.
    // Blockquote markers may be spaced differently on each line (`> x`, `>x`).
    const lead = LEAD.exec(line)![0];
    const inside = !fence.nested
      ? line
      : line.startsWith(fence.prefix)
        ? line.slice(fence.prefix.length)
        : fence.prefix.includes('>') && quoteDepth(lead) === quoteDepth(fence.prefix)
          ? line.slice(lead.length)
          : line.trim() === '' || line.trimEnd() === fence.prefix.trimEnd()
            ? ''
            : null;
    if (inside === null) {
      finish(false);
      i--; // this line belongs to whatever follows the container
      continue;
    }
    if (closesFence(inside, fence.marker)) {
      if (!fence.body) out.push(line);
      finish(false);
      continue;
    }
    if (fence.body) fence.body.push(inside);
    else out.push(line);
  }
  finish(true);
  return changed ? out.join('\n') : text;
}

function trimNewlines(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === '\n') start++;
  while (end > start && text[end - 1] === '\n') end--;
  return text.slice(start, end);
}

/**
 * A whole reply as plain markdown: every generative-UI block replaced by its markdown, including
 * blocks inside blockquotes and list items. For copy, export, the CLI, chat channels, and any host
 * that does not render UI. Text without a generative-UI fence is returned unchanged (same string).
 * `streaming: true` is for a reply still being written: its unclosed last block shows no cut-off note.
 */
export function genuiToMarkdown(text: string, options: { streaming?: boolean } = {}): string {
  if (!/openui/i.test(text)) return text;
  const streaming = options.streaming ?? false;
  const flat = convertNestedBlocks(text, streaming);
  const segments = splitGenui(flat);
  if (!segments.some((segment) => segment.kind === 'genui')) return flat;
  return segments
    .map((segment) =>
      segment.kind === 'markdown'
        ? trimNewlines(segment.text)
        : genuiBlockToMarkdown(segment.code, segment.version, { streaming: streaming && !segment.closed }),
    )
    .filter((part) => part.trim().length > 0)
    .join('\n\n');
}
