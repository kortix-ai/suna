import { describe, expect, test } from 'bun:test';
import { InflightBudget } from './inflight-budget';
import { readAdmittedBody, releaseWhenResponseEnds } from './read-bounded-body';

describe('readAdmittedBody', () => {
  test('reserves declared memory before reading', async () => {
    let reads = 0;
    const request = new Request('https://gateway.test', {
      method: 'POST',
      headers: { 'content-length': '4' },
      body: new ReadableStream({
        pull(controller) {
          reads += 1;
          controller.enqueue(new TextEncoder().encode('test'));
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const budget = new InflightBudget({ maxBytes: 12, perRequestMaxBytes: 10, amplification: 3 });
    const result = await readAdmittedBody(request, 10, budget);
    expect(result).toMatchObject({ ok: true, body: 'test', bytes: 4 });
    expect(reads).toBe(1);
    expect(budget.inflightBytes).toBe(12);
    if (result.ok) result.release();
    expect(budget.inflightBytes).toBe(0);
  });

  test('rejects a declared oversized request without reading it', async () => {
    const request = new Request('https://gateway.test', {
      method: 'POST',
      headers: { 'content-length': '20' },
      body: new ReadableStream({ pull() {} }),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const result = await readAdmittedBody(
      request,
      10,
      new InflightBudget({ maxBytes: 100, perRequestMaxBytes: 10 }),
    );
    expect(result).toMatchObject({ ok: false, reason: 'too_large' });
  });

  test('rejects a concurrent request before allocating it', async () => {
    const budget = new InflightBudget({ maxBytes: 12, perRequestMaxBytes: 10, amplification: 3 });
    const first = await readAdmittedBody(
      new Request('https://gateway.test', {
        method: 'POST',
        body: 'test',
        headers: { 'content-length': '4' },
      }),
      10,
      budget,
    );
    const second = await readAdmittedBody(
      new Request('https://gateway.test', {
        method: 'POST',
        body: 'test',
        headers: { 'content-length': '4' },
      }),
      10,
      budget,
    );
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, reason: 'overloaded' });
    if (first.ok) first.release();
  });
});

test('releaseWhenResponseEnds holds memory through streamed EOF', async () => {
  let releases = 0;
  const response = releaseWhenResponseEnds(new Response('stream'), () => {
    releases += 1;
  });
  expect(releases).toBe(0);
  expect(await response.text()).toBe('stream');
  expect(releases).toBe(1);
});

describe('client aborts mid-upload', () => {
  /**
   * The leak that made the gateway "randomly" start refusing everything.
   *
   * Bun does not settle a pending `reader.read()` when the request is aborted,
   * so `readAdmittedBody` awaited forever while holding its reservation.
   * Measured against the real container on 2026-08-24: one aborted 2.8 MB
   * upload stranded 8,521,827 reserved bytes permanently. Enough aborted
   * uploads and every subsequent request 503s `gateway_overloaded` on a
   * process that is completely idle.
   */
  test('returns the reservation instead of hanging when the body stream never completes', async () => {
    const controller = new AbortController();
    const request = new Request('https://gateway.test', {
      method: 'POST',
      headers: { 'content-length': '1000' },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(100));
          // Never closes and never errors — exactly what an aborted upload
          // looks like to the handler.
        },
      }),
      signal: controller.signal,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    const budget = new InflightBudget({
      maxBytes: 1_000_000,
      perRequestMaxBytes: 100_000,
      amplification: 3,
    });
    const pending = readAdmittedBody(request, 100_000, budget);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(budget.inflightBytes).toBeGreaterThan(0); // reserved while uploading

    controller.abort();
    const result = await Promise.race([
      pending,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('readAdmittedBody hung after abort')), 2_000),
      ),
    ]);

    expect(result).toMatchObject({ ok: false, reason: 'client_aborted' });
    expect(budget.inflightBytes).toBe(0);
  });

  test('an already-aborted request never reserves anything', async () => {
    const budget = new InflightBudget({
      maxBytes: 1_000_000,
      perRequestMaxBytes: 100_000,
      amplification: 3,
    });
    const result = await readAdmittedBody(
      new Request('https://gateway.test', {
        method: 'POST',
        headers: { 'content-length': '10' },
        body: new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(10));
          },
        }),
        signal: AbortSignal.abort(),
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
      100_000,
      budget,
    );
    expect(result).toMatchObject({ ok: false, reason: 'client_aborted' });
    expect(budget.inflightBytes).toBe(0);
  });
});
