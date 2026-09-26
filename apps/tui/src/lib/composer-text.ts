/**
 * Pure composer text rules. No React, no SDK, no renderable — every rule the
 * composer applies to the draft lives here so it is unit-testable on its own.
 *
 * The composer's `<textarea>` owns the buffer; this module only answers
 * questions ABOUT a buffer: how tall the box must be, whether a `/` typed at
 * this cursor opens the command picker, and which `@path` mentions the draft
 * carries.
 */

/** The composer never shrinks below one row. */
export const COMPOSER_MIN_ROWS = 1;
/** …and never grows past six (SPEC §5.3). The rest scrolls inside the box. */
export const COMPOSER_MAX_ROWS = 6;

/**
 * Rows one logical line occupies at `width` columns under word wrapping.
 *
 * The textarea renders with `wrapMode="word"`, so this mirrors that rule: fill
 * a row word by word, break before the word that would overflow, and hard-split
 * any single word longer than the row.
 */
export function wrappedRowCount(line: string, width: number): number {
  if (width <= 0) return 1;
  if (line.length <= width) return 1;
  let rows = 1;
  let column = 0;
  for (const word of line.split(' ')) {
    const needed = column === 0 ? word.length : word.length + 1;
    if (column + needed <= width) {
      column += needed;
      continue;
    }
    // The word starts a new row — unless this row is still empty, in which
    // case it already IS the word's row and only the overflow costs more rows.
    if (column > 0) rows += 1;
    let remaining = word.length;
    while (remaining > width) {
      rows += 1;
      remaining -= width;
    }
    column = remaining;
  }
  return rows;
}

/** Total visual rows `text` occupies at `width` columns. */
export function visualRowCount(text: string, width: number): number {
  const lines = text.split('\n');
  let rows = 0;
  for (const line of lines) rows += wrappedRowCount(line, width);
  return Math.max(rows, 1);
}

/** The textarea height for this draft: grows 1 → 6 rows, then stops. */
export function composerRows(text: string, width: number): number {
  const rows = visualRowCount(text, width);
  if (rows < COMPOSER_MIN_ROWS) return COMPOSER_MIN_ROWS;
  if (rows > COMPOSER_MAX_ROWS) return COMPOSER_MAX_ROWS;
  return rows;
}

/**
 * Does a `/` typed at `cursorOffset` open the command picker?
 *
 * Only at column 0 — the start of the buffer or the start of a line. A slash
 * anywhere else is ordinary text (a path, a date, a fraction), and stealing it
 * would make `cd /workspace` untypeable.
 *
 * `text` is the buffer BEFORE the keypress, which is what the textarea's
 * `onKeyDown` sees: the built-in insert has not run yet.
 */
export function isSlashTrigger(text: string, cursorOffset: number): boolean {
  const offset = Math.max(0, Math.min(cursorOffset, text.length));
  if (offset === 0) return true;
  return text[offset - 1] === '\n';
}

/** A `/name args…` line, split. Null when the text is not a slash command. */
export function splitCommandInput(text: string): { name: string; args: string } | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('/')) return null;
  const body = trimmed.slice(1);
  const space = body.search(/\s/);
  if (space === -1) return { name: body, args: '' };
  return { name: body.slice(0, space), args: body.slice(space + 1).trim() };
}

/** One `@path` mention found in a draft. */
export interface Mention {
  /** The path as typed, without the `@`. */
  path: string;
  /** Offset of the `@` in the source text. */
  start: number;
  /** Offset one past the last character of the path. */
  end: number;
}

/**
 * Every `@path` mention in `text`.
 *
 * WAVE 1 SCOPE: parsing only. The composer renders the count so a mention is
 * visible, but it does not yet attach files — `usePromptAttachments` takes a
 * browser `File`, which Bun's process has no producer for. Attachment sending
 * is out of scope and flagged in the README (SPEC §5.3).
 *
 * A mention starts at the beginning of the text or after whitespace, so an
 * email address (`a@b.com`) is never read as one.
 */
export function parseMentions(text: string): Mention[] {
  const mentions: Mention[] = [];
  const pattern = /(^|\s)@(\S+)/g;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match !== null) {
    const lead = match[1] ?? '';
    const path = match[2] ?? '';
    const start = match.index + lead.length;
    mentions.push({ path, start, end: start + 1 + path.length });
    match = pattern.exec(text);
  }
  return mentions;
}

/** Insert `\n` at `cursorOffset`. Returns the new text and cursor offset. */
export function insertNewline(
  text: string,
  cursorOffset: number,
): { text: string; cursorOffset: number } {
  const offset = Math.max(0, Math.min(cursorOffset, text.length));
  return { text: `${text.slice(0, offset)}\n${text.slice(offset)}`, cursorOffset: offset + 1 };
}
