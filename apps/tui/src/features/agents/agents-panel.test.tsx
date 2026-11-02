import { describe, expect, test } from 'bun:test';
import { act } from 'react';

import type { PeerMessage } from '@kortix/sdk';
import { testRender } from '@opentui/react/test-utils';

import { LEAD, NOW, child, run } from './agents-fixtures.ts';
import { agentGroups, runRowOf } from './agents-model.ts';
import { AgentsPanelView, type AgentsPanelViewProps } from './agents-panel.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SIZE = { width: 90, height: 30 };

const HELD: PeerMessage = {
  id: 'm1',
  project_id: 'p',
  from_session_id: 'c-reviewer',
  from_handle: 'reviewer',
  to_session_id: LEAD,
  to_handle: 'lead',
  type: 'message',
  message: 'Can I push to main?',
  summary: 'Asks to push to main',
  status: 'held',
  notify_when_idle: false,
  created_at: new Date(NOW).toISOString(),
  decided_at: null,
};

interface Calls {
  peek: { sessionId: string; title?: string }[];
  open: string[];
  stop: { sessionId: string; title: string }[];
  control: { runId: string; action: string; session_id?: string }[];
  approve: string[];
  deny: string[];
  close: number;
}

function setup(overrides: Partial<AgentsPanelViewProps> = {}) {
  const calls: Calls = { peek: [], open: [], stop: [], control: [], approve: [], deny: [], close: 0 };
  const groups = agentGroups({
    leadSessionId: LEAD,
    children: [
      child('c-reviewer', { agent_handle: 'reviewer', board_state: 'needs_input', attention: 'question' }),
      child('c-coder', { agent_handle: 'coder', result_excerpt: 'Editing auth.ts' }),
      child('c-poet', { agent_handle: 'poet', board_state: 'completed' }),
    ],
    teammates: [],
    exclude: new Set(),
  });
  const props: AgentsPanelViewProps = {
    groups,
    runs: [runRowOf(run())!],
    held: [HELD],
    only: 'all',
    loading: false,
    notice: null,
    width: 80,
    now: NOW,
    maxRows: 20,
    onPeek: (target) => calls.peek.push(target),
    onOpen: (sessionId) => calls.open.push(sessionId),
    onStop: (target) => calls.stop.push(target),
    onControl: (target, body) => calls.control.push({ runId: target.runId, ...body }),
    onApprove: (id) => calls.approve.push(id),
    onDeny: (id) => calls.deny.push(id),
    onClose: () => {
      calls.close += 1;
    },
    ...overrides,
  };
  return { props, calls };
}

async function press(mockInput: { pressKey: (key: string) => void }, key: string, times = 1) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      mockInput.pressKey(key);
    });
  }
}

const DOWN = '\x1b[B';

describe('AgentsPanelView', () => {
  test('draws the groups with counts, the run progress and the held message', async () => {
    const { props } = setup();
    const { captureCharFrame, flush, renderer } = await testRender(<AgentsPanelView {...props} />, SIZE);
    try {
      await flush();
      const frame = captureCharFrame();
      expect(frame).toContain('Agents · 3');
      expect(frame).toContain('Needs you · 1');
      expect(frame).toContain('Working · 1');
      expect(frame).toContain('Done · 1');
      expect(frame).toContain('Has a question');
      expect(frame).toContain('coder · Editing auth.ts');
      expect(frame).toContain('Workflows · 1');
      expect(frame).toContain('Audit the repo');
      expect(frame).toContain('3 of 8 done · 1 running');
      expect(frame).toContain('Held messages · 1');
      expect(frame).toContain('reviewer: Asks to push to main');
      expect(frame).toContain('Enter peek');
    } finally {
      renderer.destroy();
    }
  });

  test('Enter peeks at the selected agent, o opens it, x stops it', async () => {
    const { props, calls } = setup();
    const { flush, mockInput, renderer } = await testRender(<AgentsPanelView {...props} />, SIZE);
    try {
      await flush();
      // First row: the agent that needs you.
      await act(async () => mockInput.pressEnter());
      expect(calls.peek).toEqual([{ sessionId: 'c-reviewer', title: 'reviewer' }]);
      await press(mockInput, 'j');
      await press(mockInput, 'o');
      expect(calls.open).toEqual(['c-coder']);
      await press(mockInput, 'x');
      expect(calls.stop).toEqual([{ sessionId: 'c-coder', title: 'coder' }]);
    } finally {
      renderer.destroy();
    }
  });

  test('x on a settled agent does nothing', async () => {
    const { props, calls } = setup();
    const { flush, mockInput, renderer } = await testRender(<AgentsPanelView {...props} />, SIZE);
    try {
      await flush();
      await press(mockInput, DOWN, 2);
      await press(mockInput, 'x');
      expect(calls.stop).toEqual([]);
    } finally {
      renderer.destroy();
    }
  });

  test('on a run: p pauses, x stops; Enter expands its agents and r restarts a failed one', async () => {
    const { props, calls } = setup();
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <AgentsPanelView {...props} />,
      SIZE,
    );
    try {
      await flush();
      await press(mockInput, DOWN, 3);
      await press(mockInput, 'p');
      await press(mockInput, 'x');
      expect(calls.control).toEqual([
        { runId: 'run-1', action: 'pause' },
        { runId: 'run-1', action: 'stop' },
      ]);
      await act(async () => mockInput.pressEnter());
      await flush();
      expect(captureCharFrame()).toContain('scan ui');
      // a1 a2 a3 a4 a5: the fifth agent (scan ui) failed.
      await press(mockInput, DOWN, 5);
      await press(mockInput, 'r');
      expect(calls.control.at(-1)).toEqual({ runId: 'run-1', action: 'restart_agent', session_id: 'wf-a5' });
      await act(async () => mockInput.pressEnter());
      expect(calls.peek.at(-1)).toEqual({ sessionId: 'wf-a5', title: 'scan ui' });
    } finally {
      renderer.destroy();
    }
  });

  test('a paused run resumes on p', async () => {
    const { props, calls } = setup({ runs: [runRowOf(run({ paused: true }))!], held: [] });
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <AgentsPanelView {...props} />,
      SIZE,
    );
    try {
      await flush();
      expect(captureCharFrame()).toContain('Paused');
      await press(mockInput, DOWN, 3);
      await press(mockInput, 'p');
      expect(calls.control).toEqual([{ runId: 'run-1', action: 'resume' }]);
    } finally {
      renderer.destroy();
    }
  });

  test('a and d decide a held message; Esc closes', async () => {
    const { props, calls } = setup();
    const { flush, mockInput, renderer } = await testRender(<AgentsPanelView {...props} />, SIZE);
    try {
      await flush();
      await press(mockInput, DOWN, 4);
      await press(mockInput, 'a');
      await press(mockInput, 'd');
      expect(calls.approve).toEqual(['m1']);
      expect(calls.deny).toEqual(['m1']);
      await act(async () => {
        mockInput.pressEscape();
        await new Promise((resolve) => setTimeout(resolve, 150));
      });
      expect(calls.close).toBe(1);
    } finally {
      renderer.destroy();
    }
  });

  test('only workflows: the runs and nothing else', async () => {
    const { props } = setup({ only: 'workflows' });
    const { captureCharFrame, flush, renderer } = await testRender(<AgentsPanelView {...props} />, SIZE);
    try {
      await flush();
      const frame = captureCharFrame();
      expect(frame).toContain('Workflows · 1');
      expect(frame).not.toContain('Needs you');
      expect(frame).not.toContain('Held messages');
    } finally {
      renderer.destroy();
    }
  });

  test('the notice line shows the result of the last action', async () => {
    const { props } = setup({ notice: { text: 'Could not stop coder. Try again.', tone: 'error' } });
    const { captureCharFrame, flush, renderer } = await testRender(<AgentsPanelView {...props} />, SIZE);
    try {
      await flush();
      expect(captureCharFrame()).toContain('Could not stop coder. Try again.');
    } finally {
      renderer.destroy();
    }
  });
  test('the default nine rows scroll to keep the selection in view', async () => {
    const { props } = setup({ maxRows: undefined });
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <AgentsPanelView {...props} />,
      SIZE,
    );
    try {
      await flush();
      expect(captureCharFrame()).not.toContain('Asks to push to main');
      await press(mockInput, DOWN, 4);
      await flush();
      const frame = captureCharFrame();
      expect(frame).toContain('reviewer: Asks to push to main');
      expect(frame).toContain('a approve · d deny');
    } finally {
      renderer.destroy();
    }
  });
});
