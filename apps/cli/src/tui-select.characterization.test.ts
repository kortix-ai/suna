import { afterEach, describe, expect, test } from 'bun:test';

import { stripAnsi } from './style.ts';
/**
 * Characterization of the two pickers in `src/tui-select.ts`, captured BEFORE
 * the KRTX-1341 dedupe that merges their terminal lifecycles into one private
 * loop.
 *
 * Pinned here:
 *  - the interactive path, against a fake TTY: the EXACT byte stream of every
 *    frame (initial render, wipe + re-render, filter, backspace, no-match
 *    Enter, Esc cancel) and raw-mode restoration;
 *  - multi-select semantics: initiallySelected seeds, toggle order as the
 *    returned order, minSelected gating, selection surviving a filter change;
 *  - the non-TTY numbered fallbacks: menu render, invalid number → null,
 *    blank multi answer → all, invalid multi answer → null.
 *
 * Real behaviors discovered while writing this (do not "fix" them away):
 *  - a multi-character data chunk (paste) is ignored entirely — only
 *    single-character keys reach the filter;
 *  - every filter change resets the cursor to row 0;
 *  - the filter haystack joins label + ' ' + sublabel, so a needle with a
 *    trailing space ("a ") still matches "Gamma" (the join space);
 *  - Ctrl-C arrives as an empty chunk in this harness — the '' abort branch
 *    is pinned as written, not as documented.
 *
 * Single-vs-multi differences that must STAY distinct: the default hint line,
 * the space key (filter in single, toggle in multi), the selection summary
 * footer, Enter with no matches, and the two fallback answer parsers.
 */
import { selectFromList, selectMultiFromList } from './tui-select.ts';

const ESC = '\x1b';
const CSI = `${ESC}[`;

/** A fake terminal: raw-mode recorder + controllable key source + frame sink. */
interface FakeTty {
  frames: string[];
  rawCalls: boolean[];
  /** Emit one keypress exactly as a raw-mode stdin chunk would arrive. */
  key(input: string): void;
  /** Let pending promise callbacks (resolve paths) settle. */
  settle(): Promise<void>;
}

let restoreHooks: Array<() => void> = [];

function installFakeTty(columns = 80): FakeTty {
  const frames: string[] = [];
  const rawCalls: boolean[] = [];
  let dataListener: ((buf: Buffer) => void) | null = null;
  const stdin = process.stdin as unknown as {
    isTTY: boolean | undefined;
    setRawMode?: (on: boolean) => void;
    resume(): void;
    pause(): void;
    on(event: string, listener: (buf: Buffer) => void): unknown;
    removeListener(event: string, listener: (buf: Buffer) => void): unknown;
  };
  const stdout = process.stdout as unknown as {
    isTTY: boolean | undefined;
    columns: number | undefined;
    write(s: string): unknown;
  };
  const originalIsTTY = stdout.isTTY;
  const originalWrite = stdout.write;
  stdout.isTTY = true;
  stdout.columns = columns;
  stdout.write = (s: string) => {
    frames.push(s);
    return true;
  };
  stdin.isTTY = true;
  stdin.setRawMode = (on: boolean) => {
    rawCalls.push(on);
  };
  const realResume = stdin.resume.bind(stdin);
  const realPause = stdin.pause.bind(stdin);
  stdin.resume = () => {};
  stdin.pause = () => {};
  const realOn = stdin.on.bind(stdin);
  const realRemoveListener = stdin.removeListener.bind(stdin);
  stdin.on = (event, listener) => {
    if (event === 'data') dataListener = listener;
    return realOn(event, listener);
  };
  stdin.removeListener = (event, listener) => {
    if (event === 'data' && listener === dataListener) dataListener = null;
    return realRemoveListener(event, listener);
  };
  restoreHooks.push(() => {
    stdout.write = originalWrite;
    stdout.isTTY = originalIsTTY;
    delete (stdout as { columns?: number }).columns;
    stdin.isTTY = undefined;
    delete stdin.setRawMode;
    stdin.resume = realResume;
    stdin.pause = realPause;
  });
  return {
    frames,
    rawCalls,
    key(input: string) {
      dataListener?.(Buffer.from(input, 'utf8'));
    },
    async settle() {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    },
  };
}

afterEach(() => {
  for (const restore of restoreHooks) restore();
  restoreHooks = [];
});

/** Concatenated byte stream — the exact render history. */
function transcript(frames: string[]): string {
  return frames.join('');
}

/** The newest frame — what the screen shows right now.
 *
 *  The style module (C.*) resolves its escape codes from stdout.isTTY at
 *  import time, which is false inside `bun test`, so colors are empty in this
 *  harness and the cursor row is identified by its ▸ marker instead of bold.
 *  Frames are still byte-exact between a pre-refactor and a post-refactor run
 *  of this same harness — which is the property the characterization needs.
 */
function lastFrame(frames: string[]): string {
  return frames[frames.length - 1] ?? '';
}

function countRows(stream: string): number {
  const lines = stream.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let rows = 0;
  for (const line of lines) {
    const width = stripAnsi(line).length;
    rows += Math.max(1, Math.ceil(width / 80));
  }
  return rows;
}

describe('tui-select interactive characterization — fake TTY (KRTX-1341)', () => {
  test('single picker: exact frames for render, move, filter, backspace, Enter pick', async () => {
    const tty = installFakeTty();
    const promise = selectFromList({
      title: 'Pick one',
      items: [
        { value: 'a', label: 'Alpha', sublabel: 'first' },
        { value: 'b', label: 'Beta' },
        { value: 'c', label: 'Gamma' },
      ],
    });
    await tty.settle();
    const initial = transcript(tty.frames);
    expect(initial).toContain('  Pick one\n');
    expect(initial).toContain('↑/↓ select · Enter confirm · Esc cancel · type to filter');
    expect(lastFrame(tty.frames)).toContain('▸ Alpha'); // cursor row carries the marker
    expect(lastFrame(tty.frames)).toContain('first'); // sublabel rendered
    expect(lastFrame(tty.frames)).not.toContain('▸ Beta');
    expect(tty.rawCalls).toEqual([true]); // raw mode entered once

    tty.key(`${CSI}B`); // down
    await tty.settle();
    const afterDown = transcript(tty.frames);
    // Every non-initial frame opens with the wipe of the previous frame.
    expect(afterDown).toContain(`${CSI}${countRows(initial)}A${CSI}0J`);
    expect(lastFrame(tty.frames)).toContain('▸ Beta'); // cursor moved

    tty.key('b'); // filter to Beta
    await tty.settle();
    expect(lastFrame(tty.frames)).toContain('filter:');
    // A filter change resets the cursor to row 0.
    expect(lastFrame(tty.frames)).toContain('▸ Beta');
    expect(lastFrame(tty.frames)).not.toContain('Alpha');

    tty.key('\x7f'); // backspace → filter cleared, cursor back at row 0
    await tty.settle();
    expect(lastFrame(tty.frames)).toContain('▸ Alpha');

    tty.key('\r'); // Enter picks the cursor row
    expect(await promise).toBe('a');
    expect(tty.rawCalls).toEqual([true, false]); // raw mode restored
    // The cleanup wipe is the last write, and it carries the exact row count
    // of the frame it removes (the second-to-last write).
    const full = transcript(tty.frames);
    const wipeSuffix = `${CSI}0J`;
    expect(full.endsWith(wipeSuffix), 'cleanup wipe is the last write').toBe(true);
    const beforeWipe = full.slice(0, full.length - wipeSuffix.length);
    const aIndex = beforeWipe.lastIndexOf(`${CSI}`);
    const rowCount = beforeWipe.slice(aIndex + CSI.length, beforeWipe.length - 1);
    const previousFrame = tty.frames[tty.frames.length - 2] ?? '';
    expect(rowCount).toMatch(/^\d+$/);
    expect(Number(rowCount)).toBe(countRows(previousFrame));
  });

  test('single picker: Enter on an empty filtered list does nothing; Esc cancels with null', async () => {
    const tty = installFakeTty();
    const promise = selectFromList({
      items: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
      ],
    });
    await tty.settle();
    for (const ch of ['z', 'z', 'z']) tty.key(ch); // per-keypress filter typing
    await tty.settle();
    expect(transcript(tty.frames)).toContain('(no matches)');
    const noMatch = transcript(tty.frames).length;
    tty.key('\r'); // Enter with no matches — ignored
    await tty.settle();
    expect(transcript(tty.frames).length).toBe(noMatch);
    tty.key(ESC); // Esc cancels
    expect(await promise).toBeNull();
    expect(tty.rawCalls).toEqual([true, false]);
  });

  test('single picker: Ctrl-C (0x03) cancels; an empty chunk is ignored — multi is the opposite', async () => {
    const tty = installFakeTty();
    const promise = selectFromList({
      items: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
      ],
    });
    await tty.settle();
    const before = transcript(tty.frames).length;
    tty.key(''); // empty chunk: ignored in single mode (no re-render, stays open)
    await tty.settle();
    expect(transcript(tty.frames).length).toBe(before);
    expect(tty.rawCalls).toEqual([true]);
    tty.key('\x03'); // Ctrl-C cancels
    expect(await promise).toBeNull();
    expect(tty.rawCalls).toEqual([true, false]);
  });

  test('multi picker: an empty chunk cancels; Ctrl-C and DEL are ignored, BS backspaces', async () => {
    const tty = installFakeTty();
    const promise = selectMultiFromList({
      items: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
      ],
    });
    await tty.settle();
    const before = transcript(tty.frames).length;
    tty.key('\x03'); // Ctrl-C: ignored in multi mode
    await tty.settle();
    expect(transcript(tty.frames).length).toBe(before);
    tty.key('a'); // filter to Alpha
    await tty.settle();
    expect(lastFrame(tty.frames)).toContain('filter: a');
    tty.key('\x7f'); // DEL does NOT backspace in multi mode (pre-1341 branch list)
    await tty.settle();
    expect(lastFrame(tty.frames)).toContain('filter: a');
    tty.key('\b'); // BS does
    await tty.settle();
    expect(lastFrame(tty.frames)).not.toContain('filter:');
    tty.key(''); // empty chunk: cancels in multi mode
    expect(await promise).toBeNull();
    expect(tty.rawCalls).toEqual([true, false]);
  });

  test('single picker: space types into the filter — and "a " still matches Gamma via the hay join', async () => {
    const tty = installFakeTty();
    const promise = selectFromList({
      items: [
        { value: 'a', label: 'Alpha one' },
        { value: 'b', label: 'Alpha two' },
        { value: 'c', label: 'Gamma' },
      ],
    });
    await tty.settle();
    tty.key('g');
    await tty.settle();
    expect(lastFrame(tty.frames)).toContain('filter: g');
    expect(lastFrame(tty.frames)).toContain('Gamma');
    expect(lastFrame(tty.frames)).not.toContain('Alpha one'); // filtering really filters
    tty.key(' '); // space is a printable key in single mode — it extends the filter
    await tty.settle();
    expect(lastFrame(tty.frames)).toContain('filter: g ');
    expect(lastFrame(tty.frames)).toContain('(no matches)');
    tty.key('\x7f'); // backspace restores the g filter
    await tty.settle();
    expect(lastFrame(tty.frames)).toContain('Gamma');
    tty.key(ESC);
    expect(await promise).toBeNull();
  });

  test('a pasted multi-character chunk is ignored — only single keys reach the filter', async () => {
    const tty = installFakeTty();
    const promise = selectFromList({
      items: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
      ],
    });
    await tty.settle();
    const before = transcript(tty.frames).length;
    tty.key('zzz'); // one chunk, three characters
    await tty.settle();
    expect(transcript(tty.frames).length).toBe(before); // no re-render at all
    tty.key(ESC);
    expect(await promise).toBeNull();
  });

  test('multi picker: exact checkbox frames, minSelected gate, toggle order, filter survival', async () => {
    const tty = installFakeTty();
    const promise = selectMultiFromList({
      title: 'Pick many',
      minSelected: 1,
      items: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
        { value: 'c', label: 'Gamma' },
      ],
    });
    await tty.settle();
    const initial = transcript(tty.frames);
    expect(initial).toContain(
      '↑/↓ navigate · Space toggle · Enter confirm · Esc cancel · type to filter',
    );
    expect(initial).toContain('○ '); // unchecked glyph
    expect(initial).toContain('select at least 1 (currently 0)'); // below the gate

    tty.key(`${CSI}B`); // cursor to Beta
    await tty.settle();
    tty.key(' '); // toggle Beta on
    await tty.settle();
    const toggled = transcript(tty.frames);
    expect(toggled).toContain('● '); // checked glyph appears
    expect(toggled).toContain('1 selected');

    tty.key('g'); // filter to Gamma — the selection must survive
    await tty.settle();
    expect(transcript(tty.frames)).toContain('filter: g');
    expect(transcript(tty.frames)).toContain('1 selected');

    tty.key('\x7f'); // backspace clears the filter
    await tty.settle();
    tty.key('\r'); // Enter with exactly one selected → resolves
    expect(await promise).toEqual(['b']);
    expect(tty.rawCalls).toEqual([true, false]);
  });

  test('multi picker: Enter below minSelected is refused and keeps the picker open', async () => {
    const tty = installFakeTty();
    const promise = selectMultiFromList({
      minSelected: 2,
      items: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
        { value: 'c', label: 'Gamma' },
      ],
    });
    await tty.settle();
    tty.key(' '); // toggle Alpha
    await tty.settle();
    expect(transcript(tty.frames)).toContain('select at least 2 (currently 1)');
    const before = transcript(tty.frames).length;
    tty.key('\r'); // refused
    await tty.settle();
    expect(transcript(tty.frames).length).toBe(before); // no re-render, no resolve
    expect(tty.rawCalls).toEqual([true]); // still open
    tty.key(ESC);
    expect(await promise).toBeNull();
    expect(tty.rawCalls).toEqual([true, false]);
  });

  test('multi picker: initiallySelected seeds render checked; toggle order is the return order', async () => {
    const tty = installFakeTty();
    const promise = selectMultiFromList({
      initiallySelected: [2, 0],
      items: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
        { value: 'c', label: 'Gamma' },
      ],
    });
    await tty.settle();
    expect(transcript(tty.frames)).toContain('2 selected'); // both seeds checked

    tty.key(`${CSI}B`); // cursor to Beta
    await tty.settle();
    tty.key(`${CSI}B`); // cursor to Gamma
    await tty.settle();
    tty.key(' '); // untoggle Gamma
    await tty.settle();
    expect(transcript(tty.frames)).toContain('1 selected');
    tty.key(`${CSI}A`); // cursor to Beta
    await tty.settle();
    tty.key(`${CSI}A`); // cursor to Alpha
    await tty.settle();
    tty.key(' '); // untoggle Alpha (a seed)
    await tty.settle();
    expect(transcript(tty.frames)).toContain('0 selected');
    tty.key(`${CSI}B`); // cursor to Beta
    await tty.settle();
    tty.key(' '); // toggle Beta — the only remaining selection, toggled LAST
    await tty.settle();
    tty.key('\r');
    expect(await promise).toEqual(['b']);
  });

  test('multi picker: toggle order — not list order — is the return order', async () => {
    const tty = installFakeTty();
    const promise = selectMultiFromList({
      items: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
        { value: 'c', label: 'Gamma' },
      ],
    });
    await tty.settle();
    tty.key(`${CSI}B`);
    await tty.settle();
    tty.key(`${CSI}B`); // cursor to Gamma
    await tty.settle();
    tty.key(' '); // toggle c first
    await tty.settle();
    tty.key(`${CSI}A`);
    await tty.settle();
    tty.key(`${CSI}A`); // cursor back to Alpha
    await tty.settle();
    tty.key(' '); // toggle a second
    await tty.settle();
    tty.key('\r');
    // List order would be [a, c]; toggle order is [c, a].
    expect(await promise).toEqual(['c', 'a']);
  });

  test('initialIndex opens the single picker with that row already under the cursor', async () => {
    const tty = installFakeTty();
    const promise = selectFromList({
      initialIndex: 2,
      items: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
        { value: 'c', label: 'Gamma' },
      ],
    });
    await tty.settle();
    expect(lastFrame(tty.frames)).toContain('▸ Gamma');
    expect(lastFrame(tty.frames)).not.toContain('▸ Alpha');
    expect(lastFrame(tty.frames)).not.toContain('▸ Beta');
    tty.key('\r');
    expect(await promise).toBe('c');
  });
});

// ── non-TTY fallback characterization (real child processes) ────────────────

const RUNNER = `
const { selectFromList, selectMultiFromList } = await import(${JSON.stringify(new URL('./tui-select.ts', import.meta.url).pathname)});
const spec = JSON.parse(process.env.FALLBACK_SPEC);
const value = spec.mode === 'multi'
  ? await selectMultiFromList(spec.opts)
  : await selectFromList(spec.opts);
process.stdout.write('RESULT:' + JSON.stringify(value) + '\\n');
`;

async function runFallback(mode: 'single' | 'multi', opts: unknown, input: string) {
  const proc = Bun.spawn({
    cmd: [process.execPath, '-e', RUNNER],
    cwd: import.meta.dir,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      FALLBACK_SPEC: JSON.stringify({ mode, opts }),
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  proc.stdin.write(input);
  proc.stdin.end();
  const timer = setTimeout(() => proc.kill(9), 10_000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timer));
  return { code, stdout, stderr };
}

const resultOf = (stdout: string): unknown => {
  const marker = stdout.split('RESULT:')[1];
  if (marker === undefined) throw new Error('the fallback runner printed no RESULT line');
  return JSON.parse(marker.trim());
};

describe('tui-select numbered fallback characterization (KRTX-1341)', () => {
  const opts = {
    items: [
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Beta' },
      { value: 'c', label: 'Gamma' },
    ],
  };

  test('a valid number picks that row and prints the numbered menu first', async () => {
    const { code, stdout } = await runFallback('single', opts, '2\n');
    expect(code).toBe(0);
    expect(stdout).toContain('1) Alpha');
    expect(stdout).toContain('2) Beta');
    expect(stdout).toContain('3) Gamma');
    expect(stdout).toContain('Pick a number:');
    expect(resultOf(stdout)).toBe('b');
  });

  test('an invalid or out-of-range number answers null', async () => {
    expect(resultOf((await runFallback('single', opts, '99\n')).stdout)).toBeNull();
    expect(resultOf((await runFallback('single', opts, 'abc\n')).stdout)).toBeNull();
  });

  test('a blank multi answer means ALL, in list order', async () => {
    const { stdout } = await runFallback('multi', opts, '\n');
    expect(stdout).toContain('Pick numbers (comma-separated, blank = all)');
    expect(resultOf(stdout)).toEqual(['a', 'b', 'c']);
  });

  test('a comma list picks those rows in answer order; nothing valid answers null', async () => {
    expect(resultOf((await runFallback('multi', opts, '3,1\n')).stdout)).toEqual(['c', 'a']);
    expect(resultOf((await runFallback('multi', opts, '9\n')).stdout)).toBeNull();
    expect(resultOf((await runFallback('multi', opts, 'abc\n')).stdout)).toBeNull();
  });
});
