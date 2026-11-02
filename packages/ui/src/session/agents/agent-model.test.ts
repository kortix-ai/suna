import { describe, expect, test } from 'bun:test';
import type { ProjectSession } from '@kortix/sdk';
import { agentRowOf, boardStateOf, lineSummary, RECENT_MS, shortElapsed, stripCounts, stripGroups } from './agent-model';

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
    expect(agentRowOf(session('s', { agent_handle: 'reviewer' }))).toMatchObject({ handle: 'reviewer', agent: 'researcher', named: true });
    expect(agentRowOf(session('s', { name: 'Find the price changes (@researcher subagent)' }))).toMatchObject({
      handle: 'Find the price changes',
      agent: 'researcher',
      named: true,
    });
    expect(agentRowOf(session('abcdef123456', { agent_name: null })).handle).toBe('abcdef12');
  });

  test('a row with no name of its own shows the agent display name, never the raw slug', () => {
    expect(agentRowOf(session('s', { agent_name: 'mykortix' }))).toMatchObject({ handle: 'My Kortix', agent: 'mykortix', named: false });
    expect(agentRowOf(session('s', { agent_name: 'kortix' }))).toMatchObject({ handle: 'Kortix', named: false });
    expect(agentRowOf(session('s', { agent_name: 'code-reviewer' })).handle).toBe('Code reviewer');
  });

  test('the line is the result excerpt on one line', () => {
    expect(agentRowOf(session('s', { result_excerpt: 'Found 4\nprice changes' })).line).toBe('Found 4 price changes');
  });

  test('a working row knows since when it works; any other row does not', () => {
    const working = { state: 'working' as const, since: '2026-10-30T11:58:00.000Z', turn_token: null, pending_delivery: false };
    expect(agentRowOf(session('s', { board_state: 'working', working })).workingSinceMs).toBe(Date.parse('2026-10-30T11:58:00.000Z'));
    expect(agentRowOf(session('s', { board_state: 'idle', working })).workingSinceMs).toBeNull();
    expect(agentRowOf(session('s', { board_state: 'working' })).workingSinceMs).toBeNull();
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

describe('counts and the line', () => {
  test('stripCounts counts agents, working and waiting rows', () => {
    const rows = [
      agentRowOf(session('a', { board_state: 'working' })),
      agentRowOf(session('b', { board_state: 'needs_input' })),
      agentRowOf(session('c', { board_state: 'idle' })),
    ];
    expect(stripCounts(rows)).toEqual({ agents: 3, working: 1, needsInput: 1 });
  });

  test('lineSummary: needs you wins, then working (agents or a running run), then the newest agent', () => {
    const at = (id: string, state: string, minute: number) =>
      agentRowOf(session(id, { board_state: state as never, agent_handle: id, last_activity_at: `2026-10-30T11:${minute}:00.000Z` }));
    expect(lineSummary([at('a', 'working', 10), at('b', 'needs_input', 11)], []).mark).toBe('needs_input');
    expect(lineSummary([at('a', 'working', 10), at('b', 'idle', 11)], []).mark).toBe('working');
    expect(lineSummary([at('a', 'completed', 10)], [{ status: 'running' }])).toMatchObject({ mark: 'working', runs: 1, runningRuns: 1 });
    const done = lineSummary([at('namer', 'completed', 10), at('poet', 'idle', 30)], [{ status: 'done' }]);
    expect(done).toMatchObject({ mark: 'done', agents: 2, working: 0, runs: 1, runningRuns: 0 });
    expect(done.newest?.handle).toBe('poet');
    expect(lineSummary([at('a', 'completed', 10), at('b', 'failed', 20)], []).mark).toBe('failed');
    expect(lineSummary([], []).newest).toBeNull();
  });

  test('shortElapsed reads seconds, then whole minutes, then whole hours', () => {
    expect(shortElapsed(12_400)).toBe('12s');
    expect(shortElapsed(-5)).toBe('0s');
    expect(shortElapsed(90_000)).toBe('1m');
    expect(shortElapsed(59 * 60_000)).toBe('59m');
    expect(shortElapsed(2 * 60 * 60_000 + 5)).toBe('2h');
  });
});
