import { describe, expect, test } from 'bun:test';
import { waitForRuntimeWakeRunning } from './runtime-wake-fence';

describe('waitForRuntimeWakeRunning', () => {
  test('keeps the wake fence after start acceptance until the provider reports running', async () => {
    const statuses = ['stopped', 'stopped', 'running'];
    let calls = 0;
    let sleeps = 0;

    const running = await waitForRuntimeWakeRunning(async () => statuses[calls++] ?? 'running', {
      graceMs: 3_000,
      pollMs: 1_000,
      sleep: async () => {
        sleeps += 1;
      },
    });

    expect(running).toBe(true);
    expect(calls).toBe(3);
    expect(sleeps).toBe(2);
  });

  test('returns false when the transition never reaches running', async () => {
    let calls = 0;
    const running = await waitForRuntimeWakeRunning(
      async () => {
        calls += 1;
        return 'stopped';
      },
      { graceMs: 3_000, pollMs: 1_000, sleep: async () => {} },
    );

    expect(running).toBe(false);
    expect(calls).toBe(3);
  });

  test('stops polling when the provider reports removed', async () => {
    let calls = 0;
    const running = await waitForRuntimeWakeRunning(
      async () => {
        calls += 1;
        return 'removed';
      },
      { graceMs: 90_000, pollMs: 1_000, sleep: async () => {} },
    );

    expect(running).toBe(false);
    expect(calls).toBe(1);
  });
});
