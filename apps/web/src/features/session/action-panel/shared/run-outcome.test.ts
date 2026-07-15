import { describe, expect, test } from 'bun:test';
import type { MessageWithParts } from '@/ui';
import { deriveRunOutcome } from './run-outcome';

function assistant(error?: { name?: string; data?: { message?: unknown } }): MessageWithParts {
  return { info: { role: 'assistant', ...(error ? { error } : {}) }, parts: [] } as unknown as MessageWithParts;
}
const user = { info: { role: 'user' }, parts: [] } as unknown as MessageWithParts;

describe('deriveRunOutcome', () => {
  test('no messages → succeeded (nothing has failed)', () => {
    expect(deriveRunOutcome(undefined)).toBe('succeeded');
    expect(deriveRunOutcome([])).toBe('succeeded');
  });

  test('clean last assistant message → succeeded', () => {
    expect(deriveRunOutcome([user, assistant()])).toBe('succeeded');
  });

  test('run-level error on the last assistant message → failed', () => {
    expect(deriveRunOutcome([user, assistant({ name: 'ProviderError', data: { message: 'boom' } })])).toBe('failed');
  });

  test('abort error → stopped, by name or by message text', () => {
    expect(deriveRunOutcome([user, assistant({ name: 'MessageAbortedError' })])).toBe('stopped');
    expect(deriveRunOutcome([user, assistant({ name: 'UnknownError', data: { message: 'The operation was aborted' } })])).toBe('stopped');
  });

  test('an errored final step fails the run even without a run-level error', () => {
    expect(deriveRunOutcome([user, assistant()], 'error')).toBe('failed');
    expect(deriveRunOutcome([user, assistant()], 'done')).toBe('succeeded');
  });

  test('error on an EARLIER assistant message does not fail the latest run', () => {
    const failedEarlier = assistant({ name: 'ProviderError' });
    expect(deriveRunOutcome([user, failedEarlier, user, assistant()])).toBe('succeeded');
  });
});
