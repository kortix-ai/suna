import { describe, expect, test } from 'bun:test';
import { act } from 'react';

import type { SessionTask } from '@kortix/sdk';
import { testRender } from '@opentui/react/test-utils';

import { LEAD, NOW } from './agents-fixtures.ts';
import { taskRows } from './agents-model.ts';
import { TasksPanelView } from './tasks-panel.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function task(seq: number, overrides: Partial<SessionTask> = {}): SessionTask {
  return {
    seq,
    lead_session_id: LEAD,
    subject: `Task ${seq}`,
    description: '',
    status: 'pending',
    owner_handle: null,
    owner_session_id: null,
    blocked_by: [],
    blocked: false,
    created_by_session_id: null,
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    ...overrides,
  };
}

describe('TasksPanelView', () => {
  test('lists the tasks with status, owner and blockers; Enter peeks at the owner', async () => {
    const peeks: { sessionId: string; title?: string }[] = [];
    let closed = 0;
    const rows = taskRows([
      task(1, { subject: 'Write the tests', status: 'in_progress', owner_handle: 'tester', owner_session_id: 's-tester' }),
      task(2, { subject: 'Ship it', blocked: true, blocked_by: [1] }),
      task(3, { subject: 'Plan', status: 'completed' }),
    ]);
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <TasksPanelView
        rows={rows}
        loading={false}
        width={80}
        onPeek={(target) => peeks.push(target)}
        onClose={() => {
          closed += 1;
        }}
      />,
      { width: 90, height: 16 },
    );
    try {
      await flush();
      const frame = captureCharFrame();
      expect(frame).toContain('Tasks · 1 of 3 done');
      expect(frame).toContain('#1 Write the tests');
      expect(frame).toContain('@tester');
      expect(frame).toContain('blocked by #1');
      expect(frame).toContain('✓ #3 Plan');
      await act(async () => mockInput.pressEnter());
      expect(peeks).toEqual([{ sessionId: 's-tester', title: 'tester' }]);
      // A task with no owner has nobody to peek at.
      await act(async () => mockInput.pressKey('j'));
      await act(async () => mockInput.pressEnter());
      expect(peeks).toHaveLength(1);
      await act(async () => {
        mockInput.pressEscape();
        await new Promise((resolve) => setTimeout(resolve, 150));
      });
      expect(closed).toBe(1);
    } finally {
      renderer.destroy();
    }
  });

  test('no tasks: one line on what shows up here', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(
      <TasksPanelView rows={[]} loading={false} width={80} onPeek={() => {}} onClose={() => {}} />,
      { width: 90, height: 10 },
    );
    try {
      await flush();
      expect(captureCharFrame()).toContain('Tasks the team adds will show up here.');
    } finally {
      renderer.destroy();
    }
  });
});
