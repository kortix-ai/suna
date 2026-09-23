import { describe, expect, test } from 'bun:test';

import {
  capturedPageGate,
  captureScope,
  MIRROR_CAPTURE_LIMIT,
  MIRROR_MAX_MESSAGE_CHARS,
  MIRROR_MAX_PART_CHARS,
  headCompleteAfterCapture,
  mirrorRowsFromOpencodePayload,
  sanitizeParts,
} from './session-transcript-mirror';

describe('sanitizeParts', () => {
  test('a file part keeps its name and type and LOSES its url', () => {
    // A base64 `data:` url here is the whole 7-19 MB transcript incident: the
    // mirror is read on every cold open, so one embedded screenshot would make
    // the wake slower than the wake it exists to hide.
    const [part] = sanitizeParts([
      {
        id: 'prt_1',
        type: 'file',
        filename: 'shot.png',
        mime: 'image/png',
        url: `data:image/png;base64,${'A'.repeat(5000)}`,
        source: { text: 'x' },
      },
    ]);
    expect(part).toEqual({ id: 'prt_1', type: 'file', filename: 'shot.png', mime: 'image/png' });
  });

  test("a tool part keeps status and title and LOSES the tool's input and output", () => {
    const [part] = sanitizeParts([
      {
        id: 'prt_2',
        type: 'tool',
        tool: 'bash',
        callID: 'call_1',
        state: {
          status: 'completed',
          title: 'ls',
          time: { start: 1, end: 2 },
          input: { command: 'cat huge.log' },
          output: 'A'.repeat(100_000),
        },
      },
    ]);
    expect(part).toEqual({
      id: 'prt_2',
      type: 'tool',
      tool: 'bash',
      callID: 'call_1',
      state: { status: 'completed', title: 'ls', time: { start: 1, end: 2 } },
    });
  });

  test('a show card keeps the input it is DRAWN from — and still loses its output', () => {
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
          output: 'A'.repeat(100_000),
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

  test('show content spends the same per-message budget as text', () => {
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

  test('a show with nothing drawable keeps no empty input object', () => {
    const [part] = sanitizeParts([
      { id: 'p', type: 'tool', tool: 'show', state: { status: 'completed', input: { items: 'not json' } } },
    ]);
    expect('input' in (part.state as object)).toBe(false);
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

describe('what one capture reads, and what it is allowed to prune', () => {
  test('a turn end on a flagged project reads the whole history', () => {
    expect(captureScope({ flagEnabled: true, everRetained: true })).toEqual({
      fullHistory: true,
      retainHistory: true,
    });
  });

  test('stop asks for a tail, however the project is flagged', () => {
    // Stop AWAITS this read before powering the box off, and a full-history
    // read is a 60s pagination with three retries. The full copy is already
    // maintained at every turn end; the only gap a stop can close is the turn
    // that just ended, which one bounded page covers.
    expect(captureScope({ flagEnabled: true, everRetained: true, requested: 'tail' })).toEqual({
      fullHistory: false,
      retainHistory: true,
    });
  });

  test('a forced tail must NOT re-enable pruning on a retained project', () => {
    // The trap: derive `retainHistory` from `fullHistory` and a single Stop
    // prunes a retained history down to MIRROR_MAX_MESSAGES — the feature
    // deletes the very thing it exists to keep.
    expect(
      captureScope({ flagEnabled: false, everRetained: true, requested: 'tail' }).retainHistory,
    ).toBe(true);
  });

  test('an unflagged project that never retained still prunes', () => {
    expect(captureScope({ flagEnabled: false, everRetained: false })).toEqual({
      fullHistory: false,
      retainHistory: false,
    });
  });
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
