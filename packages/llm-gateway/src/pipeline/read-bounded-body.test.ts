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
    const result = await readAdmittedBody(request, 10, new InflightBudget({ maxBytes: 100, perRequestMaxBytes: 10 }));
    expect(result).toMatchObject({ ok: false, reason: 'too_large' });
  });

  test('rejects a concurrent request before allocating it', async () => {
    const budget = new InflightBudget({ maxBytes: 12, perRequestMaxBytes: 10, amplification: 3 });
    const first = await readAdmittedBody(new Request('https://gateway.test', {
      method: 'POST', body: 'test', headers: { 'content-length': '4' },
    }), 10, budget);
    const second = await readAdmittedBody(new Request('https://gateway.test', {
      method: 'POST', body: 'test', headers: { 'content-length': '4' },
    }), 10, budget);
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, reason: 'overloaded' });
    if (first.ok) first.release();
  });
});

test('releaseWhenResponseEnds holds memory through streamed EOF', async () => {
  let releases = 0;
  const response = releaseWhenResponseEnds(new Response('stream'), () => { releases += 1; });
  expect(releases).toBe(0);
  expect(await response.text()).toBe('stream');
  expect(releases).toBe(1);
});
