import { describe, expect, test } from 'bun:test';

import { timeField } from './session-transcript-capture';

test('transcript capture rejects timestamps outside the Date range', () => {
  expect(timeField({ time: { created: Number.MAX_VALUE } }, 'created')).toBeNull();
  expect(timeField({ time: { created: 1_700_000_000_000 } }, 'created')?.getTime()).toBe(1_700_000_000_000);
});

import {
  capturedMessageIndex,
  capturedPageGate,
  MIRROR_CAPTURE_LIMIT,
  MIRROR_MAX_MESSAGE_CHARS,
  MIRROR_MAX_PART_CHARS,
  headCompleteAfterCapture,
  mirrorPartsAreStripped,
  mirrorRowsFromOpencodePayload,
  restoreStrippedToolParts,
  sanitizeParts,
} from './session-transcript-mirror';

describe('sanitizeParts', () => {
  test('a file part keeps its name, type and mention source, and LOSES its bytes', () => {
    // A base64 `data:` url here is the whole 7-19 MB transcript incident: the
    // mirror is read on every cold open, so one embedded screenshot would make
    // the wake slower than the wake it exists to hide. The mention source is
    // what places an `@file` highlight in the prompt, so it stays.
    const source = { type: 'file', path: 'src/app.ts', text: { value: '@src/app.ts', start: 6, end: 17 } };
    const [part] = sanitizeParts([
      {
        id: 'prt_1',
        type: 'file',
        filename: 'shot.png',
        mime: 'image/png',
        url: `data:image/png;base64,${'A'.repeat(5000)}`,
        source,
      },
    ]);
    expect(part).toEqual({ id: 'prt_1', type: 'file', filename: 'shot.png', mime: 'image/png', source });
  });

  test('a mention source too large to be a mention is dropped, never cut', () => {
    const [part] = sanitizeParts([
      {
        id: 'prt_1',
        type: 'file',
        filename: 'a.ts',
        mime: 'text/plain',
        source: { type: 'file', path: 'a.ts', text: { value: 'A'.repeat(20_000), start: 0, end: 5 } },
      },
    ]);
    expect(part).toEqual({ id: 'prt_1', type: 'file', filename: 'a.ts', mime: 'text/plain' });
  });

  test('a tool part is kept 1:1 — input, output, title, metadata and time', () => {
    // Saved history renders from these rows while the computer is off, and
    // every tool card draws from its input (the command, the path, the
    // pattern) and most from its output. Stripping them drew empty cards.
    const tool = {
      id: 'prt_2',
      type: 'tool',
      tool: 'bash',
      callID: 'call_1',
      state: {
        status: 'completed',
        title: 'List the build output',
        time: { start: 1, end: 2 },
        input: { command: 'ls -la dist', description: 'List the build output' },
        output: `total 8\n${'-rw-r--r-- 1 user staff 42 app.js\n'.repeat(2_000)}`,
        metadata: { exit: 0, description: 'List the build output' },
      },
    };
    expect(sanitizeParts([tool])).toEqual([tool]);
  });

  test('a failed tool keeps its input and its error', () => {
    const tool = {
      id: 'prt_3',
      type: 'tool',
      tool: 'read',
      callID: 'call_2',
      state: {
        status: 'error',
        input: { filePath: '/workspace/missing.ts' },
        error: 'File not found: /workspace/missing.ts',
        time: { start: 1, end: 2 },
      },
    };
    expect(sanitizeParts([tool])).toEqual([tool]);
  });

  test('tool attachments keep their name and type and LOSE their bytes', () => {
    const ref =
      'kortix-attachment://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333';
    const [part] = sanitizeParts([
      {
        id: 'prt_4',
        type: 'tool',
        tool: 'read',
        state: {
          status: 'completed',
          input: { filePath: '/workspace/shot.png' },
          output: 'Image read successfully',
          time: { start: 1, end: 2 },
          attachments: [
            { id: 'a1', type: 'file', mime: 'image/png', filename: 'shot.png', url: `data:image/png;base64,${'A'.repeat(9_000)}` },
            { id: 'a2', type: 'file', mime: 'image/png', filename: 'kept.png', url: ref },
          ],
        },
      },
    ]);
    const state = part.state as Record<string, unknown>;
    expect(JSON.stringify(state)).not.toContain('base64');
    expect(state.attachments).toEqual([
      { id: 'a1', type: 'file', mime: 'image/png', filename: 'shot.png' },
      { id: 'a2', type: 'file', mime: 'image/png', filename: 'kept.png', url: ref },
    ]);
  });

  test('a data: URL anywhere in a tool payload is dropped, the rest of the payload kept', () => {
    const bytes = `data:image/png;base64,${'A'.repeat(9_000)}`;
    const [part] = sanitizeParts([
      {
        id: 'prt_5',
        type: 'tool',
        tool: 'browser_screenshot',
        state: {
          status: 'completed',
          input: { selector: '#chart', image: bytes, frames: [bytes, 'frame-2'] },
          output: bytes,
          metadata: { preview: bytes, width: 800 },
          time: { start: 1, end: 2 },
        },
      },
    ]);
    const state = part.state as Record<string, unknown>;
    expect(JSON.stringify(state)).not.toContain('base64');
    expect(state.input).toEqual({ selector: '#chart', frames: ['frame-2'] });
    expect('output' in state).toBe(false);
    expect(state.metadata).toEqual({ width: 800 });
  });

  test('tool payloads spend their own budget, so they never cut the reply text', () => {
    const output = 'O'.repeat(MIRROR_MAX_PART_CHARS);
    const tools = Array.from({ length: 8 }, (_, index) => ({
      id: `t${index}`,
      type: 'tool',
      tool: 'read',
      state: { status: 'completed', input: { filePath: `/workspace/${index}.ts` }, output, time: { start: 1, end: 2 } },
    }));
    const parts = sanitizeParts([...tools, { id: 'reply', type: 'text', text: 'The answer.' }]);
    expect(parts.at(-1)).toEqual({ id: 'reply', type: 'text', text: 'The answer.' });
    const kept = parts
      .slice(0, -1)
      .reduce((sum, part) => sum + String((part.state as { output?: string }).output ?? '').length, 0);
    expect(kept).toBeLessThanOrEqual(MIRROR_MAX_MESSAGE_CHARS);
    // Every call keeps its input: the card still says what it read.
    for (const part of parts.slice(0, -1)) {
      expect((part.state as { input: { filePath: string } }).input.filePath).toStartWith('/workspace/');
    }
  });

  test('one pathological tool string is capped at the per-part limit', () => {
    const [part] = sanitizeParts([
      {
        id: 'prt_6',
        type: 'tool',
        tool: 'write',
        state: {
          status: 'completed',
          input: { filePath: '/workspace/big.txt', content: 'W'.repeat(MIRROR_MAX_PART_CHARS + 50_000) },
          output: 'Wrote file successfully.',
          time: { start: 1, end: 2 },
        },
      },
    ]);
    const input = (part.state as { input: { filePath: string; content: string } }).input;
    expect(input.content.length).toBe(MIRROR_MAX_PART_CHARS);
    expect(input.filePath).toBe('/workspace/big.txt');
  });

  test('a settled tool call always carries an input, so a row the old mirror stripped is recognizable', () => {
    const [part] = sanitizeParts([
      { id: 'p', type: 'tool', tool: 'todoread', state: { status: 'completed', output: '[]', time: { start: 1, end: 2 } } },
    ]);
    expect((part.state as { input: unknown }).input).toEqual({});
    expect(mirrorPartsAreStripped(sanitizeParts([part]))).toBe(false);
  });

  test('a show card keeps the input it is DRAWN from, and its output', () => {
    // The SDK's `isEmptyShowPart` drops a completed show whose input is empty,
    // so stripping it made every result an agent had shown vanish from the
    // saved transcript while the sandbox was off.
    const [part] = sanitizeParts([
      {
        id: 'prt_show',
        type: 'tool',
        tool: 'show',
        callID: 'call_show',
        state: {
          status: 'completed',
          title: 'Revenue chart',
          time: { start: 1, end: 2 },
          input: {
            type: 'image',
            title: 'Revenue chart',
            description: 'Q3 by region',
            path: '/workspace/out/revenue.png',
            aspect_ratio: '16:9',
            metadata: { unbounded: 'A'.repeat(10_000) },
          },
          output: 'Shown to the user.',
        },
      },
    ]);
    expect(part.state).toEqual({
      status: 'completed',
      title: 'Revenue chart',
      time: { start: 1, end: 2 },
      input: {
        type: 'image',
        title: 'Revenue chart',
        description: 'Q3 by region',
        path: '/workspace/out/revenue.png',
        aspect_ratio: '16:9',
      },
      output: 'Shown to the user.',
    });
  });

  test('every spelling the SDK treats as show keeps its input', () => {
    for (const tool of ['show', 'show_user', 'oc-show', 'show-user']) {
      const [part] = sanitizeParts([
        { id: 'p', type: 'tool', tool, state: { status: 'completed', input: { url: 'https://x.test' } } },
      ]);
      expect((part.state as { input?: unknown }).input).toEqual({ url: 'https://x.test' });
    }
  });

  test('a show input never smuggles a data: URL past the 7-19 MB guard', () => {
    const bytes = `data:image/png;base64,${'A'.repeat(5_000)}`;
    const [part] = sanitizeParts([
      {
        id: 'p',
        type: 'tool',
        tool: 'show',
        state: {
          status: 'completed',
          input: {
            type: 'image',
            title: 'kept',
            url: bytes,
            content: bytes,
            // `items` as the JSON STRING the model often sends: stored verbatim
            // it would carry the bytes past every check on the top-level fields.
            items: JSON.stringify([{ type: 'image', url: bytes }, { type: 'image', path: '/workspace/a.png' }]),
          },
        },
      },
    ]);
    const input = (part.state as { input: Record<string, unknown> }).input;
    expect(JSON.stringify(input)).not.toContain('base64');
    expect(input).toEqual({
      type: 'image',
      title: 'kept',
      items: [{ type: 'image' }, { type: 'image', path: '/workspace/a.png' }],
    });
  });

  test('show content is capped like any other tool string', () => {
    const [text, show] = sanitizeParts([
      { id: 'a', type: 'text', text: 'A'.repeat(MIRROR_MAX_PART_CHARS) },
      {
        id: 'b',
        type: 'tool',
        tool: 'show',
        state: { status: 'completed', input: { type: 'markdown', content: 'B'.repeat(MIRROR_MAX_PART_CHARS * 10) } },
      },
    ]);
    expect((text.text as string).length).toBe(MIRROR_MAX_PART_CHARS);
    const content = (show.state as { input: { content: string } }).input.content;
    expect(content.length).toBe(MIRROR_MAX_PART_CHARS);
  });

  test('a reference that would have to be cut is dropped, never truncated', () => {
    // A truncated path or URL points somewhere WRONG; an absent one is honest.
    const [part] = sanitizeParts([
      {
        id: 'p',
        type: 'tool',
        tool: 'show',
        state: { status: 'completed', input: { title: 't', path: `/workspace/${'x'.repeat(5_000)}` } },
      },
    ]);
    expect((part.state as { input: Record<string, unknown> }).input).toEqual({ title: 't' });
  });

  test('a show with nothing drawable keeps an EMPTY input — the card is dropped either way', () => {
    // The SDK's `isEmptyShowPart` drops a completed show whose input draws
    // nothing, live or saved. The empty object is what tells this row apart
    // from one the old mirror stripped (`mirrorPartsAreStripped`).
    const [part] = sanitizeParts([
      { id: 'p', type: 'tool', tool: 'show', state: { status: 'completed', input: { items: 'not json' } } },
    ]);
    expect((part.state as { input: unknown }).input).toEqual({});
  });

  test('a text part survives intact — it is the transcript', () => {
    expect(sanitizeParts([{ id: 'p', type: 'text', text: 'hello world' }])).toEqual([
      { id: 'p', type: 'text', text: 'hello world' },
    ]);
  });

  test('a step-finish part survives — the turn boundary is structure, not noise', () => {
    expect(sanitizeParts([{ id: 'p', type: 'step-finish' }])).toEqual([
      { id: 'p', type: 'step-finish' },
    ]);
  });

  test('one pathological part is capped, and the per-message budget caps the rest', () => {
    const parts = sanitizeParts([
      { id: 'a', type: 'text', text: 'A'.repeat(MIRROR_MAX_PART_CHARS + 10_000) },
      { id: 'b', type: 'text', text: 'B'.repeat(MIRROR_MAX_MESSAGE_CHARS) },
      { id: 'c', type: 'text', text: 'C'.repeat(1_000) },
    ]);
    expect((parts[0].text as string).length).toBe(MIRROR_MAX_PART_CHARS);
    const total = parts.reduce((n, p) => n + String(p.text ?? '').length, 0);
    expect(total).toBeLessThanOrEqual(MIRROR_MAX_MESSAGE_CHARS);
    // The budget runs out; it does not invent a marker message.
    expect(parts).toHaveLength(3);
  });

  test('a non-array or a non-object member is dropped, never coerced', () => {
    expect(sanitizeParts(null)).toEqual([]);
    expect(sanitizeParts('nope')).toEqual([]);
    expect(sanitizeParts([1, null, ['x'], { id: 'p', type: 'text', text: 'k' }])).toEqual([
      { id: 'p', type: 'text', text: 'k' },
    ]);
  });
});

describe('mirrorRowsFromOpencodePayload', () => {
  const msg = (info: Record<string, unknown>, parts: unknown[] = []) => ({ info, parts });

  test('info is kept VERBATIM — including time.completed and error', () => {
    // This is the acceptance criterion the deleted client mirror failed. Its
    // freshness test read the transcript's SHAPE, and a STOP moves none of it,
    // so a stopped thread cold-painted as still running. `time.completed` and
    // `error` are the only two things that end a turn; they must travel with
    // the message.
    const info = {
      id: 'msg_2',
      sessionID: 'ses_1',
      role: 'assistant',
      parentID: 'msg_1',
      time: { created: 1000, completed: 2000 },
      error: { name: 'MessageAbortedError', data: { message: 'stopped' } },
      cost: 0.1,
      tokens: { input: 1, output: 2 },
    };
    const [row] = mirrorRowsFromOpencodePayload([msg(info)]);
    expect(row.info).toEqual(info);
  });

  test('a message with no id is DROPPED, never synthesized', () => {
    // An id the live sync store will not also produce is exactly the ghost
    // this mirror exists to avoid: the settle rule keys on the id and nothing
    // else, so an invented one can never be reconciled away.
    const rows = mirrorRowsFromOpencodePayload([
      msg({ role: 'user' }),
      msg({ id: '   ', role: 'user' }),
      msg({ id: 'msg_ok', role: 'user' }),
    ]);
    expect(rows.map((r) => r.info.id)).toEqual(['msg_ok']);
  });

  test('a message with no info wrapper is dropped', () => {
    expect(mirrorRowsFromOpencodePayload([{ id: 'msg_1', role: 'user' }])).toEqual([]);
  });

  test('both the bare array and the {messages:[...]} envelope are read', () => {
    const one = [msg({ id: 'msg_1', role: 'user' })];
    expect(mirrorRowsFromOpencodePayload(one)).toHaveLength(1);
    expect(mirrorRowsFromOpencodePayload({ messages: one })).toHaveLength(1);
    expect(mirrorRowsFromOpencodePayload(null)).toEqual([]);
  });

  test('parts are sanitized on the way in, not on the way out', () => {
    const [row] = mirrorRowsFromOpencodePayload([
      msg({ id: 'msg_1', role: 'user' }, [
        { id: 'p', type: 'file', filename: 'a.png', mime: 'image/png', url: 'data:...' },
      ]),
    ]);
    expect(row.parts).toEqual([{ id: 'p', type: 'file', filename: 'a.png', mime: 'image/png' }]);
  });

  /*
    Postgres jsonb rejects a string it cannot represent: `'{"a":"x\u0000y"}'::jsonb`
    fails with `unsupported Unicode escape sequence — \u0000 cannot be converted
    to text.` (SQLSTATE 22P05). The mirror write is deterministic on its
    content, so one such message failed the whole capture transaction and the
    same doomed write retried at every turn end — 568 warn lines in one hour on
    prod (KRTX-1701). The projection is therefore the guard: every string it
    emits must survive a jsonb write.
  */
  const carriesUnrepresentable = (value: unknown, key?: string): boolean => {
    const unrepresentable = (text: string) => /\0|[\uD800-\uDFFF]/u.test(text);
    if (key !== undefined && unrepresentable(key)) return true;
    if (typeof value === 'string') return unrepresentable(value);
    if (Array.isArray(value)) return value.some((item) => carriesUnrepresentable(item));
    if (value && typeof value === 'object') {
      return Object.entries(value).some(([k, v]) => carriesUnrepresentable(v, k));
    }
    return false;
  };

  test('a tool output carrying a NUL is made storable, and the rest is kept', () => {
    const [row] = mirrorRowsFromOpencodePayload([
      msg({ id: 'msg_1', role: 'assistant' }, [
        {
          id: 'p',
          type: 'tool',
          state: { status: 'done', input: { command: 'cat bin' }, output: 'GIF89a\0\u0001D\0;' },
        },
      ]),
    ]);
    expect(carriesUnrepresentable(row.parts)).toBe(false);
    const output = (row.parts[0] as { state: { output: string } }).state.output;
    expect(output).toBe('GIF89a\uFFFD\u0001D\uFFFD;');
  });

  test('a NUL inside info is made storable, and well-formed info is untouched', () => {
    const [row] = mirrorRowsFromOpencodePayload([
      msg({
        id: 'msg_1',
        role: 'assistant',
        time: { created: 1000, completed: 2000 },
        error: { name: 'MessageAbortedError', data: { message: 'cut\0off' } },
      }),
    ]);
    expect(carriesUnrepresentable(row.info)).toBe(false);
    expect(row.info).toMatchObject({
      id: 'msg_1',
      time: { created: 1000, completed: 2000 },
      error: { data: { message: 'cut\uFFFDoff' } },
    });
  });

  test('well-formed content survives untouched — every emoji, every BMP char', () => {
    // The pair test is unicode-aware, so an astral character's surrogate
    // halves must never read as a lone surrogate and get rewritten.
    const text = 'emoji \u{1F600} CJK \u6F22\u5B57 accent \u00e9';
    const [row] = mirrorRowsFromOpencodePayload([
      msg({ id: 'msg_1', role: 'user', title: text }, [
        { id: 'p', type: 'text', text },
      ]),
    ]);
    expect(row.info.title).toBe(text);
    expect(row.parts).toEqual([{ id: 'p', type: 'text', text }]);
  });

  test('a lone surrogate becomes U+FFFD — the other string jsonb cannot store', () => {
    // jsonb insists a surrogate pair designate a character correctly, so a
    // lone `\ud83d` fails the INSERT just as deterministically.
    const [row] = mirrorRowsFromOpencodePayload([
      msg({ id: 'msg_1', role: 'user' }, [
        { id: 'p', type: 'text', text: 'half of an emoji: \ud83d' },
      ]),
    ]);
    expect(carriesUnrepresentable(row.parts)).toBe(false);
    expect((row.parts[0] as { text: string }).text).toBe('half of an emoji: \uFFFD');
  });

  test('a NUL in an object key is made storable too', () => {
    const [row] = mirrorRowsFromOpencodePayload([
      msg({ id: 'msg_1', role: 'user' }, [
        { id: 'p', type: 'tool', state: { status: 'done', input: { 'a\0b': 'v' }, output: 'ok' } },
      ]),
    ]);
    expect(carriesUnrepresentable(row.parts)).toBe(false);
  });
});

describe('headCompleteAfterCapture', () => {
  test('fewer messages than the window PROVES the head was seen', () => {
    expect(
      headCompleteAfterCapture({ returned: 12, limit: MIRROR_CAPTURE_LIMIT, previous: false }),
    ).toBe(true);
  });

  test('a full window proves nothing, so the previous verdict stands', () => {
    // "Exactly `limit` came back" cannot distinguish "the thread is exactly
    // that long" from "there is more above". Claiming completeness here is the
    // negative-as-a-claim mistake in the other direction.
    expect(
      headCompleteAfterCapture({
        returned: MIRROR_CAPTURE_LIMIT,
        limit: MIRROR_CAPTURE_LIMIT,
        previous: false,
      }),
    ).toBe(false);
    expect(
      headCompleteAfterCapture({
        returned: MIRROR_CAPTURE_LIMIT,
        limit: MIRROR_CAPTURE_LIMIT,
        previous: true,
      }),
    ).toBe(true);
  });
});

test('mirror retains bounded private attachment references and strips all other file URLs', () => {
  const url = 'kortix-attachment://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333';
  expect(sanitizeParts([{ type: 'file', url }])).toEqual([{ type: 'file', url }]);
  for (const value of ['https://example.test/secret', 'data:text/plain;base64,YQ==', `${url}?token=secret`]) {
    expect(sanitizeParts([{ type: 'file', url: value }])).toEqual([{ type: 'file' }]);
  }
});

describe('when a walk may stop at history it already holds', () => {
  const stored = (entries: Array<[string, number | null]>) => new Map(entries);
  const page = (ids: Array<[string, number | null]>) =>
    ids.map(([id, completed]) => ({
      info: { id, time: completed === null ? {} : { created: completed - 1, completed } },
    }));

  test('a mirror that never reached the head may not stop', () => {
    // Otherwise it catches up on the same page forever and the session's first
    // message is never captured.
    expect(
      capturedPageGate({
        fullHistory: true,
        headComplete: false,
        completedById: stored([['m1', 10]]),
      }),
    ).toBeUndefined();
  });

  test('a bounded tail read may not stop early either', () => {
    expect(
      capturedPageGate({ fullHistory: false, headComplete: true, completedById: stored([]) }),
    ).toBeUndefined();
  });

  test('a page whose every message is stored and completed stops the walk', () => {
    const gate = capturedPageGate({
      fullHistory: true,
      headComplete: true,
      completedById: stored([
        ['m1', 10],
        ['m2', 20],
      ]),
    })!;
    expect(gate(page([['m1', 10], ['m2', 20]]))).toBe(true);
  });

  test('one unseen message keeps the walk going', () => {
    const gate = capturedPageGate({
      fullHistory: true,
      headComplete: true,
      completedById: stored([['m1', 10]]),
    })!;
    expect(gate(page([['m1', 10], ['m_new', 20]]))).toBe(false);
  });

  test('a message whose completion time moved is not the one we stored', () => {
    const gate = capturedPageGate({
      fullHistory: true,
      headComplete: true,
      completedById: stored([['m1', 10]]),
    })!;
    expect(gate(page([['m1', 11]]))).toBe(false);
  });

  test('an uncompleted message is never evidence, stored or not', () => {
    // It can still grow. Stopping on it would freeze a turn mid-flight into
    // the mirror and never look at it again.
    const gate = capturedPageGate({
      fullHistory: true,
      headComplete: true,
      completedById: stored([['m1', null]]),
    })!;
    expect(gate(page([['m1', null]]))).toBe(false);
  });
});

describe('rows the old mirror stripped are captured again', () => {
  // Before saved history kept tool calls 1:1, the mirror dropped every tool
  // call's input, output and error. Those rows are complete by every other
  // test, so a walk would stop on them and they would stay stripped forever.
  const stripped = [
    { id: 'p1', type: 'text', text: 'Checking the build.' },
    { id: 'p2', type: 'tool', tool: 'bash', state: { status: 'completed', title: 'ls', time: { start: 1, end: 2 } } },
  ];
  const current = sanitizeParts([
    { id: 'p1', type: 'text', text: 'Checking the build.' },
    {
      id: 'p2',
      type: 'tool',
      tool: 'bash',
      state: { status: 'completed', title: 'ls', input: { command: 'ls' }, output: 'dist', time: { start: 1, end: 2 } },
    },
  ]);

  test('a settled tool call without its input is the old stripped format', () => {
    expect(mirrorPartsAreStripped(stripped)).toBe(true);
    expect(
      mirrorPartsAreStripped([
        { id: 'p', type: 'tool', tool: 'read', state: { status: 'error', time: { start: 1, end: 2 } } },
      ]),
    ).toBe(true);
  });

  test('a 1:1 row, a row without tool calls, and a call still running are not', () => {
    expect(mirrorPartsAreStripped(current)).toBe(false);
    expect(mirrorPartsAreStripped([{ id: 'p', type: 'text', text: 'hi' }])).toBe(false);
    // Only a SETTLED call always carries an input; a pending one may not yet.
    expect(
      mirrorPartsAreStripped([{ id: 'p', type: 'tool', tool: 'bash', state: { status: 'pending' } }]),
    ).toBe(false);
    expect(mirrorPartsAreStripped(null)).toBe(false);
  });

  test('the gate index leaves stripped rows out, so the walk reads past them', () => {
    const at = new Date(20);
    const index = capturedMessageIndex([
      { messageId: 'm_old', parts: stripped, messageCompletedAt: at },
      { messageId: 'm_new', parts: current, messageCompletedAt: at },
      { messageId: 'm_open', parts: current, messageCompletedAt: null },
    ]);
    expect([...index.entries()]).toEqual([
      ['m_new', 20],
      ['m_open', null],
    ]);
    const gate = capturedPageGate({ fullHistory: true, headComplete: true, completedById: index })!;
    const page = (id: string) => ({ info: { id, time: { created: 19, completed: 20 } } });
    expect(gate([page('m_new')])).toBe(true);
    expect(gate([page('m_old'), page('m_new')])).toBe(false);
  });
});

describe('a row the old mirror stripped is served with what it kept', () => {
  // The old mirror kept each tool call's status, title, time and metadata.
  // OpenCode (1.17.11 to 1.18.23, every version it ran against) writes each
  // call's defining input into that title or metadata, so the row still proves
  // it. Served as stored, the call drew an empty row until its computer woke.
  const stripped = (tool: string, state: Record<string, unknown>) => ({
    id: 'prt_1',
    type: 'tool',
    tool,
    callID: 'call_1',
    state: { status: 'completed', time: { start: 1, end: 2 }, ...state },
  });
  const served = (tool: string, state: Record<string, unknown>) =>
    (restoreStrippedToolParts([stripped(tool, state)])[0] as { state: Record<string, unknown> }).state;

  test('a command gets its command from the title and its output from the metadata', () => {
    const metadata = { output: 'bundle.min.js\n', exit: 0, truncated: false };
    expect(served('bash', { title: 'ls -la dist', metadata })).toEqual({
      status: 'completed',
      time: { start: 1, end: 2 },
      title: 'ls -la dist',
      metadata,
      input: { command: 'ls -la dist' },
      output: 'bundle.min.js\n',
    });
  });

  test('a file call gets the absolute path its metadata kept, else the relative path in its title', () => {
    expect(
      served('read', {
        title: 'src/app.ts',
        metadata: { preview: 'export {}', display: { type: 'file', path: '/workspace/src/app.ts', text: 'export {}' } },
      }).input,
    ).toEqual({ filePath: '/workspace/src/app.ts' });
    expect(served('read', { title: 'shot.png', metadata: { preview: 'Image read successfully' } }).input).toEqual({
      filePath: 'shot.png',
    });
    expect(
      served('edit', {
        title: 'src/app.ts',
        metadata: { diff: '@@', filediff: { file: '/workspace/src/app.ts', patch: '@@', additions: 1, deletions: 1 } },
      }).input,
    ).toEqual({ filePath: '/workspace/src/app.ts' });
    expect(served('write', { title: 'notes.md', metadata: { filepath: '/workspace/notes.md', exists: false } }).input).toEqual({
      filePath: '/workspace/notes.md',
    });
  });

  test('a search, a sub-agent, a fetch, a todo list and a skill get the input their title or metadata proves', () => {
    expect(served('grep', { title: 'TODO', metadata: { matches: 3 } }).input).toEqual({ pattern: 'TODO' });
    expect(served('glob', { title: 'src', metadata: { count: 12 } }).input).toEqual({ path: 'src' });
    expect(served('task', { title: 'Count the files', metadata: { sessionId: 'ses_child' } }).input).toEqual({
      description: 'Count the files',
    });
    expect(
      served('webfetch', { title: 'https://example.com/docs (text/html; charset=utf-8)', metadata: {} }).input,
    ).toEqual({ url: 'https://example.com/docs' });
    const todos = [{ content: 'Ship it', status: 'pending', priority: 'high' }];
    expect(served('todowrite', { title: '1 todos', metadata: { todos } }).input).toEqual({ todos });
    expect(served('skill', { title: 'Loaded skill: release-notes', metadata: {} }).input).toEqual({
      name: 'release-notes',
    });
  });

  test('only a completed call gets an output: a failed one carries an error, and this row lost it', () => {
    const state = served('bash', { status: 'error', title: 'false', metadata: { output: 'partial' } });
    expect(state.input).toEqual({ command: 'false' });
    expect('output' in state).toBe(false);
  });

  test('nothing is invented: a tool that proves no input, or a title in the wrong form, is served as stored', () => {
    const unknown = stripped('memory', { title: '', metadata: { truncated: false } });
    const notAUrl = stripped('webfetch', { title: 'Fetched the page', metadata: {} });
    const notASkill = stripped('skill', { title: 'release-notes', metadata: {} });
    const untitled = stripped('bash', { metadata: { output: 'x' } });
    expect(restoreStrippedToolParts([unknown, notAUrl, notASkill, untitled])).toEqual([
      unknown,
      notAUrl,
      notASkill,
      untitled,
    ]);
  });

  test('a 1:1 call, a call still running and a non-tool part are served untouched', () => {
    const current = sanitizeParts([
      {
        id: 'p1',
        type: 'tool',
        tool: 'bash',
        state: { status: 'completed', title: 'ls', input: { command: 'ls' }, output: 'dist', metadata: {}, time: { start: 1, end: 2 } },
      },
    ])[0];
    const running = { id: 'p2', type: 'tool', tool: 'bash', state: { status: 'running', title: 'ls', time: { start: 1 } } };
    const text = { id: 'p3', type: 'text', text: 'Checking the build.' };
    const parts = restoreStrippedToolParts([current, running, text]);
    expect(parts).toEqual([current, running, text]);
    expect(parts[0]).toBe(current);
  });
});
