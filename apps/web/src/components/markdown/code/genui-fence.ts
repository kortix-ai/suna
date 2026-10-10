// The one apps/web import of `@kortix/sdk/genui/fence`: fence detection only, it never loads
// `@openuidev/*` or `zod`. Listed in CANONICAL_SDK_ENTRIES (`scripts/sdk-boundary.mjs`).
// eslint-disable-next-line no-restricted-imports -- light fence helpers for the main markdown chunk
import { genuiVersionFromClassName, genuiVersionOf, splitGenui } from '@kortix/sdk/genui/fence';

export { genuiVersionFromClassName };

/** The generative UI fence still open at the end of a reply (`openGenuiFence`). */
export interface OpenGenuiFence {
  /**
   * Its body so far, as the markdown code node holds it (the opener's indentation removed).
   * Null for a fence inside a blockquote or opened on a list-marker line: the SDK splitter counts
   * top-level fences only, so its body is unknown.
   */
  code: string | null;
  /** The line that closes it inside the same container: its prefix and marker. */
  closer: string;
}

// A fence line after its container prefix (spaces, `>`, one list marker), as CommonMark reads it.
const CONTAINER_FENCE = /^([ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?)(`{3,}|~{3,})([^`]*)$/;
const CLOSE = /^[ \t>]*(`{3,}|~{3,})[ \t]*$/;

/**
 * The generative UI fence still open at the end of `text`, or null. Only the last block of a reply
 * can be open. Open means the model is still writing it, or the reply was cut off inside it.
 */
export function openGenuiFence(text: string): OpenGenuiFence | null {
  if (!/openui/i.test(text)) return null;
  const last = splitGenui(text).at(-1);
  if (last?.kind === 'genui' && !last.closed) {
    // The body is everything after the opener line, so the opener is the last line before it.
    const opener = text.slice(0, text.length - last.code.length).replace(/\n$/, '').split('\n').pop() ?? '';
    const indent = /^ */.exec(opener)![0];
    const marker = /`{3,}|~{3,}/.exec(opener)?.[0] ?? '```';
    // CommonMark removes up to the opener's indentation from each content line (a fence in a list item).
    const strip = new RegExp(`^ {0,${indent.length}}`);
    const code = indent ? last.code.split('\n').map((line) => line.replace(strip, '')).join('\n') : last.code;
    return { code, closer: `\n${indent}${marker}` };
  }
  return openNestedFence(text);
}

/** An unclosed generative UI fence the top-level splitter does not count: in a blockquote, or on a list-marker line. */
function openNestedFence(text: string): OpenGenuiFence | null {
  let open: { marker: string; prefix: string; genui: boolean } | null = null;
  for (const line of text.split('\n')) {
    if (open) {
      const close = CLOSE.exec(line);
      if (close && close[1]![0] === open.marker[0] && close[1]!.length >= open.marker.length) open = null;
      continue;
    }
    const fence = CONTAINER_FENCE.exec(line);
    if (fence) open = { prefix: fence[1]!, marker: fence[2]!, genui: genuiVersionOf(fence[3]!.trim().split(/\s/)[0] ?? '') !== null };
  }
  if (!open?.genui) return null;
  // Inside the same container: a quote keeps its `>`, a list marker becomes the content indent.
  const prefix = open.prefix.replace(/[-*+]|\d{1,9}[.)]/g, (marker) => ' '.repeat(marker.length));
  return { code: null, closer: `\n${prefix}${open.marker}` };
}

// The last body line `closeOpenGenuiFence` adds. U+2063 (invisible separator) keeps it from
// colliding with a line the model writes; `readGenuiOpenMark` removes it before anything renders.
const OPEN_MARK = { streaming: '⁣openui:streaming', 'cut-off': '⁣openui:cut-off' } as const;

/** How an open fence ended: the model is still writing it, or the reply ended inside it. */
export type GenuiOpenState = keyof typeof OPEN_MARK;

/**
 * `text` with its open fence closed in its own container, and a last body line that carries the
 * fence's state. Streamdown commits a streaming tick's blocks one render after the text changes, so
 * a block must read its state from its own text: a value beside the text would be a tick ahead.
 */
export function closeOpenGenuiFence(text: string, fence: OpenGenuiFence, state: GenuiOpenState): string {
  const prefix = fence.closer.slice(1).replace(/[`~]+$/, '');
  return `${text}\n${prefix}${OPEN_MARK[state]}${fence.closer}`;
}

/** A fence body without the state line `closeOpenGenuiFence` added, and that state (null: the fence is closed). */
export function readGenuiOpenMark(code: string): { code: string; open: GenuiOpenState | null } {
  for (const state of Object.keys(OPEN_MARK) as GenuiOpenState[]) {
    const mark = OPEN_MARK[state];
    if (code === mark) return { code: '', open: state };
    if (code.endsWith(`\n${mark}`)) return { code: code.slice(0, -mark.length - 1), open: state };
  }
  return { code, open: null };
}
