import { describe, expect, test } from 'bun:test';
import type { MessageWithParts, ToolPart } from '@/ui';
import { collectAllToolParts } from './collect-tool-parts';
import { groupSteps } from './group-steps';
import { latestRunMessages } from './latest-run';
import { deriveRunOutcome } from './run-outcome';

function assistant(
  error?: { name?: string; data?: { message?: unknown } },
  parts: ToolPart[] = [],
): MessageWithParts {
  return {
    info: { role: 'assistant', ...(error ? { error } : {}) },
    parts,
  } as unknown as MessageWithParts;
}
const user = { info: { role: 'user' }, parts: [] } as unknown as MessageWithParts;

function toolPart(tool: string, status: 'running' | 'completed' | 'error'): ToolPart {
  return {
    type: 'tool',
    tool,
    callID: `c-${tool}-${Math.random()}`,
    state: { status, input: {} },
  } as unknown as ToolPart;
}

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

  // ─── Integration seam (CRITICAL 3): a text-only turn after an old errored
  // write must not inherit the earlier run's failure. Callers must scope
  // `lastStepStatus` to the LATEST run's steps, not the session's — this test
  // composes the same helpers `easy-panel.tsx` and `use-deliverable-readiness.ts`
  // share (`latestRunMessages` → `collectAllToolParts` → `groupSteps`) to prove
  // the scoped read differs from the session-wide read. ──
  test('a text-only turn after an earlier errored write reads as succeeded when scoped to the latest run', () => {
    const erroredWrite = toolPart('write', 'error');
    const messages: MessageWithParts[] = [
      user,
      assistant(undefined, [erroredWrite]),
      user,
      assistant(undefined, []),
    ];

    const sessionWideSteps = groupSteps(collectAllToolParts(messages));
    expect(sessionWideSteps[sessionWideSteps.length - 1]?.status).toBe('error');

    const latestSteps = groupSteps(collectAllToolParts(latestRunMessages(messages)));
    expect(deriveRunOutcome(messages, latestSteps[latestSteps.length - 1]?.status)).toBe('succeeded');
  });
});
