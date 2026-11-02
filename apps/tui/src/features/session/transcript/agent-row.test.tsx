import { describe, expect, test } from 'bun:test';
import { act } from 'react';

import { type ToolView, toolViewModel } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { testRender } from '@opentui/react/test-utils';

import { type AgentNav, AgentNavProvider, type PeekTarget } from '../../agents/agent-nav.tsx';
import { AgentRow } from './agent-row.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SIZE = { width: 80, height: 6 };

function agentCall(overrides: Partial<ToolView> = {}): ToolView {
  return {
    name: 'agent',
    title: 'Agent',
    status: 'done',
    input: { description: 'Review the diff', name: 'reviewer' },
    metadata: { sessionId: 'kses_child', model: 'kimi-k3' },
    output: 'task_id: kses_child\n<task_result>\nAll 3 tests pass.\n</task_result>',
    outputText: 'task_id: kses_child\n<task_result>\nAll 3 tests pass.\n</task_result>',
    ...overrides,
  };
}

function render(tool: ToolView, peeked: PeekTarget[] = []) {
  const model = toolViewModel(tool);
  if (model.kind !== 'task') throw new Error(`expected a task model, got ${model.kind}`);
  const nav: AgentNav = {
    currentSessionId: 'kses_parent',
    peeking: null,
    peek: (target) => peeked.push(target),
    closePeek: () => {},
    switchTo: () => {},
  };
  return testRender(
    <QueryClientProvider client={new QueryClient()}>
      <AgentNavProvider value={nav}>
        <AgentRow tool={tool} model={model} width={SIZE.width} />
      </AgentNavProvider>
    </QueryClientProvider>,
    SIZE,
  );
}

describe('<AgentRow/>', () => {
  test('a finished agent: its name, task, model, and the first line of its report', async () => {
    const { captureCharFrame, flush, renderer } = await render(agentCall());
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('✓ reviewer · Review the diff');
    expect(frame).toContain('kimi-k3');
    expect(frame).toContain('⎿ All 3 tests pass.');
    renderer.destroy();
  });

  test('a failed agent says why, in red', async () => {
    const { captureCharFrame, flush, renderer } = await render(
      agentCall({ status: 'error', error: 'model refused', output: undefined, outputText: undefined }),
    );
    await flush();
    expect(captureCharFrame()).toContain('✗ reviewer');
    expect(captureCharFrame()).toContain('⎿ model refused');
    renderer.destroy();
  });

  test('a background teammate the call started is marked as one', async () => {
    const { captureCharFrame, flush, renderer } = await render(
      agentCall({
        metadata: { sessionId: 'kses_mate', background: true, teammate: true },
        output: 'task_id: kses_mate\n<task_started>running</task_started>',
        outputText: 'task_id: kses_mate\n<task_started>running</task_started>',
      }),
    );
    await flush();
    expect(captureCharFrame()).toContain('teammate');
    renderer.destroy();
  });

  test('a click opens the peek at the agent session', async () => {
    const peeked: PeekTarget[] = [];
    const { flush, mockMouse, renderer } = await render(agentCall(), peeked);
    await flush();
    await act(async () => mockMouse.click(4, 0));
    expect(peeked).toEqual([{ sessionId: 'kses_child', title: 'reviewer' }]);
    renderer.destroy();
  });
});
