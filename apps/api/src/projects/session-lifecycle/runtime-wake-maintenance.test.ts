import { describe, expect, test } from 'bun:test';
import { reconcileRuntimeWakeCandidate } from './runtime-wake-maintenance';

describe('reconcileRuntimeWakeCandidate', () => {
  test('stops a provider VM that started after its wake claim failed', async () => {
    const events: string[] = [];
    const result = await reconcileRuntimeWakeCandidate({
      claim: async () => {
        events.push('claim');
        return true;
      },
      getStatus: async () => 'running',
      stop: async () => {
        events.push('stop');
      },
      markChecked: async () => {
        events.push('check');
      },
      markStopped: async () => {
        events.push('record-stop');
      },
    });

    expect(result).toBe('stopped');
    expect(events).toEqual(['claim', 'stop', 'record-stop']);
  });

  test('keeps checking a non-running ambiguous start without issuing stop', async () => {
    const events: string[] = [];
    const result = await reconcileRuntimeWakeCandidate({
      claim: async () => {
        events.push('claim');
        return true;
      },
      getStatus: async () => 'stopped',
      stop: async () => {
        events.push('stop');
      },
      markChecked: async (status) => {
        events.push(`check:${status}`);
      },
      markStopped: async () => {
        events.push('record-stop');
      },
    });

    expect(result).toBe('checked');
    expect(events).toEqual(['claim', 'check:stopped']);
  });

  test('does not inspect or stop the provider after losing the cleanup claim', async () => {
    const events: string[] = [];
    const result = await reconcileRuntimeWakeCandidate({
      claim: async () => false,
      getStatus: async () => {
        events.push('status');
        return 'running';
      },
      stop: async () => {
        events.push('stop');
      },
      markChecked: async () => {
        events.push('check');
      },
      markStopped: async () => {
        events.push('record-stop');
      },
    });

    expect(result).toBe('skipped');
    expect(events).toEqual([]);
  });
});
