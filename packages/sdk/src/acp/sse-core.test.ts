import { describe, expect, test } from 'bun:test';

import { createSseBlockParser, isAcpResponseEnvelope, isDeliverableSseBlock, type SseBlock } from './sse-core';

const encoder = new TextEncoder();

describe('createSseBlockParser', () => {
  test('parses a clean multi-block chunk in one push', () => {
    const parser = createSseBlockParser();
    const blocks = parser.push(
      encoder.encode(
        'id: 1\ndata: {"a":1}\n\n' +
        'id: 2\ndata: {"a":2}\n\n',
      ),
      false,
    );
    expect(blocks).toEqual([
      { id: 1, data: ['{"a":1}'] },
      { id: 2, data: ['{"a":2}'] },
    ]);
  });

  test('joins multiple data: lines within one block, in order, without joining them itself', () => {
    const parser = createSseBlockParser();
    const [block] = parser.push(
      encoder.encode('id: 1\ndata: line one\ndata: line two\n\n'),
      false,
    );
    expect(block).toEqual({ id: 1, data: ['line one', 'line two'] });
    expect(block.data.join('\n')).toBe('line one\nline two');
  });

  test('a comment-only / keepalive block (no id:, no data:) parses to { id: null, data: [] }', () => {
    const parser = createSseBlockParser();
    const blocks = parser.push(encoder.encode(': keepalive\n\n'), false);
    expect(blocks).toEqual([{ id: null, data: [] }]);
  });

  test('normalizes CRLF to LF within a single push', () => {
    const parser = createSseBlockParser();
    const blocks = parser.push(encoder.encode('id: 1\r\ndata: {"a":1}\r\n\r\n'), false);
    expect(blocks).toEqual([{ id: 1, data: ['{"a":1}'] }]);
  });

  test('holds back a chunk-final lone CR and completes it on the next push (split exactly between the terminator\'s two CRLF pairs)', () => {
    const parser = createSseBlockParser();
    // '...\r' | '\n\r\n...' — the split lands between the first CRLF and the
    // second CR of the four-character '\r\n\r\n' terminator.
    const first = parser.push(encoder.encode('id: 1\r\ndata: {"a":1}\r'), false);
    expect(first).toEqual([]);
    const second = parser.push(encoder.encode('\n\r\nid: 2\r\ndata: {"a":2}\r\n\r\n'), false);
    expect(second).toEqual([
      { id: 1, data: ['{"a":1}'] },
      { id: 2, data: ['{"a":2}'] },
    ]);
  });

  test('a terminator split across 3 pushes, mid-terminator on both boundaries', () => {
    const parser = createSseBlockParser();
    const a = parser.push(encoder.encode('id: 1\r\ndata: {"a":1}\r'), false); // holds first CR
    const b = parser.push(encoder.encode('\n\r'), false); // completes CRLF #1, opens CR of CRLF #2
    const c = parser.push(encoder.encode('\nid: 2\r\ndata: {"a":2}\r\n\r\n'), false); // completes CRLF #2 + a whole 2nd block
    expect(a).toEqual([]);
    expect(b).toEqual([]);
    expect(c).toEqual([
      { id: 1, data: ['{"a":1}'] },
      { id: 2, data: ['{"a":2}'] },
    ]);
  });

  test('the terminal done push synthesizes a trailing blank line for an unterminated final block', () => {
    const parser = createSseBlockParser();
    const mid = parser.push(encoder.encode('id: 1\ndata: {"a":1}\n'), false);
    expect(mid).toEqual([]);
    const final = parser.push(undefined, true);
    expect(final).toEqual([{ id: 1, data: ['{"a":1}'] }]);
  });

  test('a done push with only whitespace/empty buffer produces no synthetic block', () => {
    const parser = createSseBlockParser();
    parser.push(encoder.encode('id: 1\ndata: {"a":1}\n\n'), false);
    const final = parser.push(undefined, true);
    expect(final).toEqual([]);
  });

  test('a multi-byte UTF-8 codepoint split across a chunk boundary decodes correctly', () => {
    const parser = createSseBlockParser();
    const payload = encoder.encode('id: 1\ndata: {"a":"café 😀"}\n\n');
    // Split inside the 2-byte 'é' (U+00E9) encoding.
    const splitIndex = payload.indexOf(0xc3) + 1;
    const first = parser.push(payload.slice(0, splitIndex), false);
    expect(first).toEqual([]);
    const second = parser.push(payload.slice(splitIndex), false);
    expect(second).toEqual([{ id: 1, data: ['{"a":"café 😀"}'] }]);
  });

  test('the last id: line in a block wins if a block somehow carries more than one', () => {
    const parser = createSseBlockParser();
    const [block] = parser.push(encoder.encode('id: 1\nid: 2\ndata: {"a":1}\n\n'), false);
    expect(block.id).toBe(2);
  });

  test('poison payload (invalid JSON) still parses as a normal block — JSON validity is not this layer\'s concern', () => {
    const parser = createSseBlockParser();
    const blocks = parser.push(encoder.encode('id: 1\ndata: {not valid json\n\n'), false);
    expect(blocks).toEqual([{ id: 1, data: ['{not valid json'] }]);
  });

  test('the same parser instance is stateful across many pushes (buffer persists)', () => {
    const parser = createSseBlockParser();
    expect(parser.push(encoder.encode('id: 1\nda'), false)).toEqual([]);
    expect(parser.push(encoder.encode('ta: {"a":1}\n'), false)).toEqual([]);
    expect(parser.push(encoder.encode('\nid: 2\ndata: {"a":2}\n\n'), false)).toEqual([
      { id: 1, data: ['{"a":1}'] },
      { id: 2, data: ['{"a":2}'] },
    ]);
  });
});

describe('isDeliverableSseBlock', () => {
  test('true for a safe-integer id with at least one data: line', () => {
    expect(isDeliverableSseBlock({ id: 1, data: ['{}'] })).toBe(true);
    expect(isDeliverableSseBlock({ id: 0, data: ['{}'] })).toBe(true);
  });

  test('false for a null id (keepalive/comment block)', () => {
    expect(isDeliverableSseBlock({ id: null, data: [] })).toBe(false);
    expect(isDeliverableSseBlock({ id: null, data: ['{}'] })).toBe(false);
  });

  test('false for an id with no data: lines', () => {
    expect(isDeliverableSseBlock({ id: 1, data: [] })).toBe(false);
  });

  test('false for a non-safe-integer id (NaN from a malformed id: line, or a huge number)', () => {
    const block: SseBlock = { id: Number('not-a-number'), data: ['{}'] };
    expect(isDeliverableSseBlock(block)).toBe(false);
    expect(isDeliverableSseBlock({ id: Number.MAX_SAFE_INTEGER + 1, data: ['{}'] })).toBe(false);
  });

  test('true even when data is unparseable JSON — JSON validity is a separate concern from deliverability', () => {
    expect(isDeliverableSseBlock({ id: 1, data: ['{not valid json'] })).toBe(true);
  });
});

describe('isAcpResponseEnvelope', () => {
  test('true for a result response', () => {
    expect(isAcpResponseEnvelope({ jsonrpc: '2.0', id: 1, result: { ok: true } })).toBe(true);
  });

  test('true for an error response', () => {
    expect(isAcpResponseEnvelope({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'nope' } })).toBe(true);
  });

  test('false for a request (has method + id)', () => {
    expect(isAcpResponseEnvelope({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: {} })).toBe(false);
  });

  test('false for a notification (has method, no id)', () => {
    expect(isAcpResponseEnvelope({ jsonrpc: '2.0', method: 'session/cancel', params: {} })).toBe(false);
  });

  test('false for an envelope with neither result, error, nor method (malformed)', () => {
    expect(isAcpResponseEnvelope({ jsonrpc: '2.0', id: 1 } as never)).toBe(false);
  });
});
