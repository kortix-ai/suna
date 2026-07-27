import { describe, expect, test } from 'bun:test';

import { createComposer, type Composer } from '../chat/input.ts';

interface Harness {
  composer: Composer;
  submits: string[];
  interrupts: number;
  eofs: number;
  changes: number;
}

function harness(): Harness {
  const h: Partial<Harness> = { submits: [], interrupts: 0, eofs: 0, changes: 0 };
  h.composer = createComposer({
    onSubmit: (text) => h.submits!.push(text),
    onInterrupt: () => {
      h.interrupts! += 1;
    },
    onEof: () => {
      h.eofs! += 1;
    },
    onChange: () => {
      h.changes! += 1;
    },
  });
  return h as Harness;
}

describe('paste is one message, not N prompts', () => {
  test('a single chunk containing newlines becomes a multi-line composer and sends nothing', () => {
    const h = harness();

    h.composer.handleData(Buffer.from('a\nb\nc'));

    expect(h.submits).toEqual([]);
    expect(h.composer.text()).toBe('a\nb\nc');
    expect(h.composer.lines('you ')).toEqual(['you a', '  b', '  c']);
  });

  test('bracketed paste keeps its newlines literal, including across chunks', () => {
    const h = harness();

    h.composer.handleData(Buffer.from('\x1b[200~one\ntwo'));
    h.composer.handleData(Buffer.from('\nthree\x1b[201~'));

    expect(h.submits).toEqual([]);
    expect(h.composer.text()).toBe('one\ntwo\nthree');
  });

  test('CRLF from a pasted Windows file is normalized', () => {
    const h = harness();

    h.composer.handleData(Buffer.from('\x1b[200~a\r\nb\x1b[201~'));

    expect(h.composer.text()).toBe('a\nb');
  });

  test('a bare Enter still submits', () => {
    const h = harness();

    h.composer.handleData(Buffer.from('hello'));
    h.composer.handleData(Buffer.from('\r'));

    expect(h.submits).toEqual(['hello']);
    expect(h.composer.text()).toBe('');
  });

  test('type-ahead that lands in one chunk with a trailing Enter still submits once', () => {
    const h = harness();

    h.composer.handleData(Buffer.from('hello\r'));

    expect(h.submits).toEqual(['hello']);
  });

  test('a multi-line chunk with a trailing newline is still one message', () => {
    const h = harness();

    h.composer.handleData(Buffer.from('a\nb\n'));

    expect(h.submits).toEqual([]);
    expect(h.composer.text()).toBe('a\nb\n');
  });

  test('a backslash before Enter inserts a newline instead of sending', () => {
    const h = harness();

    h.composer.handleData(Buffer.from('first\\'));
    h.composer.handleData(Buffer.from('\r'));
    h.composer.handleData(Buffer.from('second'));

    expect(h.submits).toEqual([]);
    expect(h.composer.text()).toBe('first\nsecond');
  });

  test('Alt+Enter inserts a newline', () => {
    const h = harness();

    h.composer.handleData(Buffer.from('a'));
    h.composer.handleData(Buffer.from('\x1b\r'));
    h.composer.handleData(Buffer.from('b'));

    expect(h.composer.text()).toBe('a\nb');
    expect(h.submits).toEqual([]);
  });

  test('an empty or whitespace-only composer never submits', () => {
    const h = harness();

    h.composer.handleData(Buffer.from('\r'));
    h.composer.handleData(Buffer.from('   '));
    h.composer.handleData(Buffer.from('\r'));

    expect(h.submits).toEqual([]);
  });
});

describe('control keys', () => {
  test('Ctrl-C reports an interrupt and does NOT submit or clear by itself', () => {
    const h = harness();

    h.composer.handleData(Buffer.from('half typed'));
    h.composer.handleData(Buffer.from('\x03'));

    expect(h.interrupts).toBe(1);
    expect(h.submits).toEqual([]);
    // The host decides what Ctrl-C means; the composer only reports it.
    expect(h.composer.text()).toBe('half typed');
  });

  test('Ctrl-D is EOF only on an empty composer', () => {
    const h = harness();

    h.composer.handleData(Buffer.from('x'));
    h.composer.handleData(Buffer.from('\x04'));
    expect(h.eofs).toBe(0);

    h.composer.handleData(Buffer.from('\x7f'));
    h.composer.handleData(Buffer.from('\x04'));
    expect(h.eofs).toBe(1);
  });

  test('backspace, Ctrl-U and Ctrl-W edit the buffer', () => {
    const h = harness();

    h.composer.handleData(Buffer.from('hello world'));
    h.composer.handleData(Buffer.from('\x7f'));
    expect(h.composer.text()).toBe('hello worl');

    h.composer.handleData(Buffer.from('\x17'));
    expect(h.composer.text()).toBe('hello ');

    h.composer.handleData(Buffer.from('\x15'));
    expect(h.composer.text()).toBe('');
  });

  test('left/right/home/end move the cursor without changing the text', () => {
    const h = harness();

    h.composer.handleData(Buffer.from('abc'));
    h.composer.handleData(Buffer.from('\x1b[D'));
    h.composer.handleData(Buffer.from('X'));
    expect(h.composer.text()).toBe('abXc');

    h.composer.handleData(Buffer.from('\x1b[H'));
    h.composer.handleData(Buffer.from('Y'));
    expect(h.composer.text()).toBe('YabXc');

    h.composer.handleData(Buffer.from('\x1b[F'));
    h.composer.handleData(Buffer.from('Z'));
    expect(h.composer.text()).toBe('YabXcZ');
  });

  test('up/down walk submit history and restore the draft', () => {
    const h = harness();

    // Typed keystrokes arrive as separate chunks; a chunk that bundles text
    // WITH a newline is a paste (see the paste-heuristic tests above).
    h.composer.handleData(Buffer.from('first'));
    h.composer.handleData(Buffer.from('\r'));
    h.composer.handleData(Buffer.from('second'));
    h.composer.handleData(Buffer.from('\r'));
    h.composer.handleData(Buffer.from('draft'));

    h.composer.handleData(Buffer.from('\x1b[A'));
    expect(h.composer.text()).toBe('second');

    h.composer.handleData(Buffer.from('\x1b[A'));
    expect(h.composer.text()).toBe('first');

    h.composer.handleData(Buffer.from('\x1b[B'));
    expect(h.composer.text()).toBe('second');

    h.composer.handleData(Buffer.from('\x1b[B'));
    expect(h.composer.text()).toBe('draft');
  });

  test('unhandled escape sequences and control bytes never paint garbage', () => {
    const h = harness();

    h.composer.handleData(Buffer.from('\x1b[5~\x1b[200;3R\x00\x1b'));

    expect(h.composer.text()).toBe('');
  });
});

describe('cursor column', () => {
  test('accounts for the prompt on a single-line composer', () => {
    const h = harness();

    h.composer.handleData(Buffer.from('abc'));

    expect(h.composer.cursorColumn('you ')).toBe(7);
  });

  test('is null when the cursor is not on the last rendered line', () => {
    const h = harness();

    h.composer.handleData(Buffer.from('\x1b[200~a\nb\x1b[201~'));
    h.composer.handleData(Buffer.from('\x1b[D'));
    h.composer.handleData(Buffer.from('\x1b[D'));

    expect(h.composer.cursorColumn('you ')).toBeNull();
  });
});
