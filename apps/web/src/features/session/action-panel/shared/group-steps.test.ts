import type { ToolPart } from '@/ui';
import { toolCallBlock, type SessionLogMessage } from '@kortix/sdk';
import { describe, expect, it } from 'bun:test';
import { collectAllToolCalls } from '@kortix/ui/session-panel';
import { groupSteps } from './group-steps';

// `groupSteps` and its unit tests live in `@kortix/sdk`
// (`packages/sdk/src/core/turns/segments/group-steps.test.ts`). This file keeps
// the one case that needs web's own Easy-mode collector.

function call(tool: string, status: 'running' | 'completed' | 'error' = 'completed', input: Record<string, unknown> = {}) {
  return toolCallBlock({
    type: 'tool',
    tool,
    callID: `c-${tool}-${Math.random()}`,
    state: { status, input },
  } as unknown as ToolPart);
}

describe('groupSteps with the Easy-mode collector', () => {
  it('end-to-end: Easy mode collects reads that Advanced hides, and narrates them as one step', () => {
    // This is the regression the plan defect would have reintroduced: if Easy
    // mode fed its Progress card from `collectToolCalls` (the Advanced/actions-
    // panel collector), `read` calls would be filtered out before `groupSteps`
    // ever saw them, and "Read 3 files" would never appear.
    const messages = [
      { role: 'assistant', kind: 'turn', in_context: true, blocks: [call('read'), call('read'), call('read')] } as SessionLogMessage,
    ];
    const steps = groupSteps(collectAllToolCalls(messages));
    expect(steps).toHaveLength(1);
    expect(steps[0].family).toBe('explore');
    expect(steps[0].label).toBe('Read 3 files');
  });
});
