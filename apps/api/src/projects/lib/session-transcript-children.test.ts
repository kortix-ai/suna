import { describe, expect, test } from 'bun:test';
import { getChildSessionId } from '@kortix/sdk';

import {
  childSessionIdOf,
  childSessionReferences,
  childSessionsToCapture,
} from './session-transcript-mirror';

/**
 * A sub-agent runs in its own OpenCode session, and its row in the parent
 * opens that session's transcript. Saved history must hold those transcripts
 * too, or the row opens onto nothing while the computer is off. The capture
 * finds them by the SAME rule the renderer opens them by.
 */

const call = (tool: string, state: Record<string, unknown>) => ({ type: 'tool', tool, state });

describe('the capture finds a sub-agent session exactly as the SDK does', () => {
  const cases: Array<[string, ReturnType<typeof call>]> = [
    ['task, metadata', call('task', { status: 'completed', metadata: { sessionId: 'ses_meta1' } })],
    ['agent_spawn, metadata', call('agent_spawn', { status: 'running', metadata: { sessionId: 'ses_meta2' } })],
    ['agent-task, title', call('agent-task', { status: 'completed', title: 'Delegated to ses_title1' })],
    ['task_start, output', call('task_start', { status: 'completed', output: 'started ses_output1 ok' })],
    ['session_spawn, output', call('session_spawn', { status: 'completed', output: '- **Session:** ses_spawn1' })],
    ['session-start-background, output', call('session-start-background', { status: 'completed', output: 'Session: ses_spawn2' })],
    ['task, error-only child', call('task', { status: 'error', error: 'Subagent failed (task_id: ses_failed1)' })],
    ['task, metadata wins over error', call('task', { status: 'error', metadata: { sessionId: 'ses_meta1' }, error: 'Subagent failed (task_id: ses_failed1)' })],
    ['task, error excludes legacy title', call('task', { status: 'error', error: 'Request failed', title: 'Delegated to ses_title1' })],
    ['task, unrelated error mention', call('task', { status: 'error', error: 'Parent ses_parent failed' })],
    ['bash, task-id error', call('bash', { status: 'error', error: 'task_id: ses_notachild' })],
    ['task, nothing', call('task', { status: 'completed', metadata: {} })],
    ['bash naming a session', call('bash', { status: 'completed', output: 'ses_notachild', title: 'ses_notachild' })],
    ['session_spawn without the label', call('session_spawn', { status: 'completed', output: 'ses_unlabelled' })],
  ];
  for (const [label, part] of cases) {
    test(label, () => {
      expect(childSessionIdOf(part)).toBe(getChildSessionId(part as never));
    });
  }
});

describe('which sub-agent transcripts a capture reads', () => {
  const rows = [
    { parts: [call('task', { status: 'completed', metadata: { sessionId: 'ses_done' } })] },
    { parts: [call('task', { status: 'running', metadata: { sessionId: 'ses_live' } })] },
    { parts: [call('task', { status: 'completed', metadata: { sessionId: 'ses_new' } }), { type: 'text', text: 'x' }] },
  ];

  test('references carry whether the dispatching call has settled', () => {
    expect(childSessionReferences(rows)).toEqual([
      { id: 'ses_done', settled: true },
      { id: 'ses_live', settled: false },
      { id: 'ses_new', settled: true },
    ]);
  });

  test('a call referenced twice is settled only when every reference is', () => {
    const twice = [
      { parts: [call('task', { status: 'completed', metadata: { sessionId: 'ses_a' } })] },
      { parts: [call('agent_task_update', { status: 'running', metadata: { sessionId: 'ses_a' } })] },
    ];
    expect(childSessionReferences(twice)).toEqual([{ id: 'ses_a', settled: false }]);
  });

  test('reads a new sub-agent, a running one, and one whose saved copy has an open message; skips a finished one', () => {
    const stored = new Map([
      ['ses_done', { settled: true }],
      ['ses_live', { settled: true }],
    ]);
    expect(
      childSessionsToCapture({ references: childSessionReferences(rows), stored, limit: 10 }),
    ).toEqual(['ses_live', 'ses_new']);
    const open = new Map([['ses_done', { settled: false }]]);
    expect(
      childSessionsToCapture({
        references: [{ id: 'ses_done', settled: true }],
        stored: open,
        limit: 10,
      }),
    ).toEqual(['ses_done']);
  });

  test('never more than the limit in one capture', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ id: `ses_${index}`, settled: true }));
    expect(childSessionsToCapture({ references: many, stored: new Map(), limit: 8 })).toHaveLength(8);
  });
});
