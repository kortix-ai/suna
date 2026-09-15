import { expect, test } from 'bun:test';
import { buildTurnResumeRelay, TurnResumeRejectedError } from './turn-resume-relay.ts';
import { turnEndPayload } from './turn-end-relay.ts';

const identity = { opencodeSessionId: 'ses_pi_fixture', messageId: 'msg_fixture', ownerId: crypto.randomUUID() };
const cfg = { apiUrl: 'https://example.test/v1', projectId: 'project', sessionId: 'session', kortixToken: 'fixture', waitMs: async () => {} };

test('recovery sends its durable owner and requires an explicit acknowledgment', async () => {
  const requests: Request[] = [];
  const relay = buildTurnResumeRelay({ ...cfg, fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(url, init));
    return Response.json({ ok: true, outcome: 'resumed' });
  }) as unknown as typeof fetch });
  await relay(identity);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.headers.get('authorization')).toBe('Bearer fixture');
  expect(await requests[0]!.json()).toEqual({ session_id: 'session', kind: 'turn_resume',
    opencode_session_id: identity.opencodeSessionId, turn_message_id: identity.messageId, turn_owner_id: identity.ownerId });
  expect(turnEndPayload({ sessionId: 'session', status: 'idle', identity }).turn_owner_id).toBe(identity.ownerId);
});

test('a lost acknowledgment retries the same owner and accepts the committed attempt', async () => {
  let calls = 0;
  const bodies: unknown[] = [];
  await buildTurnResumeRelay({ ...cfg, fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(init?.body);
    if (++calls === 1) throw new Error('response lost');
    return Response.json({ ok: true, outcome: 'already_active' });
  }) as unknown as typeof fetch })(identity);
  expect(calls).toBe(2);
  expect(new Set(bodies).size).toBe(1);
});

test.each([403, 200])('HTTP %i rejection stops recovery without retrying', async (status) => {
  let calls = 0;
  await expect(buildTurnResumeRelay({ ...cfg, fetch: (async () => {
    calls++;
    return Response.json({ ok: false, outcome: 'terminal' }, { status });
  }) as unknown as typeof fetch })(identity)).rejects.toBeInstanceOf(TurnResumeRejectedError);
  expect(calls).toBe(1);
});

test('transient server errors have a bounded four-attempt budget', async () => {
  let calls = 0;
  await expect(buildTurnResumeRelay({ ...cfg, fetch: (async () => {
    calls++;
    return new Response(null, { status: 503 });
  }) as unknown as typeof fetch })(identity)).rejects.toThrow('unavailable');
  expect(calls).toBe(4);
});

test('a direct benchmark without a control plane needs no handshake', async () => {
  let calls = 0;
  await buildTurnResumeRelay({ fetch: (async () => { calls++; throw Error('unexpected request'); }) as unknown as typeof fetch })(identity);
  expect(calls).toBe(0);
});
