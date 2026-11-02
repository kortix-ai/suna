import { expect, test } from 'bun:test';
import { sessionWakeStatusNote } from './session-starting-loader';

test('boot-error punctuation and whitespace are trimmed without blocking on long input', () => {
  for (const [error, detail] of [
    ['Could not load model. \t.\n', 'Could not load model'],
    ['Could not load model', 'Could not load model'],
    ['. \t\n', ''],
    ['missing model' + '.\t\u00a0\n'.repeat(25_000), 'missing model'],
    [`\t`.repeat(100_000) + 'missing model.', `\t`.repeat(100_000) + 'missing model'],
  ]) {
    const started = performance.now();
    const note = sessionWakeStatusNote({
      reason: 'runtime_wake_cooldown',
      failure: {
        category: 'sandbox-provider',
        message: 'Could not start the agent.',
        retryable: true,
        evidence: { check: 'runtime_boot_error', error, observed_at: null, attempts: 1, next_retry_at: null },
      },
      now: 0,
    });
    expect(note).toBe(detail
      ? `Could not start the agent: ${detail}. Trying again automatically (attempt 2).`
      : 'Still starting your computer. Trying again automatically (attempt 2).');
    expect(performance.now() - started).toBeLessThan(1_000);
  }
});
