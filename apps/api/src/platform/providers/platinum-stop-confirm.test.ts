import { beforeEach, expect, mock, test } from 'bun:test';

// Regression for the zombie-box incident: `stop()` used to return the instant
// Platinum ACKed the request, before the VM necessarily powered off. The
// control plane then marked the DB row stopped — which kills the sandbox's
// token (account-tokens.ts) — while the VM was still up and still calling
// turn-stream/audit/events with that now-dead token. `stop()` must now poll
// until Platinum confirms the VM is actually off, and throw (never silently
// return) when it never gets there within the bound.
mock.module('../../config', () => ({
  config: {
    PLATINUM_API_KEY: 'pt_test',
    PLATINUM_API_URL: 'https://platinum.example.test',
    KORTIX_URL: 'https://api.example.test',
    KORTIX_SANDBOX_AUTOSTOP_MINUTES: 15,
    PLATINUM_TEMPLATE: 'kortix-computer',
  },
  SANDBOX_VERSION: 'test-version',
}));

mock.module('../service-key', () => ({
  serviceKeyForExternalId: async () => null,
}));

mock.module('../sandbox-frontend-url', () => ({
  sandboxFrontendBaseUrl: () => 'https://app.example.test',
}));

let calls: Array<{ url: string; method: string }> = [];
let statesAfterAck: string[] = [];

beforeEach(() => {
  calls = [];
  statesAfterAck = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET');
    calls.push({ url, method });
    if (url.endsWith('/stop') && method === 'POST') {
      // Platinum ACKs the stop request immediately — this is the ACK the old
      // code trusted as "done".
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // Every GET after the ACK reads the NEXT state off the queue — the VM
    // taking its time to actually power off.
    const state = statesAfterAck.shift() ?? 'stopped';
    return new Response(JSON.stringify({ id: 'sbx_1', state }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
});

test('stop() confirms the VM reached stopped before returning', async () => {
  // The first read is the pre-stop auto-resume check; the rest are the poll.
  statesAfterAck = ['running', 'stopping', 'stopping', 'stopped'];
  const { PlatinumProvider } = await import('./platinum');
  const provider = new PlatinumProvider();

  await provider.stop('sbx_1');

  const ack = calls.findIndex((call) => call.url.endsWith('/stop'));
  const pollCalls = calls.slice(ack).filter((call) => call.method === 'GET' && call.url.endsWith('/sbx_1'));
  // Confirmed only after polling past every non-terminal state.
  expect(pollCalls.length).toBe(3);
});

test('stop() returns once Platinum reports the VM gone (404-equivalent), not just stopped', async () => {
  const { PlatinumProvider } = await import('./platinum');
  const provider = new PlatinumProvider();

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET');
    calls.push({ url, method });
    if (url.endsWith('/stop')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    // The sandbox vanished (archived/deleted) between the ACK and the poll.
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }) as typeof fetch;

  await expect(provider.stop('sbx_gone')).resolves.toBeUndefined();
});

test('stop() throws — never returns silently — when the VM never confirms stopped', async () => {
  // Shrunk bound so this test doesn't wait out a real 10s deadline; the
  // production default lives in platinum.ts's stopConfirmDeadlineMs().
  process.env.PLATINUM_STOP_CONFIRM_DEADLINE_MS = '300';
  process.env.PLATINUM_STOP_CONFIRM_POLL_MS = '50';
  // Every poll after the ACK reports the VM still on.
  statesAfterAck = Array(50).fill('running');
  const { PlatinumProvider } = await import('./platinum');
  const provider = new PlatinumProvider();

  try {
    await expect(provider.stop('sbx_wedged')).rejects.toThrow(/did not reach stopped/);
  } finally {
    delete process.env.PLATINUM_STOP_CONFIRM_DEADLINE_MS;
    delete process.env.PLATINUM_STOP_CONFIRM_POLL_MS;
  }
});

test('getStatus() does not report a VM stuck in stopping as stopped', async () => {
  statesAfterAck = ['stopping', 'stopped'];
  const { PlatinumProvider } = await import('./platinum');
  const provider = new PlatinumProvider();

  expect(await provider.getStatus('sbx_1')).toBe('unknown');
  expect(await provider.getStatus('sbx_1')).toBe('stopped');
});

// Boxes created before `auto_resume: false` shipped keep Platinum's default:
// a stray request wakes them behind our back. The stop that parks one turns
// it off — and only on a Platinum that reports the field, because an older
// build reads a PATCH naming no field it knows as "clear the name".
function stopWithSandbox(sandbox: Record<string, unknown>) {
  const patches: Array<Record<string, unknown>> = [];
  const current: Record<string, unknown> = { id: 'sbx_1', state: 'stopped', ...sandbox };
  globalThis.fetch = (async (input, init) => {
    const method = String(init?.method ?? 'GET');
    if (method === 'PATCH') {
      patches.push(JSON.parse(String(init?.body)));
      current.autoResume = false;
    }
    const body = String(input).endsWith('/stop') || method === 'PATCH' ? { ok: true } : current;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return patches;
}

test('stop() turns auto-resume off on a session box that still has it', async () => {
  const patches = stopWithSandbox({ autoResume: true, metadata: { 'kortix.workload': 'session' } });
  const { PlatinumProvider } = await import('./platinum');
  await new PlatinumProvider().stop('sbx_1');
  expect(patches).toEqual([{ auto_resume: false }]);
});

test('stop() leaves auto-resume alone on an app, an already-off box, and a Platinum without the field', async () => {
  const { PlatinumProvider } = await import('./platinum');
  for (const sandbox of [
    { autoResume: true, metadata: { 'kortix.workload': 'app' } },
    { autoResume: false, metadata: { 'kortix.workload': 'session' } },
    { metadata: { 'kortix.workload': 'session' } },
  ]) {
    const patches = stopWithSandbox(sandbox);
    await new PlatinumProvider().stop('sbx_1');
    expect(patches).toEqual([]);
  }
});

// Measured on a self-host 2026-09-30: Platinum resumed a box on a stray edge
// request 1.3 s after `stop.done`, before a post-stop PATCH could land. The box
// came back with its row stopped and its token dead. So the switch goes off
// BEFORE the stop, and nothing can wake the box in between.
test('stop() turns auto-resume off before it asks Platinum to stop', async () => {
  const order: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    const method = String(init?.method ?? 'GET');
    if (method !== 'GET') order.push(method === 'PATCH' ? 'patch' : 'stop');
    const body =
      method === 'GET'
        ? {
            id: 'sbx_1',
            state: order.includes('stop') ? 'stopped' : 'running',
            autoResume: !order.includes('patch'),
            metadata: { 'kortix.workload': 'session' },
          }
        : { ok: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const { PlatinumProvider } = await import('./platinum');
  await new PlatinumProvider().stop('sbx_1');
  expect(order).toEqual(['patch', 'stop']);
});
