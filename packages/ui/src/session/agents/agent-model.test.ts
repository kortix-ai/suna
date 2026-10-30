import { describe, expect, test } from 'bun:test';
import type { ProjectSession } from '@kortix/sdk';
import {
  agentRowOf,
  boardStateOf,
  foldIdle,
  moveSelection,
  RECENT_MS,
  stripCounts,
  stripGroups,
  stripKeyAction,
} from './agent-model';

// Synthetic values only: every id, name and text below is invented.

const NOW = Date.parse('2026-10-30T12:00:00.000Z');

function session(id: string, overrides: Partial<ProjectSession> = {}): ProjectSession {
  return {
    session_id: id,
    account_id: 'acc_1',
    project_id: 'proj_1',
    branch_name: 'b',
    base_ref: 'main',
    sandbox_provider: null,
    sandbox_id: null,
    sandbox_url: null,
    opencode_session_id: null,
    name: null,
    custom_name: null,
    agent_name: 'researcher',
    status: 'running',
    error: null,
    metadata: {},
    opencode_sessions: [],
    created_at: '2026-10-30T11:50:00.000Z',
    updated_at: '2026-10-30T11:59:00.000Z',
    ...overrides,
  } as ProjectSession;
}

describe('boardStateOf', () => {
  test('reads board_state when the API sends it', () => {
    expect(boardStateOf(session('s', { board_state: 'needs_input' }))).toBe('needs_input');
  });

  test('derives the state from an older row', () => {
    expect(boardStateOf(session('s', { working: { state: 'working', since: null, turn_token: null, pending_delivery: false } }))).toBe('working');
    expect(boardStateOf(session('s'))).toBe('idle');
    expect(boardStateOf(session('s', { status: 'failed' }))).toBe('failed');
    expect(boardStateOf(session('s', { status: 'completed' }))).toBe('completed');
    expect(boardStateOf(session('s', { status: 'stopped' }))).toBe('stopped');
    expect(boardStateOf(session('s', { status: 'provisioning' }))).toBe('working');
    expect(boardStateOf(session('s', { attention: 'approval' }))).toBe('needs_input');
  });
});

describe('agentRowOf', () => {
  test('names the row by its handle, else its name without the agent suffix, and keeps the agent apart', () => {
    expect(agentRowOf(session('s', { agent_handle: 'reviewer' }))).toMatchObject({ handle: 'reviewer', agent: 'researcher' });
    expect(agentRowOf(session('s', { name: 'Find the price changes (@researcher subagent)' }))).toMatchObject({
      handle: 'Find the price changes',
      agent: 'researcher',
    });
    expect(agentRowOf(session('abcdef123456', { agent_name: null })).handle).toBe('abcdef12');
  });

  test('the line is the result excerpt on one line', () => {
    expect(agentRowOf(session('s', { result_excerpt: 'Found 4\nprice changes' })).line).toBe('Found 4 price changes');
  });
});

describe('stripGroups', () => {
  test('teammates go under Team, other children under agents, each once', () => {
    const mate = session('mate', { team_lead_session_id: 'lead', agent_handle: 'writer' });
    const groups = stripGroups({
      leadSessionId: 'lead',
      children: [session('child', { agent_handle: 'helper' }), mate],
      teammates: [mate],
      exclude: new Set(),
      now: NOW,
    });
    expect(groups.agents.map((row) => row.handle)).toEqual(['helper']);
    expect(groups.team.map((row) => row.handle)).toEqual(['writer']);
  });

  test("a workflow run's sessions stay out of the agent rows", () => {
    const groups = stripGroups({
      leadSessionId: 'lead',
      children: [session('runner'), session('wf_agent'), session('child')],
      teammates: [],
      exclude: new Set(['runner', 'wf_agent']),
      now: NOW,
    });
    expect(groups.agents.map((row) => row.sessionId)).toEqual(['child']);
  });

  test('a finished child older than an hour leaves the strip; a working one stays', () => {
    const old = new Date(NOW - RECENT_MS - 60_000).toISOString();
    const groups = stripGroups({
      leadSessionId: 'lead',
      children: [
        session('done-old', { board_state: 'completed', updated_at: old }),
        session('working-old', { board_state: 'working', updated_at: old }),
        session('done-new', { board_state: 'completed' }),
      ],
      teammates: [],
      exclude: new Set(),
      now: NOW,
    });
    expect(groups.agents.map((row) => row.sessionId).sort()).toEqual(['done-new', 'working-old']);
  });

  test('rows that need the person come first, then working, failed, idle, done, stopped', () => {
    const groups = stripGroups({
      leadSessionId: 'lead',
      children: [
        session('a', { board_state: 'completed' }),
        session('b', { board_state: 'idle' }),
        session('c', { board_state: 'working' }),
        session('d', { board_state: 'needs_input' }),
        session('e', { board_state: 'failed' }),
      ],
      teammates: [],
      exclude: new Set(),
      now: NOW,
    });
    expect(groups.agents.map((row) => row.sessionId)).toEqual(['d', 'c', 'e', 'b', 'a']);
  });
});

describe('foldIdle', () => {
  const rows = ['w', 'i1', 'i2', 'i3', 'i4', 'i5'].map((id) =>
    agentRowOf(session(id, { board_state: id === 'w' ? 'working' : 'idle', agent_handle: id })),
  );

  test('more than three idle rows fold the rest into one row; a working row keeps its own', () => {
    const { shown, folded } = foldIdle(rows, false);
    expect(shown.map((row) => row.sessionId)).toEqual(['w', 'i1', 'i2', 'i3']);
    expect(folded.map((row) => row.sessionId)).toEqual(['i4', 'i5']);
  });

  test('expanded shows every row; three idle rows never fold', () => {
    expect(foldIdle(rows, true).folded).toEqual([]);
    expect(foldIdle(rows.slice(0, 4), false).folded).toEqual([]);
  });

  test('the selected row keeps its own row', () => {
    expect(foldIdle(rows, false, 'i5').shown.map((row) => row.sessionId)).toContain('i5');
  });
});

describe('counts and keys', () => {
  test('stripCounts counts agents, working and waiting rows', () => {
    const rows = [
      agentRowOf(session('a', { board_state: 'working' })),
      agentRowOf(session('b', { board_state: 'needs_input' })),
      agentRowOf(session('c', { board_state: 'idle' })),
    ];
    expect(stripCounts(rows)).toEqual({ agents: 3, working: 1, needsInput: 1 });
  });

  test("the strip's keys are Claude Code's agent panel keys", () => {
    expect(stripKeyAction({ key: 'ArrowUp' })).toBe('up');
    expect(stripKeyAction({ key: 'ArrowDown' })).toBe('down');
    expect(stripKeyAction({ key: 'Enter' })).toBe('open');
    expect(stripKeyAction({ key: 'x' })).toBe('stop');
    expect(stripKeyAction({ key: 'Escape' })).toBe('clear');
    expect(stripKeyAction({ key: 't', ctrlKey: true })).toBe('toggleTasks');
    expect(stripKeyAction({ key: 'x', metaKey: true })).toBeNull();
    expect(stripKeyAction({ key: 'a' })).toBeNull();
  });

  test('moveSelection steps and stops at either end', () => {
    expect(moveSelection(['a', 'b'], null, 'down')).toBe('a');
    expect(moveSelection(['a', 'b'], null, 'up')).toBe('b');
    expect(moveSelection(['a', 'b'], 'a', 'down')).toBe('b');
    expect(moveSelection(['a', 'b'], 'b', 'down')).toBe('b');
    expect(moveSelection([], null, 'down')).toBeNull();
  });
});
