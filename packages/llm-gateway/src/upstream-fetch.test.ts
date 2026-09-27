import { describe, expect, test } from 'bun:test';
import { upstreamFetch } from './upstream-fetch';

describe('upstreamFetch — Bun idle timeout is switched off on every provider call', () => {
  // Measured on Bun 1.3.14 (2026-08-25): the runtime's default fetch idle
  // timeout is 300 s, a caller `signal` does not disable it, `timeout: false`
  // does. A `max`-effort reasoning stretch on codex/gpt-5.6-sol died at
  // 273.8 s with "The operation timed out." because of it.
  test('upstreamFetch keeps every caller option and adds timeout:false', async () => {
    const signal = new AbortController().signal;
    const original = globalThis.fetch;
    const seen: unknown[] = [];
    (globalThis as { fetch: unknown }).fetch = async (_input: unknown, init?: unknown) => {
      seen.push(init);
      return new Response('ok');
    };
    try {
      await upstreamFetch('http://127.0.0.1:1/x', { method: 'GET', headers: { a: 'b' }, signal });
    } finally {
      globalThis.fetch = original;
    }
    expect(seen).toEqual([{ method: 'GET', headers: { a: 'b' }, signal, timeout: false }]);
  });

  test('Bun accepts timeout:false on a real request, with no init at all', async () => {
    // A runtime that rejected the option would throw here, and the whole
    // reason this module exists is a runtime-specific extension.
    const server = Bun.serve({ port: 0, fetch: () => new Response('pong') });
    try {
      const res = await upstreamFetch(`http://127.0.0.1:${server.port}/`);
      expect(await res.text()).toBe('pong');
    } finally {
      server.stop(true);
    }
  });
});
