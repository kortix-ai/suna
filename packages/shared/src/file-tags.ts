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
 * the process. A tighter regex does not fix it: any pattern that re-scans to
 * the end of the string for each `<file` it tries is still quadratic when no
 * closing `>` or `</file>` exists.
 *
 * This scanner reads each character a bounded number of times: every search
 * starts past the previous one, and it stops as soon as a delimiter it needs
 * is absent from the rest of the text — because if no `>` or `</file>` exists
 * after one opener, none exists after any later opener either.
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

const OPEN = '<file';
const CLOSE = '</file>';
const WHITESPACE = /\s/;

export function fileTagBlocks(text: string): FileTagBlock[] {
  const blocks: FileTagBlock[] = [];
  if (typeof text !== 'string') return blocks;
  let from = 0;
  for (;;) {
    const index = text.indexOf(OPEN, from);
    if (index === -1) return blocks;
    const after = index + OPEN.length;
    // `<filex` is not a tag: the regex required whitespace right after `file`.
    if (after >= text.length || !WHITESPACE.test(text[after]!)) {
      from = after;
      continue;
    }
    const gt = text.indexOf('>', after);
    if (gt === -1) return blocks;
    const close = text.indexOf(CLOSE, gt + 1);
    if (close === -1) return blocks;
    const end = close + CLOSE.length;
    blocks.push({ index, end, attrs: text.slice(after, gt).trimStart() });
    from = end;
  }
}
