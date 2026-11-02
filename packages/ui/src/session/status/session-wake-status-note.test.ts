import { expect, test } from 'bun:test';
import { sessionWakeStatusNote } from './session-starting-loader';

function note(error: string) {
  return sessionWakeStatusNote({
    reason: 'runtime_wake_cooldown',
    now: 0,
    failure: {
      category: 'sandbox-provider',
      message: 'Boot failed',
      retryable: true,
      evidence: { check: 'runtime_boot_error', error, observed_at: null, attempts: 1, next_retry_at: null },
    },
  });
}

test('boot errors drop trailing dots and whitespace without changing the message', () => {
  expect(note('agent. failed. \t\n')).toBe('Could not start the agent: agent. failed. Trying again automatically (attempt 2).');
  expect(note('. \t')).toBe('Still starting your computer. Trying again automatically (attempt 2).');
});

test('a long internal whitespace run does not stall wake status rendering', () => {
  const error = `failed${'\t'.repeat(100_000)}again...`;
  const start = performance.now();
  const result = note(error);
  const elapsed = performance.now() - start;
  expect(result).toBe(`Could not start the agent: failed${'\t'.repeat(100_000)}again. Trying again automatically (attempt 2).`);
  expect(elapsed).toBeLessThan(1_000);
});
