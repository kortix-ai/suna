/**
 * The ONLY module in the chat TUI that writes to the terminal.
 *
 * DECISION: inline scrollback, never the alternate screen. There is no
 * `\x1b[?1049h` in this file and `chat-render.test.ts` asserts it stays that
 * way. The reason is that a Kortix session is REMOTE and outlives the
 * terminal: closing the window does not end the agent. Alt-screen encodes the
 * opposite model — "this window IS the session" — and wipes every trace of the
 * conversation on exit. Inline scrollback says what is true: this is a view
 * onto something that lives elsewhere, and the transcript stays in your
 * terminal (and pipes, and screenshots) after you detach.
 *
 * Two regions:
 *   - COMMITTED scrollback: append-only, immutable forever after. Matches the
 *     transport, which only ever grows text (monotonic prefix growth).
 *   - The TAIL: a small mutable region at the bottom (in-flight tool lines,
 *     the status line, the composer). Erased and redrawn in place with
 *     `CSI n A` + `CSI 0J`, exactly the idiom `tui-select.ts` uses.
 *
 * The tail is erased using the row count RECORDED WHEN IT WAS DRAWN, never
 * recomputed at the current width. That is the latent bug in
 * `tui-select.ts`'s cleanup — harmless there because the picker never survives
 * a resize, fatal in a long-lived surface.
 */

import { countPhysicalRows } from '../tui-select.ts';
import { visibleWidth } from '../style.ts';

const CSI = '\x1b[';

export interface RenderTarget {
  write: (text: string) => void;
  /** Read fresh on every draw so a resize is picked up. */
  columns: () => number | undefined;
}

export interface Renderer {
  /** Raw text into scrollback — token by token, no line management. */
  append: (text: string) => void;
  /** Whole lines into scrollback. Immutable once written. */
  commit: (lines: string[]) => void;
  /** End a partially written line so the tail can be drawn again.
   *
   *  `drawTail` refuses to draw while the cursor sits mid-line — that is what
   *  keeps streaming text on one line instead of one token per line. But an
   *  assistant reply usually does NOT end in a newline, so when the turn
   *  settles the cursor is mid-line and the composer is never drawn: typing
   *  produces no visible feedback until something else forces a newline, which
   *  reads as a hang. Call this when a turn ends. No-op when already at a line
   *  start, so it cannot introduce a blank line. */
  closeLine: () => void;
  /** Replace the live tail. `cursorCol` parks the cursor on the last line. */
  setTail: (lines: string[], cursorCol?: number) => void;
  /** Erase the tail and keep it erased (before handing the terminal to another
   *  renderer, e.g. `selectFromList`, or on exit). */
  clearTail: () => void;
  /** Redraw the tail at the new width. Committed scrollback is never touched —
   *  the terminal owns its own reflow. */
  handleResize: () => void;
  bell: () => void;
}

export function createRenderer(target: RenderTarget): Renderer {
  let pendingTail: string[] = [];
  let pendingCursorCol: number | null = null;
  /** Is a tail currently on screen? */
  let drawn = false;
  /** Physical rows between the tail's first row and the cursor, measured at
   *  draw time. This is what the erase moves back over (F7). */
  let rowsAboveCursor = 0;
  /** False when the last write left the cursor mid-line. */
  let atLineStart = true;

  const eraseTail = (): void => {
    if (!drawn) return;
    // `\r` first: `CSI 0J` clears from the cursor onward, so a cursor parked
    // mid-line would leave the left half of that line behind.
    const up = rowsAboveCursor > 0 ? `${CSI}${rowsAboveCursor}A` : '';
    target.write(`\r${up}${CSI}0J`);
    drawn = false;
    rowsAboveCursor = 0;
  };

  const drawTail = (): void => {
    // Never draw over a partially written line — that is what makes streaming
    // text stay on one line instead of one token per line.
    if (drawn || !atLineStart || pendingTail.length === 0) return;
    const cols = target.columns();
    const frame = `${pendingTail.join('\n')}\n`;
    target.write(frame);
    const rows = countPhysicalRows(frame, cols);
    let up = 0;
    if (pendingCursorCol !== null) {
      const lastLine = pendingTail[pendingTail.length - 1] ?? '';
      const lineRows = Math.max(1, Math.ceil(Math.max(visibleWidth(lastLine), 1) / (cols || 80)));
      const cursorRow = cols ? Math.floor(pendingCursorCol / cols) : 0;
      up = Math.max(0, lineRows - cursorRow);
      const col = (cols ? pendingCursorCol % cols : pendingCursorCol) + 1;
      target.write(`${up > 0 ? `${CSI}${up}A` : ''}${CSI}${col}G`);
    }
    rowsAboveCursor = rows - up;
    drawn = true;
  };

  return {
    append: (text) => {
      if (!text) return;
      eraseTail();
      target.write(text);
      atLineStart = text.endsWith('\n');
      drawTail();
    },

    commit: (lines) => {
      if (lines.length === 0) return;
      eraseTail();
      if (!atLineStart) target.write('\n');
      target.write(`${lines.join('\n')}\n`);
      atLineStart = true;
      drawTail();
    },

    closeLine: () => {
      if (atLineStart) return;
      eraseTail();
      target.write('\n');
      atLineStart = true;
      drawTail();
    },

    setTail: (lines, cursorCol) => {
      const nextCursor = cursorCol === undefined ? null : cursorCol;
      const unchanged =
        drawn &&
        nextCursor === pendingCursorCol &&
        lines.length === pendingTail.length &&
        lines.every((line, i) => line === pendingTail[i]);
      if (unchanged) return;
      eraseTail();
      pendingTail = lines;
      pendingCursorCol = nextCursor;
      drawTail();
    },

    clearTail: () => {
      eraseTail();
      pendingTail = [];
      pendingCursorCol = null;
    },

    handleResize: () => {
      if (!drawn) return;
      // Erase with the OLD measurement, then re-measure while drawing.
      eraseTail();
      drawTail();
    },

    bell: () => target.write('\x07'),
  };
}
