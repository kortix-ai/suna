import { expect, mock, test } from 'bun:test';
import { runDeviceGrant } from './device-grant';
import type { ChatGptChallenge } from './types';

for (const outcome of ['success', 'failed', 'expired', 'timeout', 'cancelled', 'retry', 'start-error'] as const) {
  test(`device grant: ${outcome}`, async () => {
    let clock = 0;
    let cancelled = false;
    let polls = 0;
    const delays: number[] = [];
    const challenge = mock((_value: ChatGptChallenge | null) => {});
    const phase = mock((_value: string) => {});
    const error = mock((_value: string) => {});
    const success = mock(() => {});
    await runDeviceGrant({
      startOAuth: async () => {
        if (outcome === 'start-error') throw new Error('Unavailable');
        return { flow_id: 'flow', verification_url: 'https://example.test', user_code: 'CODE', interval_ms: 1, expires_at: 6000 };
      },
      pollOAuth: async (flowId) => {
        expect(flowId).toBe('flow');
        polls++;
        if (outcome === 'retry' && polls === 1) throw new Error('Transient');
        if (outcome === 'failed') return { status: 'failed', error: 'Denied' };
        if (outcome === 'expired') return { status: 'expired' };
        if (outcome === 'timeout') return { status: 'pending' };
        return { status: 'success', credential: { provider_id: 'codex', expires_in_ms: null, updated_at: '2026-10-20T00:00:00Z' } };
      },
      sleep: async (ms) => {
        delays.push(ms);
        clock += ms;
        if (outcome === 'cancelled') cancelled = true;
      },
      now: () => clock,
      isCancelled: () => cancelled,
      setChallenge: challenge,
      setPhase: phase,
      setError: error,
      onSuccess: success,
      failedMessage: 'Fallback',
    });
    const succeeded = outcome === 'success' || outcome === 'retry';
    expect(success.mock.calls.length).toBe(succeeded ? 1 : 0);
    expect(polls).toBe(outcome === 'cancelled' || outcome === 'start-error' ? 0 : outcome === 'timeout' ? 3 : outcome === 'retry' ? 2 : 1);
    expect(delays).toEqual(Array(outcome === 'start-error' ? 0 : outcome === 'timeout' ? 3 : outcome === 'retry' ? 2 : 1).fill(2000));
    expect(error.mock.calls).toEqual(outcome === 'failed' ? [['Denied']] : outcome === 'expired' || outcome === 'timeout' ? [['Authorization timed out. Try again.']] : outcome === 'start-error' ? [['Unavailable']] : []);
    expect(phase.mock.calls).toEqual(succeeded || outcome === 'cancelled' ? [] : [['idle']]);
    expect(challenge.mock.calls).toEqual(outcome === 'start-error' ? [[null]] : succeeded || outcome === 'cancelled' ? [[{ url: 'https://example.test', code: 'CODE' }]] : [[{ url: 'https://example.test', code: 'CODE' }], [null]]);
  });
}
