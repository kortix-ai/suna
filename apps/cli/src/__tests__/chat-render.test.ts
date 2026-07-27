/**
 * Cursor math is the classic inline-TUI bug, and the alternate screen is the
 * classic inline-TUI temptation. Both are pinned here.
 */

import { describe, expect, test } from 'bun:test';

import { createRenderer } from '../chat/render.ts';

function target(columns = 80) {
  const writes: string[] = [];
  let cols = columns;
  return {
    writes,
    setColumns: (n: number) => {
      cols = n;
    },
    all: () => writes.join(''),
    since: (mark: number) => writes.slice(mark).join(''),
    target: { write: (text: string) => writes.push(text), columns: () => cols },
  };
}

describe('no alternate screen, ever', () => {
  test('nothing the renderer emits touches the alt-screen buffer', () => {
    const t = target();
    const r = createRenderer(t.target);

    r.commit(['hello']);
    r.setTail(['status'], 3);
    r.append('streaming');
    r.commit(['done']);
    r.handleResize();
    r.clearTail();

    // A Kortix session outlives the terminal, so the transcript must survive
    // in scrollback after detaching. `1049` would wipe it.
    expect(t.all()).not.toContain('1049');
    expect(t.all()).not.toContain('?47');
  });
});

describe('tail erase', () => {
  test('erases exactly the rows it drew, then draws the new tail', () => {
    const t = target(80);
    const r = createRenderer(t.target);

    r.setTail(['a', 'b']);
    const mark = t.writes.length;
    r.setTail(['c']);

    expect(t.since(mark)).toBe('\r\x1b[2A\x1b[0J' + 'c\n');
  });

  test('counts wrapped rows, so a long line does not leave debris', () => {
    const t = target(10);
    const r = createRenderer(t.target);

    r.setTail(['x'.repeat(25)]);
    const mark = t.writes.length;
    r.setTail([]);

    expect(t.since(mark)).toBe('\r\x1b[3A\x1b[0J');
  });

  test('a resize erases with the rows recorded at DRAW time, not the new width', () => {
    const t = target(40);
    const r = createRenderer(t.target);

    // 60 visible columns at width 40 is two physical rows.
    r.setTail(['y'.repeat(60)]);
    t.setColumns(100);
    const mark = t.writes.length;
    r.handleResize();

    // Recomputing at the new width would say 1 row and leave a line behind —
    // that is the latent bug in tui-select.ts's cleanup.
    expect(t.since(mark).startsWith('\r\x1b[2A\x1b[0J')).toBe(true);
  });

  test('an unchanged tail is not redrawn, so nothing flickers', () => {
    const t = target();
    const r = createRenderer(t.target);

    r.setTail(['same'], 2);
    const mark = t.writes.length;
    r.setTail(['same'], 2);

    expect(t.since(mark)).toBe('');
  });
});

describe('streaming text and the tail coexist', () => {
  test('a tail is never drawn over a half-written line', () => {
    const t = target();
    const r = createRenderer(t.target);

    r.append('He');
    const mark = t.writes.length;
    r.setTail(['status']);

    // Drawing here would put the next token on its own line.
    expect(t.since(mark)).toBe('');
  });

  test('tokens land on one line, and the tail returns once the line closes', () => {
    const t = target();
    const r = createRenderer(t.target);

    r.setTail(['status']);
    const mark = t.writes.length;
    r.append('He');
    r.append('llo');
    r.commit(['']);

    expect(t.since(mark)).toBe('\r\x1b[1A\x1b[0J' + 'He' + 'llo' + '\n' + '\n' + 'status\n');
  });

  test('committed lines are appended, never rewritten', () => {
    const t = target();
    const r = createRenderer(t.target);

    r.commit(['one', 'two']);

    expect(t.all()).toBe('one\ntwo\n');
  });
});

describe('cursor parking', () => {
  test('parks the cursor on the last tail line and erases from there', () => {
    const t = target(80);
    const r = createRenderer(t.target);

    r.setTail(['tools', 'you hi'], 6);
    const drawn = t.all();
    const mark = t.writes.length;
    r.setTail([]);

    expect(drawn).toBe('tools\nyou hi\n\x1b[1A\x1b[7G');
    // One row above the bottom, so the erase moves up one fewer row.
    expect(t.since(mark)).toBe('\r\x1b[1A\x1b[0J');
  });
});

/**
 * The composer must survive a reply that does not end in a newline.
 *
 * `drawTail` refuses to draw while the cursor sits mid-line — that is what
 * keeps streamed tokens on one line. But an assistant reply rarely ends in a
 * newline, so when the turn settles the cursor is mid-line and the composer is
 * never drawn: typing produces NO visible feedback until something else forces
 * a newline. On screen that is indistinguishable from a hang, and it is the
 * first thing you hit after any normal reply.
 *
 * Neither existing test layer could see it — the tui tests use a fake renderer
 * whose setTail always records, and the render tests only ever re-opened the
 * line via commit. So this composes the REAL renderer the way a real turn does:
 * mid-line append, then a tail draw.
 */
describe('a turn that ends mid-line still shows the composer', () => {
  test('setTail after a newline-less append draws nothing until closeLine', () => {
    const t = target();
    const r = createRenderer(t.target);

    r.append('Hello, that is done'); // no trailing newline — the normal case
    const mark = t.writes.length;

    r.setTail(['> ']);
    expect(t.since(mark)).toBe(''); // refuses to draw over the partial line

    r.closeLine();
    expect(t.since(mark)).toContain('> '); // composer is now on screen
  });

  test('closeLine is a no-op at a line start, so it cannot add a blank line', () => {
    const t = target();
    const r = createRenderer(t.target);

    r.commit(['done']); // leaves the cursor at a line start
    const mark = t.writes.length;

    r.closeLine();
    expect(t.since(mark)).toBe('');
  });
});
