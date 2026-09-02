/**
 * P2.3 — prefer the multiplexed socket, but never require it.
 *
 * Gate G0 measured a multiplexed WebSocket at 16.0ms p50 against 19.2ms for
 * pooled keep-alive. The plan said "take the transport already measured best",
 * and the premise turned out to be wrong: that number came from the spike's
 * STUB environment, and the real daemon served only `POST /` and `POST /rpc` —
 * no `/rpc-ws` anywhere. Defaulting to `ws` would have broken every tool call.
 *
 * The daemon now serves it, but daemons are IMAGE-BAKED: a sandbox created
 * before that change has no `/rpc-ws` and never will. So the transport has to
 * negotiate rather than assume, and the negotiation has to be free when it
 * fails — an old box must lose one connect attempt, not one tool call.
 */
import { describe, expect, test } from 'bun:test';
import { NegotiatingTransport, type RpcTransport } from './rpc-transport.ts';

function stub(kind: string, behaviour: { fail?: boolean } = {}): RpcTransport & { calls: number } {
  return {
    kind,
    calls: 0,
    async call(op: string) {
      (this as unknown as { calls: number }).calls += 1;
      if (behaviour.fail) throw new Error('connect ECONNREFUSED');
      return { ok: true, value: `${kind}:${op}` };
    },
    async close() {},
  } as RpcTransport & { calls: number };
}

describe('transport negotiation', () => {
  test('uses the socket when it works', async () => {
    const ws = stub('ws');
    const fallback = stub('keepalive');
    const t = new NegotiatingTransport(ws, fallback);
    expect(await t.call('exec', {}, '/w')).toEqual({ ok: true, value: 'ws:exec' });
    expect(fallback.calls).toBe(0);
  });

  /**
   * The old-daemon case, and the one that decides whether this is safe to
   * default on. The tool call must still SUCCEED — a sandbox baked before the
   * endpoint existed cannot be allowed to fail because of a transport
   * preference.
   */
  test('falls back when the socket is not there, and the call still succeeds', async () => {
    const ws = stub('ws', { fail: true });
    const fallback = stub('keepalive');
    const t = new NegotiatingTransport(ws, fallback);
    expect(await t.call('exec', {}, '/w')).toEqual({ ok: true, value: 'keepalive:exec' });
  });

  test('having fallen back, it stops retrying the socket', async () => {
    const ws = stub('ws', { fail: true });
    const fallback = stub('keepalive');
    const t = new NegotiatingTransport(ws, fallback);
    await t.call('a', {}, '/w');
    await t.call('b', {}, '/w');
    await t.call('c', {}, '/w');
    // One failed attempt total — an old daemon pays the probe once per
    // session, not once per tool call.
    expect(ws.calls).toBe(1);
    expect(fallback.calls).toBe(3);
  });

  /**
   * Once the socket has actually served a call, a later failure is a REAL
   * failure — a dropped connection mid-session — and must surface so the
   * caller's own retry can reconnect. Silently switching to HTTP there would
   * hide a broken environment behind a slower one.
   */
  test('a failure AFTER the socket has proven itself is not masked', async () => {
    let failNow = false;
    const ws: RpcTransport = {
      kind: 'ws',
      async call(op: string) {
        if (failNow) throw new Error('rpc socket closed');
        return { ok: true, value: `ws:${op}` };
      },
      async close() {},
    };
    const fallback = stub('keepalive');
    const t = new NegotiatingTransport(ws, fallback);
    await t.call('first', {}, '/w');
    failNow = true;
    await expect(t.call('second', {}, '/w')).rejects.toThrow(/socket closed/);
    expect(fallback.calls).toBe(0);
  });

  test('close closes both, so neither leaks a socket', async () => {
    let closed = 0;
    const mk = (kind: string): RpcTransport => ({
      kind,
      async call() {
        return {};
      },
      async close() {
        closed += 1;
      },
    });
    await new NegotiatingTransport(mk('ws'), mk('keepalive')).close();
    expect(closed).toBe(2);
  });
});
