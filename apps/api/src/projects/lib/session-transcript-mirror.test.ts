import { describe, expect, test } from 'bun:test';

import {
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
