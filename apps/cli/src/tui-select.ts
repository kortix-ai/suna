import { C, stripAnsi, visibleWidth } from './style.ts';

/**
 * Minimal arrow-key TUI selector. Reads stdin in raw mode, renders the
 * list each frame with a ▸ on the current row, returns the selected
 * option's `value` (or `null` on Ctrl-C / Esc).
 *
 * Supports type-to-filter: any printable key types into a search buffer,
 * narrowing the list to entries whose label or sublabel contain the
 * substring (case-insensitive). Backspace clears one char.
 *
 * Falls back to a numbered-prompt mode when stdin isn't a TTY (CI, pipe,
 * `script` wrapper). That keeps tests + non-interactive callers working.
 */
export interface SelectItem<T> {
  /** What gets returned when the user picks this row. */
  value: T;
  /** Primary line (shown bold when selected). */
  label: string;
  /** Optional dim secondary line (uuid, hint, etc.). */
  sublabel?: string;
}

export interface SelectOpts<T> {
  /** Heading shown above the list. */
  title?: string;
  /** Items to choose from. Empty → returns null without prompting. */
  items: SelectItem<T>[];
  /** Index to highlight on first render (default 0). */
  initialIndex?: number;
  /** Override the prompt shown above the list when filtering. */
  searchHint?: string;
}

const ESC = '\x1b';
const CSI = `${ESC}[`;

export async function selectFromList<T>(opts: SelectOpts<T>): Promise<T | null> {
  if (opts.items.length === 0) return null;

  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (!interactive) {
    return numberedFallback(opts);
  }

  return runInteractivePicker<T, T>({
    items: opts.items,
    title: opts.title,
    hint:
      opts.searchHint ??
      `${C.dim}↑/↓ select · Enter confirm · Esc cancel · type to filter${C.reset}`,
    initialCursor: clamp(opts.initialIndex ?? 0, 0, opts.items.length - 1),
    // A single picker marks the row the cursor sits on — by item identity, so
    // a duplicated entry highlights on both of its rows.
    renderRow: (item, _index, cursorIndex, atCursorItem, pad) => {
      const isSelected = item === atCursorItem;
      const marker = isSelected ? `${C.cyan}▸${C.reset}` : ' ';
      const labelText = isSelected ? `${C.bold}${item.label}${C.reset}` : item.label;
      const sub = item.sublabel ? `   ${C.faded}${item.sublabel}${C.reset}` : '';
      return `  ${marker} ${labelText}${pad}${sub}`;
    },
    renderFooter: () => [''],
    onEnter: (ctx) => {
      if (ctx.filtered.length === 0) return; // can't pick with no matches
      const idx = clamp(ctx.cursor, 0, ctx.filtered.length - 1);
      ctx.finish(ctx.filtered[idx]!.value);
    },
    cancelChunk: '\x03',
    backspaceChunks: ['\x7f', '\b'],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-select variant — same shape, but space toggles a checkbox on each row.
// The first toggled row is the "primary" by convention (callers can read
// `result[0]` if they need a singular pick alongside the set).
// ─────────────────────────────────────────────────────────────────────────────

export interface MultiSelectOpts<T> extends Omit<SelectOpts<T>, 'initialIndex'> {
  /** Indices to start with toggled on. */
  initiallySelected?: number[];
  /** Require at least one to be toggled before allowing Enter. */
  minSelected?: number;
}

export async function selectMultiFromList<T>(opts: MultiSelectOpts<T>): Promise<T[] | null> {
  if (opts.items.length === 0) return null;

  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (!interactive) {
    return numberedMultiFallback(opts);
  }

  // Selection state: the set of toggled full-list indices, plus the toggle
  // ORDER — the returned list follows it, so the first thing the user picked
  // stays the primary (`result[0]`).
  const selected = new Set<number>(opts.initiallySelected ?? []);
  const toggleOrder: number[] = [...(opts.initiallySelected ?? [])];

  return runInteractivePicker<T, T[]>({
    items: opts.items,
    title: opts.title,
    hint:
      opts.searchHint ??
      `${C.dim}↑/↓ navigate · Space toggle · Enter confirm · Esc cancel · type to filter${C.reset}`,
    initialCursor: 0,
    renderRow: (item, index, cursorIndex, _atCursorItem, pad) => {
      const isCursor = index === cursorIndex;
      const isOn = selected.has(opts.items.indexOf(item));
      const cursorMark = isCursor ? `${C.cyan}▸${C.reset}` : ' ';
      const checkbox = isOn ? `${C.green}●${C.reset}` : `${C.dim}○${C.reset}`;
      const labelText = isCursor ? `${C.bold}${item.label}${C.reset}` : item.label;
      const sub = item.sublabel ? `   ${C.faded}${item.sublabel}${C.reset}` : '';
      return `  ${cursorMark} ${checkbox} ${labelText}${pad}${sub}`;
    },
    renderFooter: () => {
      const min = opts.minSelected ?? 0;
      const count = selected.size;
      const summary =
        count < min
          ? `${C.yellow}select at least ${min} (currently ${count})${C.reset}`
          : `${C.dim}${count} selected${C.reset}`;
      return ['', `  ${summary}`, ''];
    },
    // Space toggles BEFORE the shared keys — in single mode space falls
    // through to the filter buffer instead.
    onModeKey: (str, ctx) => {
      if (str !== ' ') return false;
      if (ctx.filtered.length > 0) {
        const item = ctx.filtered[clamp(ctx.cursor, 0, ctx.filtered.length - 1)]!;
        toggle(opts.items.indexOf(item));
        ctx.render();
      }
      return true;
    },
    onEnter: (ctx) => {
      const min = opts.minSelected ?? 0;
      if (selected.size < min) return;
      ctx.finish(
        toggleOrder.filter((idx) => selected.has(idx)).map((idx) => opts.items[idx]!.value),
      );
    },
    cancelChunk: '',
    backspaceChunks: ['\b'],
  });

  function toggle(itemIdx: number) {
    if (selected.has(itemIdx)) {
      selected.delete(itemIdx);
      const at = toggleOrder.indexOf(itemIdx);
      if (at >= 0) toggleOrder.splice(at, 1);
    } else {
      selected.add(itemIdx);
      toggleOrder.push(itemIdx);
    }
  }
}

// ── the one shared interactive loop ─────────────────────────────────────────

interface PickerContext<T, R> {
  /** The items matching the current filter. */
  filtered: SelectItem<T>[];
  /** Cursor row within `filtered`. */
  cursor: number;
  /** Replace the whole frame (after a mode-specific state change). */
  render(): void;
  /** Restore the terminal and settle the picker's promise. */
  finish(result: R | null): void;
}

interface PickerSpec<T, R> {
  items: SelectItem<T>[];
  title?: string;
  /** The hint line under the title (differs between the two pickers). */
  hint: string;
  initialCursor: number;
  /**
   * Draw one row of the filtered list. `cursorIndex` is the cursor row,
   * `atCursorItem` the item object under it (identity comparison for the
   * single picker), `pad` the pre-computed label padding.
   */
  renderRow(
    item: SelectItem<T>,
    index: number,
    cursorIndex: number,
    atCursorItem: SelectItem<T>,
    pad: string,
  ): string;
  /** Lines printed after the list, including the trailing blank. */
  renderFooter(): string[];
  /** Mode-owned keys handled before the shared ones (multi's Space). */
  onModeKey?(str: string, ctx: PickerContext<T, R>): boolean;
  /** Enter. */
  onEnter(ctx: PickerContext<T, R>): void;
  /**
   * The chunk that cancels the picker. The two pickers disagree and the
   * characterization pins that: the single picker cancels on the Ctrl-C
   * byte (`\x03`) and IGNORES an empty chunk, the multi picker cancels on
   * an empty chunk and ignores Ctrl-C.
   */
  cancelChunk: string;
  /** Chunks that delete one filter character. Single accepts DEL + BS,
   *  multi only BS (its pre-1341 branch list). */
  backspaceChunks: readonly string[];
}

/**
 * Raw-mode terminal lifecycle shared by both pickers: setup, frame wipe +
 * replacement, cursor/filter navigation, cancellation. The two pickers differ
 * only in their row/footer rendering and their Enter (and Space) behavior.
 */
function runInteractivePicker<T, R>(spec: PickerSpec<T, R>): Promise<R | null> {
  const stdin = process.stdin;
  const stdout = process.stdout;

  return new Promise<R | null>((resolve) => {
    let cursor = spec.initialCursor;
    let search = '';
    let filtered = filterItems(spec.items, search);
    // The cursor might point at a now-hidden item (single picker's
    // initialIndex can land outside the list; with no filter it never does).
    if (!filtered.includes(spec.items[cursor]!)) {
      cursor = 0;
    }

    let lastFrameLines = 0;

    function render(initial = false) {
      // Clear the previous frame in place (no scrolling).
      if (!initial && lastFrameLines > 0) {
        stdout.write(`${CSI}${lastFrameLines}A${CSI}0J`);
      }
      const lines: string[] = [];
      if (spec.title) {
        lines.push(`  ${C.bold}${spec.title}${C.reset}`);
      }
      lines.push(`  ${spec.hint}`);
      if (search) {
        lines.push(`  ${C.dim}filter:${C.reset} ${C.cyan}${search}${C.reset}`);
      }
      lines.push('');

      if (filtered.length === 0) {
        lines.push(`  ${C.dim}(no matches)${C.reset}`);
      } else {
        const labelWidth = Math.max(...filtered.map((it) => visibleWidth(it.label)));
        const cursorIndex = clamp(cursor, 0, filtered.length - 1);
        const atCursorItem = filtered[cursorIndex]!;
        for (let i = 0; i < filtered.length; i += 1) {
          const item = filtered[i]!;
          const pad = ' '.repeat(Math.max(0, labelWidth - visibleWidth(item.label)));
          lines.push(spec.renderRow(item, i, cursorIndex, atCursorItem, pad));
        }
      }
      for (const line of spec.renderFooter()) lines.push(line);
      const frame = lines.join('\n') + '\n';
      stdout.write(frame);
      lastFrameLines = countPhysicalRows(frame, stdout.columns);
    }

    function cleanup() {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      // Wipe the frame so the calling command can print fresh output.
      if (lastFrameLines > 0) {
        stdout.write(`${CSI}${lastFrameLines}A${CSI}0J`);
      }
    }

    const ctx: PickerContext<T, R> = {
      get filtered() {
        return filtered;
      },
      get cursor() {
        return cursor;
      },
      render,
      finish(result) {
        cleanup();
        resolve(result);
      },
    };

    function refilter() {
      filtered = filterItems(spec.items, search);
      cursor = 0;
      render();
    }

    function onData(buf: Buffer) {
      const str = buf.toString('utf8');
      // Ctrl-C → abort (the chunk differs per picker — see cancelChunk)
      if (str === spec.cancelChunk) {
        ctx.finish(null);
        return;
      }
      // Esc → abort (single ESC; ESC + sequence is handled below by arrow)
      if (str === ESC) {
        ctx.finish(null);
        return;
      }
      // Enter → pick / confirm
      if (str === '\r' || str === '\n') {
        spec.onEnter(ctx);
        return;
      }
      // Mode-owned keys (multi's Space toggle) come next.
      if (spec.onModeKey?.(str, ctx)) return;
      // Backspace (the accepted chunks differ per picker)
      if (spec.backspaceChunks.includes(str)) {
        if (search.length > 0) {
          search = search.slice(0, -1);
          refilter();
        }
        return;
      }
      // Arrow keys
      if (str.startsWith(CSI)) {
        const code = str.slice(2);
        if (code === 'A') {
          // up
          cursor = Math.max(0, cursor - 1);
          render();
          return;
        }
        if (code === 'B') {
          // down
          cursor = Math.min(filtered.length - 1, cursor + 1);
          render();
          return;
        }
        // Ignore other CSI sequences (left/right/home/end/etc.)
        return;
      }
      // Printable → append to filter buffer (single chars only — multibyte
      // input + paste are out of scope).
      if (str.length === 1 && str >= ' ' && str <= '~') {
        search += str;
        refilter();
      }
    }

    stdin.resume();
    stdin.setRawMode?.(true);
    stdin.on('data', onData);
    render(true);
  });
}

// ── helpers ──────────────────────────────────────────────────────────────

function filterItems<T>(items: SelectItem<T>[], q: string): SelectItem<T>[] {
  if (!q) return items;
  const needle = q.toLowerCase();
  return items.filter((it) => {
    const hay = (stripAnsi(it.label) + ' ' + stripAnsi(it.sublabel ?? '')).toLowerCase();
    return hay.includes(needle);
  });
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/**
 * How many physical terminal rows the frame occupies, accounting for
 * line-wrapping when a logical line is wider than `cols`. Without this
 * the cursor-up CSI in render() undercounts and leaves the wrapped
 * portion of previous frames on screen.
 */
function countPhysicalRows(s: string, cols: number | undefined): number {
  const parts = s.split('\n');
  // Trailing '\n' yields an empty final part — drop it.
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  if (!cols || cols <= 0) return parts.length;
  let rows = 0;
  for (const line of parts) {
    const w = visibleWidth(line);
    rows += Math.max(1, Math.ceil(w / cols));
  }
  return rows;
}

// ── numbered fallbacks (non-TTY) ─────────────────────────────────────────────

/** The numbered menu both fallbacks print: one row per item, 1-indexed. */
function printNumberedMenu<T>(opts: { title?: string; items: SelectItem<T>[] }): void {
  process.stdout.write('\n');
  if (opts.title) process.stdout.write(`  ${opts.title}\n`);
  opts.items.forEach((it, i) => {
    const sub = it.sublabel ? `  ${it.sublabel}` : '';
    process.stdout.write(`  ${(i + 1).toString().padStart(2)}) ${it.label}${sub}\n`);
  });
  process.stdout.write('\n');
}

/** One line from stdin — the shared readline plumbing of both fallbacks. */
async function askLine(prompt: string): Promise<string> {
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** Non-TTY fallback: print a numbered list and read a line with the
 *  number (or value). Used by tests / piped invocations. */
async function numberedFallback<T>(opts: SelectOpts<T>): Promise<T | null> {
  printNumberedMenu(opts);
  const answer = await askLine('  Pick a number: ');
  const n = Number.parseInt(answer.trim(), 10);
  if (!Number.isFinite(n) || n < 1 || n > opts.items.length) {
    return null;
  }
  return opts.items[n - 1]!.value;
}

async function numberedMultiFallback<T>(opts: MultiSelectOpts<T>): Promise<T[] | null> {
  printNumberedMenu(opts);
  const answer = await askLine('  Pick numbers (comma-separated, blank = all): ');
  const trimmed = answer.trim();
  if (!trimmed) {
    return opts.items.map((i) => i.value);
  }
  const out: T[] = [];
  for (const part of trimmed.split(',')) {
    const n = Number.parseInt(part.trim(), 10);
    if (Number.isFinite(n) && n >= 1 && n <= opts.items.length) {
      out.push(opts.items[n - 1]!.value);
    }
  }
  return out.length > 0 ? out : null;
}
