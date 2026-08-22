import { describe, expect, test } from 'bun:test';

import { readBoundedBody } from './read-bounded-body';

const req = (body: string, headers: Record<string, string> = {}): Request =>
  new Request('https://gateway.test/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });

describe('readBoundedBody', () => {
  test('an ordinary body is returned verbatim', async () => {
    const result = await readBoundedBody(req('{"model":"x"}'), 1_000);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toBe('{"model":"x"}');
  });

  test('a limit of 0 disables the check entirely', async () => {
    const big = 'a'.repeat(50_000);
    const result = await readBoundedBody(req(big), 0);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body.length).toBe(50_000);
  });

  test('an oversized body is refused', async () => {
    const result = await readBoundedBody(req('a'.repeat(5_000)), 1_000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.bytes).toBeGreaterThan(1_000);
  });

  // The whole point: the old code called `c.req.text()` FIRST and checked the
  // size afterwards, so the allocation the limit exists to prevent had already
  // happened. A declared content-length must be refused before a single byte of
  // body is read.
  test('a declared content-length over the limit is refused from the HEADER, not by counting', async () => {
    // The stream carries only 50 bytes while the header declares 10,000. If the
    // refusal reports 10,000 it can only have come from the header — the body
    // was never counted, which is the whole point: the guard must act before
    // the allocation, not after it. (Asserting "the stream was never pulled"
    // does not work here: Bun pulls a Request's stream body on a background
    // tick regardless of who reads it.)
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(50)));
        controller.close();
      },
    });
    const request = new Request('https://gateway.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-length': '10000' },
      body: stream,
      // @ts-expect-error duplex is required for a stream body
      duplex: 'half',
    });
    const result = await readBoundedBody(request, 1_000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.bytes).toBe(10_000);
      expect(result.limit).toBe(1_000);
    }
  });

  // A lying or absent content-length must not defeat the limit — that is the
  // case an attacker (or a buggy client) actually sends.
  test('a body that exceeds the limit mid-stream is abandoned, not buffered to the end', async () => {
    let chunksPulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksPulled += 1;
        if (chunksPulled > 200) {
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode('y'.repeat(1_000)));
      },
    });
    const request = new Request('https://gateway.test/v1/chat/completions', {
      method: 'POST',
      // No content-length at all.
      body: stream,
      // @ts-expect-error duplex is required for a stream body
      duplex: 'half',
    });
    const result = await readBoundedBody(request, 5_000);
    expect(result.ok).toBe(false);
    // It stopped early instead of draining all 200 chunks into memory.
    expect(chunksPulled).toBeLessThan(20);
  });

  test('a body exactly at the limit is allowed', async () => {
    const exact = 'a'.repeat(1_000);
    const result = await readBoundedBody(req(exact), 1_000);
    expect(result.ok).toBe(true);
  });

  test('multi-byte characters are counted as BYTES, not characters', async () => {
    // 400 emoji = 1,600 UTF-8 bytes but only 800 UTF-16 code units.
    const emoji = '🎉'.repeat(400);
    expect(new TextEncoder().encode(emoji).byteLength).toBe(1_600);
    const result = await readBoundedBody(req(emoji), 1_200);
    expect(result.ok).toBe(false);
  });

  test('an empty body is fine', async () => {
    const request = new Request('https://gateway.test/v1/models', { method: 'POST' });
    const result = await readBoundedBody(request, 1_000);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toBe('');
  });
});
