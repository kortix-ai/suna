import { describe, expect, test } from 'bun:test';

import { EXTENSION_ORIGIN } from '@/lib/supabase/panel-cookies';
import { startPanelHandshake } from './panel-handshake';

function setup(hasSession: boolean) {
  const calls: string[] = [];
  const posted: Array<{ message: unknown; origin: string }> = [];
  let listener: ((event: MessageEvent) => void) | undefined;
  const parent = { postMessage: (message: unknown, origin: string) => posted.push({ message, origin }) };
  let session = hasSession;
  const auth = {
    getSession: async () => (calls.push('getSession'), { data: { session: session ? {} : null } }),
    signOut: async (o: { scope: 'local' }) => {
      calls.push(`signOut:${o.scope}`);
      session = false;
    },
    verifyOtp: async () => (calls.push('verifyOtp'), { error: null }),
  };
  const win = {
    parent,
    addEventListener: (_: 'message', l: (event: MessageEvent) => void) => (listener = l),
    removeEventListener: () => (listener = undefined),
  };
  const results: boolean[] = [];
  return {
    calls,
    posted,
    auth,
    win,
    results,
    deliver: (hash: string) =>
      listener?.({ origin: EXTENSION_ORIGIN, source: parent, data: { type: 'kortix.panel.session', tokenHash: hash } } as unknown as MessageEvent),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

async function run(opts: { hasSession: boolean; switchAccount: boolean }) {
  const s = setup(opts.hasSession);
  const stop = startPanelHandshake({ auth: s.auth, win: s.win, switchAccount: opts.switchAccount, timeoutMs: 1000, finish: (ok) => s.results.push(ok) });
  await tick();
  return { ...s, stop };
}

describe('startPanelHandshake', () => {
  test('a frame with a session finishes without asking the extension', async () => {
    const s = await run({ hasSession: true, switchAccount: false });
    expect(s.results).toEqual([true]);
    expect(s.posted).toHaveLength(0);
    expect(s.calls).toEqual(['getSession']);
    s.stop();
  });

  test('without a session it asks the extension, then redeems the hash once', async () => {
    const s = await run({ hasSession: false, switchAccount: false });
    expect(s.posted).toEqual([{ message: { type: 'kortix.panel.needSession' }, origin: EXTENSION_ORIGIN }]);
    s.deliver('hash-1');
    s.deliver('hash-1');
    await tick();
    expect(s.calls.filter((c) => c === 'verifyOtp')).toHaveLength(1);
    expect(s.results).toEqual([true]);
    s.stop();
  });

  test('switch=1 signs out locally first, then asks even though a session existed', async () => {
    const s = await run({ hasSession: true, switchAccount: true });
    expect(s.calls).toEqual(['signOut:local', 'getSession']);
    expect(s.posted).toHaveLength(1);
    expect(s.results).toEqual([]);
    s.deliver('hash-2');
    await tick();
    expect(s.results).toEqual([true]);
    s.stop();
  });
});
