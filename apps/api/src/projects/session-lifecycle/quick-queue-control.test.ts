import { expect, test } from 'bun:test';
import { sendQuickQueueControl } from './quick-queue-control';

test('arms a Quick Queue interrupt through the signed sandbox endpoint', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const outcome = await sendQuickQueueControl(
    { url: 'https://sandbox.test/p/box/8000', headers: { 'x-kortix-user-context': 'signed' } },
    { kind: 'arm', promptId: 'prompt-1', opencodeSessionId: 'ses_1', messageId: 'msg_1' },
    async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json({ armed: true }, { status: 202 });
    },
  );

  expect(outcome).toEqual({ ok: true, reason: null });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe('https://sandbox.test/p/box/8000/kortix/abort/after-tool');
  expect(calls[0]?.init.method).toBe('POST');
  expect(new Headers(calls[0]?.init.headers).get('x-kortix-user-context')).toBe('signed');
  expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
    // W3 name, plus the pre-W3 name for an older daemon.
    prompt_id: 'prompt-1', runtime_session_id: 'ses_1', opencode_session_id: 'ses_1', turn_message_id: 'msg_1',
  });
});

test('disarms a removed prompt', async () => {
  const calls: RequestInit[] = [];
  const outcome = await sendQuickQueueControl(
    { url: 'https://sandbox.test', headers: {} },
    { kind: 'disarm', promptId: 'prompt-1' },
    async (_url, init) => {
      calls.push(init ?? {});
      return Response.json({ armed: false });
    },
  );
  expect(outcome.ok).toBe(true);
  expect(calls[0]?.method).toBe('DELETE');
  expect(JSON.parse(String(calls[0]?.body))).toEqual({ prompt_id: 'prompt-1' });
});

test('does not accept the old daemon HTML fallback as an armed interrupt', async () => {
  const outcome = await sendQuickQueueControl(
    { url: 'https://sandbox.test', headers: {} },
    { kind: 'arm', promptId: 'prompt-1', opencodeSessionId: 'ses_1', messageId: 'msg_1' },
    async () => new Response('<html>OpenCode</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  );
  expect(outcome.ok).toBe(false);
  expect(outcome.reason).toContain('content-type text/html');
});

test('names the failing status, the daemon answer, and a thrown transport as the reason', async () => {
  const endpoint = { url: 'https://sandbox.test', headers: {} } as const;
  const arm = { kind: 'arm', promptId: 'prompt-1', opencodeSessionId: 'ses_1', messageId: 'msg_1' } as const;
  const refused = await sendQuickQueueControl(endpoint, arm, async () => new Response(null, { status: 502 }));
  expect(refused).toEqual({ ok: false, reason: 'status 502' });
  const mismatched = await sendQuickQueueControl(endpoint, arm, async () => Response.json({ armed: false }));
  expect(mismatched).toEqual({ ok: false, reason: 'daemon answered armed=false' });
  const thrown = await sendQuickQueueControl(endpoint, arm, async () => {
    throw new Error('connect ECONNREFUSED');
  });
  expect(thrown).toEqual({ ok: false, reason: 'connect ECONNREFUSED' });
});

test('disarms any pending boundary interrupt when Stop holds the queue', async () => {
  let body: unknown;
  const outcome = await sendQuickQueueControl(
    { url: 'https://sandbox.test', headers: {} },
    { kind: 'disarm-all' },
    async (_url, init) => {
      body = JSON.parse(String(init.body));
      return Response.json({ armed: false });
    },
  );
  expect(outcome.ok).toBe(true);
  expect(body).toEqual({ all: true });
});
