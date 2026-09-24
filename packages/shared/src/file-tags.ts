import { tagBlocks } from './tag-blocks';

/**
 * The runtime writes an attached file into user text as
 * `<file path="…" mime="…" filename="…">…</file>`. This finds those blocks.
 *
 * WHY NOT A REGEX. Every reader of this format used
 * `/<file\s+([^>]*?)>\s*[\s\S]*?<\/file>/g`, and it is quadratic: `\s+` and
 * `[^>]*?` both match whitespace, so `<file` followed by N whitespace
 * characters and no `>` is re-split N ways. Measured: 10k characters 32 ms, 20k
 * 125 ms — each doubling quadruples it — so a 200k-character prompt costs
 * ~12 s. That text is user-controlled, and one reader runs synchronously on the
 * API's event loop at every turn-end capture, where it stalls every request on
 * the process. The scanner behind this, and the reason no tighter regex fixes
 * the class, is in `tag-blocks.ts`.
 *
 * It returns exactly what that regex matched: `<file`, then whitespace, then
 * attributes up to the first `>`, then everything up to the first `</file>`,
 * non-overlapping, in order. `attrs` is the attribute text without its leading
 * whitespace, as the regex's first group was.
 */
export interface FileTagBlock {
  /** Index of `<file`. */
  index: number;
  /** Index just past `</file>`. */
  end: number;
  /** The attribute text between `<file ` and `>`, leading whitespace removed. */
  attrs: string;
}

export function fileTagBlocks(text: string): FileTagBlock[] {
  return tagBlocks(text, 'file', { attributes: 'spaced' }).map(({ index, end, attrs }) => ({ index, end, attrs }));
}
