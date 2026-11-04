import { describe, expect, test } from 'bun:test';
import type { ProjectSession } from '@kortix/sdk';

import {
  BOARD_FOLD_LIMIT,
  BOARD_GROUPS,
  boardActivityAt,
  boardAgentOf,
  boardGroupOf,
  boardRowOrder,
  boardStateOf,
  compactAge,
  groupBoard,
  matchesBoardFilters,
} from './board-grouping';

let n = 0;
function session(overrides: Partial<ProjectSession> = {}): ProjectSession {
  n += 1;
  return {
    session_id: `s${n}`,
    account_id: 'a1',
    project_id: 'p1',
    branch_name: `b${n}`,
    base_ref: 'main',
    sandbox_provider: 'platinum',
    sandbox_id: null,
    sandbox_url: null,
    opencode_session_id: null,
    name: `Session ${n}`,
    custom_name: null,
    agent_name: 'default',
    status: 'running',
    error: null,
    metadata: {},
    opencode_sessions: [],
    created_at: '2026-10-30T10:00:00.000Z',
    updated_at: '2026-10-30T10:00:00.000Z',
    ...overrides,
  } as ProjectSession;
}

describe('boardStateOf', () => {
  test('reads board_state from the API', () => {
    for (const state of ['working', 'needs_input', 'idle', 'completed', 'failed', 'stopped'] as const) {
      expect(boardStateOf(session({ board_state: state }))).toBe(state);
    }
  });

  test('attention or a review item means needs input, whatever board_state says', () => {
    expect(boardStateOf(session({ board_state: 'working', attention: 'question' }))).toBe('needs_input');
    expect(boardStateOf(session({ board_state: 'idle', attention: 'approval' }))).toBe('needs_input');
    expect(boardStateOf(session({ board_state: 'idle' }), 2)).toBe('needs_input');
  });

  test('an older API without board_state: derived from status and working', () => {
    expect(boardStateOf(session({ status: 'running', working: { state: 'working', since: null, turn_token: null, pending_delivery: false } }))).toBe('working');
    expect(boardStateOf(session({ status: 'running', working: { state: 'idle', since: null, turn_token: null, pending_delivery: false } }))).toBe('idle');
    expect(boardStateOf(session({ status: 'running' }))).toBe('working');
    expect(boardStateOf(session({ status: 'provisioning' }))).toBe('working');
    expect(boardStateOf(session({ status: 'queued' }))).toBe('working');
    expect(boardStateOf(session({ status: 'completed' }))).toBe('completed');
    expect(boardStateOf(session({ status: 'failed' }))).toBe('failed');
    expect(boardStateOf(session({ status: 'stopped' }))).toBe('stopped');
  });
});

describe('boardGroupOf', () => {
  test('pinned wins over every state', () => {
    expect(boardGroupOf(session({ pinned_at: '2026-10-30T10:00:00.000Z', board_state: 'failed' }))).toBe('pinned');
  });

  test('idle with an answer is ready for review; idle without one is completed', () => {
    expect(boardGroupOf(session({ board_state: 'idle', result_excerpt: 'Fixed the login bug.' }))).toBe('review');
    expect(boardGroupOf(session({ board_state: 'idle', result_excerpt: '   ' }))).toBe('completed');
    expect(boardGroupOf(session({ board_state: 'idle', result_excerpt: null }))).toBe('completed');
  });

  test('failed and stopped share one group', () => {
    expect(boardGroupOf(session({ board_state: 'failed' }))).toBe('ended');
    expect(boardGroupOf(session({ board_state: 'stopped' }))).toBe('ended');
    expect(boardGroupOf(session({ board_state: 'needs_input' }))).toBe('needs_input');
    expect(boardGroupOf(session({ board_state: 'working' }))).toBe('working');
    expect(boardGroupOf(session({ board_state: 'completed' }))).toBe('completed');
  });
});

describe('groupBoard', () => {
  test('groups come in board order, empty groups dropped', () => {
    const groups = groupBoard([
      session({ board_state: 'stopped' }),
      session({ board_state: 'completed' }),
      session({ board_state: 'idle', result_excerpt: 'Done.' }),
      session({ board_state: 'working' }),
      session({ attention: 'question' }),
      session({ pinned_at: '2026-10-30T10:00:00.000Z' }),
    ]);
    expect(groups.map((group) => group.id)).toEqual([...BOARD_GROUPS]);
    expect(groupBoard([session({ board_state: 'working' })]).map((group) => group.id)).toEqual(['working']);
  });

  test('newest activity first inside a group, by last_activity_at then updated_at', () => {
    const old = session({ board_state: 'working', last_activity_at: '2026-10-30T09:00:00.000Z' });
    const fresh = session({ board_state: 'working', last_activity_at: '2026-10-30T11:00:00.000Z' });
    const middle = session({ board_state: 'working', last_activity_at: null, updated_at: '2026-10-30T10:30:00.000Z' });
    expect(groupBoard([old, fresh, middle])[0]!.sessions.map((s) => s.session_id)).toEqual([
      fresh.session_id,
      middle.session_id,
      old.session_id,
    ]);
    expect(boardActivityAt(middle)).toBe('2026-10-30T10:30:00.000Z');
  });

  test('a long finished group folds into "… N more"; an active one never does', () => {
    const done = Array.from({ length: BOARD_FOLD_LIMIT + 4 }, () => session({ board_state: 'completed' }));
    const working = Array.from({ length: BOARD_FOLD_LIMIT + 4 }, () => session({ board_state: 'working' }));
    const groups = groupBoard([...done, ...working]);
    expect(groups.find((g) => g.id === 'completed')).toMatchObject({ hidden: 4, total: BOARD_FOLD_LIMIT + 4 });
    expect(groups.find((g) => g.id === 'completed')!.sessions).toHaveLength(BOARD_FOLD_LIMIT);
    expect(groups.find((g) => g.id === 'working')).toMatchObject({ hidden: 0, total: BOARD_FOLD_LIMIT + 4 });
  });

  test('a fold never hides a single row, and unfolds when expanded or filtering', () => {
    const one = Array.from({ length: BOARD_FOLD_LIMIT + 1 }, () => session({ board_state: 'stopped' }));
    expect(groupBoard(one)[0]!.hidden).toBe(0);
    const many = Array.from({ length: BOARD_FOLD_LIMIT + 3 }, () => session({ board_state: 'stopped' }));
    expect(groupBoard(many)[0]!.hidden).toBe(3);
    expect(groupBoard(many, { expanded: new Set(['ended']) })[0]!.hidden).toBe(0);
    expect(groupBoard(many, { filtering: true })[0]!.hidden).toBe(0);
  });

  test('a review item moves a row to Needs input', () => {
    const row = session({ board_state: 'working' });
    expect(groupBoard([row], { needsYouBySession: { [row.session_id]: 1 } })[0]!.id).toBe('needs_input');
  });

  test('the keyboard walks the shown rows top to bottom, skipping folded ones', () => {
    const pinned = session({ pinned_at: '2026-10-30T10:00:00.000Z' });
    const done = Array.from({ length: BOARD_FOLD_LIMIT + 3 }, () => session({ board_state: 'completed' }));
    const order = boardRowOrder(groupBoard([...done, pinned]));
    expect(order[0]).toBe(pinned.session_id);
    expect(order).toHaveLength(1 + BOARD_FOLD_LIMIT);
  });
});

describe('filters', () => {
  test('by state, by agent (handle or agent name, any case), and by text', () => {
    const reviewer = session({ board_state: 'working', agent_handle: 'reviewer', agent_name: 'code-review', result_excerpt: 'Found 3 issues' });
    expect(boardAgentOf(reviewer)).toBe('reviewer');
    expect(boardAgentOf(session({ agent_handle: null, agent_name: 'writer' }))).toBe('writer');
    expect(matchesBoardFilters(reviewer, { states: ['working'] }, 'Audit')).toBe(true);
    expect(matchesBoardFilters(reviewer, { states: ['failed', 'stopped'] }, 'Audit')).toBe(false);
    expect(matchesBoardFilters(reviewer, { agents: ['Reviewer'] }, 'Audit')).toBe(true);
    expect(matchesBoardFilters(reviewer, { agents: ['code-review'] }, 'Audit')).toBe(true);
    expect(matchesBoardFilters(reviewer, { agents: ['writer'] }, 'Audit')).toBe(false);
    expect(matchesBoardFilters(reviewer, { text: 'issues' }, 'Audit')).toBe(true);
    expect(matchesBoardFilters(reviewer, { text: 'audit' }, 'Audit')).toBe(true);
    expect(matchesBoardFilters(reviewer, { text: 'deploy' }, 'Audit')).toBe(false);
    expect(matchesBoardFilters(reviewer, {}, 'Audit')).toBe(true);
  });
});

describe('compactAge', () => {
  const now = Date.parse('2026-10-30T12:00:00.000Z');
  test('now, minutes, hours, days', () => {
    expect(compactAge('2026-10-30T11:59:40.000Z', now)).toBe('now');
    expect(compactAge('2026-10-30T11:57:00.000Z', now)).toBe('3m');
    expect(compactAge('2026-10-30T10:00:00.000Z', now)).toBe('2h');
    expect(compactAge('2026-10-26T12:00:00.000Z', now)).toBe('4d');
    expect(compactAge('not a date', now)).toBe('');
    // A clock a little ahead of the server is not a negative age.
    expect(compactAge('2026-10-30T12:01:00.000Z', now)).toBe('now');
  });
});
