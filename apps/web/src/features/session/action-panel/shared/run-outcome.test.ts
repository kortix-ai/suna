import type { ToolPart } from '@/ui';
import { toolCallBlock, type SessionLogMessage, type ToolCallBlock } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import { collectAllToolCalls, latestRunMessages, deriveRunOutcome } from '@kortix/ui/session-panel';
import { groupSteps } from './group-steps';

function assistant(
  outcome?: { status: SessionLogMessage['status']; code?: string; message?: string },
  blocks: ToolCallBlock[] = [],
): SessionLogMessage {
  return {
    role: 'assistant',
    kind: 'turn',
    status: outcome?.status ?? 'complete',
    in_context: true,
    error: outcome?.code ? { code: outcome.code, message: outcome.message ?? '' } : null,
    blocks,
  } as SessionLogMessage;
}
const user = { role: 'user', kind: 'turn', status: 'complete', in_context: true, blocks: [] } as unknown as SessionLogMessage;
const compaction = (status: SessionLogMessage['status']) =>
  ({ role: 'user', kind: 'compaction', status, in_context: status === 'complete', blocks: [] }) as unknown as SessionLogMessage;

function call(tool: string, status: 'running' | 'completed' | 'error'): ToolCallBlock {
  return toolCallBlock({
    type: 'tool',
    tool,
    callID: `c-${tool}-${Math.random()}`,
    state: { status, input: {} },
  } as unknown as ToolPart);
}

describe('deriveRunOutcome', () => {
  test('no messages → succeeded (nothing has failed)', () => {
    expect(deriveRunOutcome(undefined)).toBe('succeeded');
    expect(deriveRunOutcome([])).toBe('succeeded');
  });

  test('clean last reply → succeeded', () => {
    expect(deriveRunOutcome([user, assistant()])).toBe('succeeded');
  });

  test('an errored last reply → failed', () => {
    expect(deriveRunOutcome([user, assistant({ status: 'error', code: 'ProviderError', message: 'boom' })])).toBe('failed');
  });

  test('a stopped reply → stopped: by the aborted status, or by an error whose text says so', () => {
    expect(deriveRunOutcome([user, assistant({ status: 'aborted', code: 'MessageAbortedError' })])).toBe('stopped');
    expect(
      deriveRunOutcome([user, assistant({ status: 'error', code: 'UnknownError', message: 'The operation was aborted' })]),
    ).toBe('stopped');
  });

  test('a compaction carries its summary reply\'s verdict', () => {
    expect(deriveRunOutcome([user, assistant({ status: 'error', code: 'X' }), compaction('complete')])).toBe('succeeded');
    expect(deriveRunOutcome([user, assistant(), compaction('aborted')])).toBe('stopped');
  });

  test('an errored final step fails the run even without a run-level error', () => {
    expect(deriveRunOutcome([user, assistant()], 'error')).toBe('failed');
    expect(deriveRunOutcome([user, assistant()], 'done')).toBe('succeeded');
  });

  test('error on an EARLIER reply does not fail the latest run', () => {
    const failedEarlier = assistant({ status: 'error', code: 'ProviderError' });
    expect(deriveRunOutcome([user, failedEarlier, user, assistant()])).toBe('succeeded');
  });

  // ─── Integration seam (CRITICAL 3): a text-only turn after an old errored
  // write must not inherit the earlier run's failure. Callers must scope
  // `lastStepStatus` to the LATEST run's steps, not the session's — this test
  // composes the same helpers `session-panel-provider.tsx` and
  // `use-deliverable-readiness.ts` share (`latestRunMessages` →
  // `collectAllToolCalls` → `groupSteps`) to prove the scoped read differs
  // from the session-wide read. ──
  test('a text-only turn after an earlier errored write reads as succeeded when scoped to the latest run', () => {
    const messages: SessionLogMessage[] = [user, assistant(undefined, [call('write', 'error')]), user, assistant(undefined, [])];

    const sessionWideSteps = groupSteps(collectAllToolCalls(messages));
    expect(sessionWideSteps[sessionWideSteps.length - 1]?.status).toBe('error');

    const latestSteps = groupSteps(collectAllToolCalls(latestRunMessages(messages)));
    expect(deriveRunOutcome(messages, latestSteps[latestSteps.length - 1]?.status)).toBe('succeeded');
  });
});
