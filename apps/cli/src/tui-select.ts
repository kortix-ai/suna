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
interface SelectItem<T> {
  /** What gets returned when the user picks this row. */
  value: T;
  /** Primary line (shown bold when selected). */
  label: string;
  /** Optional dim secondary line (uuid, hint, etc.). */
  sublabel?: string;
}

interface SelectOpts<T> {
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

  const stdin = process.stdin;
  const stdout = process.stdout;
  const interactive = stdin.isTTY === true && stdout.isTTY === true;
  if (!interactive) {
    return numberedFallback(opts);
  }

  return new Promise<T | null>((resolve) => {
    let cursor = clamp(opts.initialIndex ?? 0, 0, opts.items.length - 1);
    let search = '';
    let filtered = filterItems(opts.items, search);
    if (!filtered.includes(opts.items[cursor]!)) {
      // Cursor might point at a now-hidden item.
      cursor = 0;
    }

    let lastFrameLines = 0;

    function render(initial = false) {
      // Clear the previous frame in place (no scrolling).
      if (!initial && lastFrameLines > 0) {
        stdout.write(`${CSI}${lastFrameLines}A${CSI}0J`);
      }
      const lines: string[] = [];
      if (opts.title) {
        lines.push(`  ${C.bold}${opts.title}${C.reset}`);
      }
      const hint = opts.searchHint
        ? opts.searchHint
        : `${C.dim}↑/↓ select · Enter confirm · Esc cancel · type to filter${C.reset}`;
      lines.push(`  ${hint}`);
      if (search) {
        lines.push(`  ${C.dim}filter:${C.reset} ${C.cyan}${search}${C.reset}`);
      }
      lines.push('');

      const visible = filtered;
      if (visible.length === 0) {
        lines.push(`  ${C.dim}(no matches)${C.reset}`);
      } else {
        const labelWidth = Math.max(...visible.map((it) => visibleWidth(it.label)));
        const selectedItem = visible[clamp(cursor, 0, visible.length - 1)]!;
        for (const item of visible) {
          const isSelected = item === selectedItem;
          const marker = isSelected ? `${C.cyan}▸${C.reset}` : ' ';
          const labelText = isSelected
            ? `${C.bold}${item.label}${C.reset}`
            : item.label;
          const pad = ' '.repeat(Math.max(0, labelWidth - visibleWidth(item.label)));
          const sub = item.sublabel ? `   ${C.faded}${item.sublabel}${C.reset}` : '';
          lines.push(`  ${marker} ${labelText}${pad}${sub}`);
        }
      }
      lines.push('');
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

    function pick(): void {
      const visible = filtered;
      if (visible.length === 0) return; // can't pick with no matches
      const idx = clamp(cursor, 0, visible.length - 1);
      const chosen = visible[idx]!;
      cleanup();
      resolve(chosen.value);
    }

    function refilter() {
      filtered = filterItems(opts.items, search);
      cursor = 0;
      render();
    }

    function onData(buf: Buffer) {
      const str = buf.toString('utf8');
      // Ctrl-C → abort
      if (str === '') {
        cleanup();
        resolve(null);
        return;
      }
      // Esc → abort (single ESC; ESC + sequence is handled above by arrow)
      if (str === ESC) {
        cleanup();
        resolve(null);
        return;
      }
      // Enter → pick
      if (str === '\r' || str === '\n') {
        pick();
        return;
      }
      // Backspace
      if (str === '' || str === '\b') {
        if (search.length > 0) {
          search = search.slice(0, -1);
          refilter();
        }
        return;
      }
      // Arrow keys
      if (str.startsWith(`${ESC}[`)) {
        const code = str.slice(2);
        if (code === 'A') {
          // up
          cursor = Math.max(0, cursor - 1);
          render();
          return;
        }
        if (code === 'B') {
          // down
          const max = filtered.length - 1;
          cursor = Math.min(max, cursor + 1);
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
    const hay =
      (stripAnsi(it.label) + ' ' + stripAnsi(it.sublabel ?? '')).toLowerCase();
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

// ─────────────────────────────────────────────────────────────────────────────
// Multi-select variant — same shape, but space toggles a checkbox on each row.
// The first toggled row is the "primary" by convention (callers can read
// `result[0]` if they need a singular pick alongside the set).
// ─────────────────────────────────────────────────────────────────────────────

interface MultiSelectOpts<T> extends Omit<SelectOpts<T>, 'initialIndex'> {
  /** Indices to start with toggled on. */
  initiallySelected?: number[];
  /** Require at least one to be toggled before allowing Enter. */
  minSelected?: number;
}

export async function selectMultiFromList<T>(
  opts: MultiSelectOpts<T>,
): Promise<T[] | null> {
  if (opts.items.length === 0) return null;

  const stdin = process.stdin;
  const stdout = process.stdout;
  const interactive = stdin.isTTY === true && stdout.isTTY === true;
  if (!interactive) {
    return numberedMultiFallback(opts);
  }

  return new Promise<T[] | null>((resolve) => {
    let cursor = 0;
    let search = '';
    const selected = new Set<number>(opts.initiallySelected ?? []);
    let filtered = filterItems(opts.items, search);

    let lastFrameLines = 0;

    function render(initial = false) {
      if (!initial && lastFrameLines > 0) {
        stdout.write(`${CSI}${lastFrameLines}A${CSI}0J`);
      }
      const lines: string[] = [];
      if (opts.title) {
        lines.push(`  ${C.bold}${opts.title}${C.reset}`);
      }
      const hint = opts.searchHint
        ? opts.searchHint
        : `${C.dim}↑/↓ navigate · Space toggle · Enter confirm · Esc cancel · type to filter${C.reset}`;
      lines.push(`  ${hint}`);
      if (search) {
        lines.push(`  ${C.dim}filter:${C.reset} ${C.cyan}${search}${C.reset}`);
      }
      lines.push('');

      if (filtered.length === 0) {
        lines.push(`  ${C.dim}(no matches)${C.reset}`);
      } else {
        const labelWidth = Math.max(...filtered.map((it) => visibleWidth(it.label)));
        const cur = clamp(cursor, 0, filtered.length - 1);
        for (let i = 0; i < filtered.length; i += 1) {
          const item = filtered[i]!;
          const itemIdx = opts.items.indexOf(item);
          const isCursor = i === cur;
          const isOn = selected.has(itemIdx);
          const cursorMark = isCursor ? `${C.cyan}▸${C.reset}` : ' ';
          const checkbox = isOn ? `${C.green}●${C.reset}` : `${C.dim}○${C.reset}`;
          const labelText = isCursor ? `${C.bold}${item.label}${C.reset}` : item.label;
          const pad = ' '.repeat(Math.max(0, labelWidth - visibleWidth(item.label)));
          const sub = item.sublabel ? `   ${C.faded}${item.sublabel}${C.reset}` : '';
          lines.push(`  ${cursorMark} ${checkbox} ${labelText}${pad}${sub}`);
        }
      }

      const min = opts.minSelected ?? 0;
      const count = selected.size;
      const summary =
        count < min
          ? `${C.yellow}select at least ${min} (currently ${count})${C.reset}`
          : `${C.dim}${count} selected${C.reset}`;
      lines.push('');
      lines.push(`  ${summary}`);
      lines.push('');
      const frame = lines.join('\n') + '\n';
      stdout.write(frame);
      lastFrameLines = countPhysicalRows(frame, stdout.columns);
    }

    function cleanup() {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      if (lastFrameLines > 0) {
        stdout.write(`${CSI}${lastFrameLines}A${CSI}0J`);
      }
    }

    function confirm() {
      const min = opts.minSelected ?? 0;
      if (selected.size < min) return;
      // Preserve the original list order when returning — callers
      // shouldn't depend on selection order. (The "first toggled is
      // primary" convention is preserved by sorting by toggle order;
      // see below.)
      // …actually for the agent-picker, we want toggle order so the
      // first thing the user picked is the primary. Track that.
      const ordered = toggleOrder.filter((idx) => selected.has(idx));
      cleanup();
      resolve(ordered.map((idx) => opts.items[idx]!.value));
    }

    const toggleOrder: number[] = [...(opts.initiallySelected ?? [])];

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

    function refilter() {
      filtered = filterItems(opts.items, search);
      cursor = 0;
      render();
    }

    function onData(buf: Buffer) {
      const str = buf.toString('utf8');
      if (str === '') {
        cleanup();
        resolve(null);
        return;
      }
      if (str === ESC) {
        cleanup();
        resolve(null);
        return;
      }
      if (str === '\r' || str === '\n') {
        confirm();
        return;
      }
      if (str === ' ') {
        if (filtered.length > 0) {
          const item = filtered[clamp(cursor, 0, filtered.length - 1)]!;
          toggle(opts.items.indexOf(item));
          render();
        }
        return;
      }
      if (str === '' || str === '\b') {
        if (search.length > 0) {
          search = search.slice(0, -1);
          refilter();
        }
        return;
      }
      if (str.startsWith(`${ESC}[`)) {
        const code = str.slice(2);
        if (code === 'A') {
          cursor = Math.max(0, cursor - 1);
          render();
          return;
        }
        if (code === 'B') {
          cursor = Math.min(filtered.length - 1, cursor + 1);
          render();
          return;
        }
        return;
      }
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

/** Non-TTY fallback: print a numbered list and read a line with the
 *  number (or value). Used by tests / piped invocations. */
async function numberedFallback<T>(opts: SelectOpts<T>): Promise<T | null> {
  process.stdout.write('\n');
  if (opts.title) process.stdout.write(`  ${opts.title}\n`);
  opts.items.forEach((it, i) => {
    const sub = it.sublabel ? `  ${it.sublabel}` : '';
    process.stdout.write(`  ${(i + 1).toString().padStart(2)}) ${it.label}${sub}\n`);
  });
  process.stdout.write('\n');
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('  Pick a number: ', (answer) => {
      rl.close();
      const n = Number.parseInt(answer.trim(), 10);
      if (!Number.isFinite(n) || n < 1 || n > opts.items.length) {
        resolve(null);
        return;
      }
      resolve(opts.items[n - 1]!.value);
    });
  });
}

async function numberedMultiFallback<T>(opts: MultiSelectOpts<T>): Promise<T[] | null> {
  process.stdout.write('\n');
  if (opts.title) process.stdout.write(`  ${opts.title}\n`);
  opts.items.forEach((it, i) => {
    const sub = it.sublabel ? `  ${it.sublabel}` : '';
    process.stdout.write(`  ${(i + 1).toString().padStart(2)}) ${it.label}${sub}\n`);
  });
  process.stdout.write('\n');
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('  Pick numbers (comma-separated, blank = all): ', (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (!trimmed) {
        resolve(opts.items.map((i) => i.value));
        return;
      }
      const out: T[] = [];
      for (const part of trimmed.split(',')) {
        const n = Number.parseInt(part.trim(), 10);
        if (Number.isFinite(n) && n >= 1 && n <= opts.items.length) {
          out.push(opts.items[n - 1]!.value);
        }
      }
      resolve(out.length > 0 ? out : null);
    });
  });
}
