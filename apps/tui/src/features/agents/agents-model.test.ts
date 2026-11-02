import { describe, expect, test } from 'bun:test';

import type { PeerMessage, ProjectSession, SessionTask, WorkflowRunMetadata } from '@kortix/sdk';

import {
  agentGroups,
  agentsSummary,
  heldMessages,
  panelRows,
  recentOnly,
  runProgress,
  runRowOf,
  runSessionIds,
  taskRows,
} from './agents-model.ts';

import { LEAD, MIN, NOW, child, run } from './agents-fixtures.ts';

describe('agentGroups', () => {
  test('groups children and teammates into Needs you, Working and Done, newest first', () => {
    const groups = agentGroups({
      leadSessionId: LEAD,
      children: [
        child('c-old-done', { board_state: 'completed', last_activity_at: new Date(NOW - 30 * MIN).toISOString() }),
        child('c-working', { agent_handle: 'reviewer' }),
        child('c-question', { board_state: 'needs_input', attention: 'question' }),
        child('c-new-done', { board_state: 'idle', last_activity_at: new Date(NOW - 2 * MIN).toISOString() }),
        child('c-failed', { board_state: 'failed', last_activity_at: new Date(NOW - 5 * MIN).toISOString() }),
      ],
      teammates: [child('t-1', { agent_handle: 'tester', team_lead_session_id: LEAD })],
      exclude: new Set(),
    });
    expect(groups.needs_you.map((row) => row.sessionId)).toEqual(['c-question']);
    expect(groups.working.map((row) => row.sessionId).sort()).toEqual(['c-working', 't-1']);
    expect(groups.done.map((row) => row.sessionId)).toEqual(['c-new-done', 'c-failed', 'c-old-done']);
    expect(groups.working.find((row) => row.sessionId === 't-1')?.teammate).toBe(true);
    expect(groups.working.find((row) => row.sessionId === 'c-working')?.handle).toBe('reviewer');
  });

  test('leaves out the sessions a workflow run owns, the lead itself and duplicates', () => {
    const groups = agentGroups({
      leadSessionId: LEAD,
      children: [child('wf-a1'), child(LEAD), child('c-1'), child('c-1')],
      teammates: [],
      exclude: runSessionIds([runRowOf(run())!]),
    });
    expect([...groups.needs_you, ...groups.working, ...groups.done].map((row) => row.sessionId)).toEqual(['c-1']);
  });

  test('derives a state from the older fields when board_state is absent', () => {
    const groups = agentGroups({
      leadSessionId: LEAD,
      children: [
        child('c-stopped', { board_state: undefined, status: 'stopped' }),
        child('c-asks', { board_state: undefined, attention: 'approval' }),
      ],
      teammates: [],
      exclude: new Set(),
    });
    expect(groups.needs_you.map((row) => row.sessionId)).toEqual(['c-asks']);
    expect(groups.done[0]?.state).toBe('stopped');
  });

  test('names a row by handle, then session name without the old agent suffix, then the agent', () => {
    const groups = agentGroups({
      leadSessionId: LEAD,
      children: [
        child('c-name', { name: 'Fix the login bug (@coder subagent)', agent_handle: null }),
        child('c-agent', { agent_name: 'reviewer', agent_handle: null, name: null }),
      ],
      teammates: [],
      exclude: new Set(),
    });
    const handles = groups.working.map((row) => row.handle).sort();
    expect(handles).toEqual(['Fix the login bug', 'reviewer']);
  });
});

describe('runs', () => {
  test('runProgress counts done and running agents of the run', () => {
    const row = runRowOf(run());
    expect(row).not.toBeNull();
    expect(runProgress(row!)).toBe('3 of 8 done · 1 running · 1 failed');
  });

  test('a background run is controlled and read on its runner session', () => {
    const row = runRowOf(run({ background: { sessionId: 'runner-1' } }));
    expect(row?.runnerSessionId).toBe('runner-1');
    expect(runSessionIds([row!]).has('runner-1')).toBe(true);
  });

  test('a run with no id or no agents list is dropped, not thrown on', () => {
    expect(runRowOf({ title: 'x' } as unknown as WorkflowRunMetadata)).toBeNull();
    expect(runRowOf(run({ agents: undefined as never }))?.counts.total).toBe(0);
  });
});

describe('heldMessages', () => {
  test('keeps only the held messages this session received', () => {
    const base = {
      project_id: 'p',
      from_session_id: 'c-1',
      from_handle: 'reviewer',
      to_session_id: LEAD,
      to_handle: 'lead',
      type: 'message',
      message: 'Can I push?',
      summary: null,
      notify_when_idle: false,
      created_at: new Date(NOW).toISOString(),
      decided_at: null,
    } as const;
    const messages: PeerMessage[] = [
      { ...base, id: 'm1', status: 'held' },
      { ...base, id: 'm2', status: 'delivered' },
      { ...base, id: 'm3', status: 'held', to_session_id: 'other' },
    ];
    expect(heldMessages(messages, LEAD).map((message) => message.id)).toEqual(['m1']);
    expect(heldMessages(undefined, LEAD)).toEqual([]);
  });
});

describe('agentsSummary', () => {
  const groups = (children: ProjectSession[]) =>
    agentGroups({ leadSessionId: LEAD, children, teammates: [], exclude: new Set() });

  test('counts agents and working ones', () => {
    const summary = agentsSummary(groups([child('a'), child('b', { board_state: 'completed' })]), [], 0);
    expect(summary).toEqual({ text: '2 agents · 1 working', mark: 'working' });
  });

  test('a waiting agent reads as needs you', () => {
    const summary = agentsSummary(groups([child('a', { board_state: 'needs_input' })]), [], 0);
    expect(summary).toEqual({ text: '1 agent · needs you', mark: 'needs_input' });
  });

  test('settled agents name the newest one', () => {
    const summary = agentsSummary(
      groups([child('a', { agent_handle: 'poet', board_state: 'completed' })]),
      [],
      0,
    );
    expect(summary).toEqual({ text: '1 agent · poet done', mark: 'done' });
  });

  test('a running workflow and a held message are named', () => {
    const rows = [runRowOf(run())!];
    expect(agentsSummary(groups([]), rows, 0)).toEqual({ text: '1 workflow running', mark: 'working' });
    expect(agentsSummary(groups([]), [], 1)).toEqual({ text: '1 message held', mark: 'needs_input' });
  });

  test('nothing started: null', () => {
    expect(agentsSummary(groups([]), [], 0)).toEqual({ text: null, mark: 'done' });
  });

  test('recentOnly drops settled agents and ended runs older than an hour', () => {
    const all = groups([
      child('old', { board_state: 'completed', last_activity_at: new Date(NOW - 2 * 60 * MIN).toISOString() }),
      child('new', { board_state: 'completed' }),
      child('old-working', { last_activity_at: new Date(NOW - 2 * 60 * MIN).toISOString() }),
    ]);
    const runs = [
      runRowOf(run({ runId: 'old', status: 'done', endedAt: NOW - 2 * 60 * MIN }))!,
      runRowOf(run({ runId: 'live' }))!,
    ];
    const recent = recentOnly(all, runs, NOW);
    expect(recent.groups.done.map((row) => row.sessionId)).toEqual(['new']);
    expect(recent.groups.working.map((row) => row.sessionId)).toEqual(['old-working']);
    expect(recent.runs.map((row) => row.runId)).toEqual(['live']);
  });
});

describe('panelRows', () => {
  test('sections in order with counts; a collapsed run hides its agents', () => {
    const groups = agentGroups({
      leadSessionId: LEAD,
      children: [child('w'), child('q', { board_state: 'needs_input' }), child('d', { board_state: 'completed' })],
      teammates: [],
      exclude: new Set(),
    });
    const runs = [runRowOf(run())!];
    const rows = panelRows({ groups, runs, held: [], expanded: new Set(), only: 'all' });
    expect(rows.filter((row) => row.kind === 'header').map((row) => row.kind === 'header' && row.title)).toEqual([
      'Needs you · 1',
      'Working · 1',
      'Done · 1',
      'Workflows · 1',
    ]);
    expect(rows.some((row) => row.kind === 'run-agent')).toBe(false);
    const open = panelRows({ groups, runs, held: [], expanded: new Set(['run-1']), only: 'all' });
    expect(open.filter((row) => row.kind === 'run-agent')).toHaveLength(8);
  });

  test('only workflows: no agent sections; nothing at all: one empty line', () => {
    const groups = agentGroups({ leadSessionId: LEAD, children: [child('w')], teammates: [], exclude: new Set() });
    const rows = panelRows({ groups, runs: [], held: [], expanded: new Set(), only: 'workflows' });
    expect(rows).toEqual([{ kind: 'empty', id: 'empty', text: 'Workflow runs this session starts will show up here.' }]);
    const none = agentGroups({ leadSessionId: LEAD, children: [], teammates: [], exclude: new Set() });
    expect(panelRows({ groups: none, runs: [], held: [], expanded: new Set(), only: 'all' })).toEqual([
      { kind: 'empty', id: 'empty', text: 'Agents and workflow runs this session starts will show up here.' },
    ]);
  });
});

describe('taskRows', () => {
  const task = (seq: number, overrides: Partial<SessionTask> = {}): SessionTask => ({
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
  });

  test('in progress first, then pending, then done; each in task order', () => {
    const rows = taskRows([
      task(1, { status: 'completed' }),
      task(2),
      task(3, { status: 'in_progress', owner_handle: 'tester' }),
      task(4, { blocked: true, blocked_by: [3] }),
    ]);
    expect(rows.map((row) => row.seq)).toEqual([3, 2, 4, 1]);
    expect(rows[0]).toMatchObject({ glyph: '●', owner: '@tester' });
    expect(rows[2]).toMatchObject({ glyph: '○', note: 'blocked by #3' });
    expect(rows[3]).toMatchObject({ glyph: '✓' });
  });
});
