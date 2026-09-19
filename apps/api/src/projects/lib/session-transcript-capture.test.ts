import { describe, expect, test } from 'bun:test';

import { CAPTURE_RETRY_DELAYS_MS, readCaptureMessages } from './session-transcript-capture';

const payload = { opencodeSessionId: 'ses_pin', payload: { messages: [] } };

function harness(reads: Array<typeof payload | null>) {
  const slept: number[] = [];
  const warned: Array<{ message: string; context: Record<string, unknown> }> = [];
  let calls = 0;
  const deps = {
    readMessages: async () => {
      calls += 1;
      return reads[calls - 1] ?? null;
    },
    sleep: async (ms: number) => {
      slept.push(ms);
    },
    logger: {
      warn: (message: string, context: Record<string, unknown>) => {
        warned.push({ message, context });
      },
    },
  };
  return { deps, slept, warned, calls: () => calls };
}

describe('a capture read survives one bad moment', () => {
  test('a first-attempt read is returned without waiting', async () => {
    const h = harness([payload]);
    expect(await readCaptureMessages('sess-1', h.deps)).toEqual(payload);
    expect(h.calls()).toBe(1);
    expect(h.slept).toEqual([]);
    expect(h.warned).toEqual([]);
  });

  test('a read that fails twice is retried on the delay schedule and still lands', async () => {
    const h = harness([null, null, payload]);
    expect(await readCaptureMessages('sess-1', h.deps)).toEqual(payload);
    expect(h.calls()).toBe(3);
    expect(h.slept).toEqual([...CAPTURE_RETRY_DELAYS_MS]);
    expect(h.warned).toEqual([]);
  });

  test('a read that never lands is reported once, naming the session', async () => {
    const h = harness([null, null, null]);
    expect(await readCaptureMessages('sess-1', h.deps)).toBeNull();
    expect(h.calls()).toBe(CAPTURE_RETRY_DELAYS_MS.length + 1);
    expect(h.warned).toHaveLength(1);
    expect(h.warned[0].context).toMatchObject({
      sessionId: 'sess-1',
      attempts: CAPTURE_RETRY_DELAYS_MS.length + 1,
    });
  });

  test('a throwing read is retried like a failed one, never propagated', async () => {
    const slept: number[] = [];
    const warned: unknown[] = [];
    let calls = 0;
    const read = await readCaptureMessages('sess-1', {
      readMessages: async () => {
        calls += 1;
        if (calls === 1) throw new Error('socket hang up');
        return payload;
      },
      sleep: async (ms: number) => {
        slept.push(ms);
      },
      logger: { warn: (_m: string, c: Record<string, unknown>) => warned.push(c) },
    });
    expect(read).toEqual(payload);
    expect(calls).toBe(2);
    expect(slept).toEqual([CAPTURE_RETRY_DELAYS_MS[0]]);
  });
});
