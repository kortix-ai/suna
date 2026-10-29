import { expect, test, spyOn } from 'bun:test';
import { canaryEvent, ship, table } from './prompt-latency-bench';

const session = {
  label: 'synthetic', at: '2026-10-29T00:00:00Z', sessionId: 'synthetic-session', externalId: null,
  provider: null, harness: null, createStatus: null, createMs: null, createTiming: {}, readyMs: null, turns: [],
};

test('missing observations are unknown, never successful', () => {
  expect(canaryEvent(session).canary_outcome).toBe('unknown');
  expect(canaryEvent(session).canary_ok).toBe(false);
});

test('terminal failures and deadlines remain distinct without free text inference', () => {
  expect(canaryEvent({ ...session, error: 'failed' }).canary_outcome).toBe('failed');
  const event = canaryEvent({ ...session, error: 'deadline', timedOut: true });
  expect(event.canary_outcome).toBe('timeout');
  expect(event.canary_timeout).toBe(true);
  expect(event).not.toHaveProperty('canary_error');
  expect(JSON.stringify(event)).not.toContain('synthetic-session');
});

test('boot success does not imply prompt success; missing token is unknown', () => {
  const ready = { ...session, readyMs: 10, provider: 'platinum', harness: 'pi' };
  expect(canaryEvent(ready).canary_boot_outcome).toBe('succeeded');
  expect(canaryEvent(ready).canary_outcome).toBe('unknown');
  const turn = { label: 'T1-chat', status: 202, postMs: 1, timing: {}, promptId: null,
    busyMs: 1, firstTokenMs: null, idleMs: 2, text: 'pong', model: 'synthetic-model' };
  expect(canaryEvent({ ...ready, turns: [turn] }).canary_outcome).toBe('unknown');
  const complete = canaryEvent({ ...ready, turns: [{ ...turn, firstTokenMs: 1 }] });
  expect(complete.canary_outcome).toBe('succeeded');
  expect(complete.canary_ok).toBe(true);
  expect(complete.canary_provider).toBe('platinum');
  expect(complete.canary_resume).toBe('unavailable');
  expect(complete.canary_region).toBe('unavailable');
});


test('telemetry failure cannot mutate results or call delivery/auth paths', async () => {
  const snapshot = JSON.stringify(session);
  const fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
  try {
    await ship([session]);
    expect(JSON.stringify(session)).toBe(snapshot);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[0][0])).toEndWith('/health');
    expect(fetchSpy.mock.calls[1][1]?.method).toBe('POST');
    const body = JSON.parse(String(fetchSpy.mock.calls[1][1]?.body));
    expect(body[0].canary_outcome).toBe('unknown');
    expect(JSON.stringify(body)).not.toContain('synthetic-session');
  } finally { fetchSpy.mockRestore(); }
});

test('benchmark report excludes missing observations from success', () => {
  expect(table([session])).toContain('sessions ok 0/1');
});
