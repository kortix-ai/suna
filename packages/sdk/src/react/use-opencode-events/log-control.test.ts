import { beforeEach, describe, expect, test } from 'bun:test';
import { useRuntimePendingStore } from '../../browser/stores/opencode-pending-store';
import { pendingEventsOfLogState, sessionStatusOfLogFrame } from './log-control';

// The session-log control frames drive the same store transitions as the
// runtime's own status and interaction events, so a host renders the same
// status, permission cards and questions from either stream.

describe('sessionStatusOfLogFrame', () => {
  test('idle, busy and compacting are the thread status; a retry keeps its attempt and time', () => {
    const frame = (properties: unknown) => sessionStatusOfLogFrame({ type: 'log.status', properties });
    expect(frame({ thread_id: 'ses_a', status: 'idle' }) as unknown).toEqual({ type: 'session.status', properties: { sessionID: 'ses_a', status: { type: 'idle' } } });
    expect(frame({ thread_id: 'ses_a', status: 'busy' })?.properties.status).toEqual({ type: 'busy' });
    expect(frame({ thread_id: 'ses_a', status: 'compacting' })?.properties.status).toEqual({ type: 'busy' });
    expect(frame({ thread_id: 'ses_a', status: 'retry', retry: { attempt: 2, message: 'rate limited', next_at: '2026-10-30T10:00:00.000Z' } })?.properties.status).toEqual({
      type: 'retry',
      attempt: 2,
      message: 'rate limited',
      next: Date.parse('2026-10-30T10:00:00.000Z'),
    });
  });

  test('anything else is not a status', () => {
    expect(sessionStatusOfLogFrame({ type: 'log.message', properties: {} })).toBeNull();
    expect(sessionStatusOfLogFrame({ type: 'log.status', properties: { status: 'idle' } })).toBeNull();
    expect(sessionStatusOfLogFrame({ type: 'log.status', properties: { thread_id: 'ses_a', status: 'sleeping' } })).toBeNull();
  });
});

describe('pendingEventsOfLogState', () => {
  const permission = {
    id: 'perm_1',
    thread_id: 'ses_root',
    call_id: 'call_1',
    payload: { permission: 'bash', patterns: ['ls'], always: ['ls *'], metadata: { command: 'ls' } },
    asked_at: '2026-10-30T10:00:00.000Z',
  };
  const question = {
    id: 'que_1',
    thread_id: 'ses_child',
    payload: { questions: [{ question: 'Which?', header: 'Pick', options: [] }] },
    asked_at: '2026-10-30T10:00:00.000Z',
  };
  const state = (pending: unknown) => ({ type: 'log.state', properties: { generation: 1, session: { pending } } });

  beforeEach(() => {
    useRuntimePendingStore.setState({ permissions: {}, questions: {} });
  });

  test('a new request is asked; one the store holds is not asked again', () => {
    const events = pendingEventsOfLogState(state({ permissions: [permission], questions: [question] }), ['ses_root', 'ses_child']);
    expect(events as unknown).toEqual([
      {
        type: 'permission.asked',
        properties: { id: 'perm_1', sessionID: 'ses_root', permission: 'bash', patterns: ['ls'], always: ['ls *'], metadata: { command: 'ls' }, tool: { messageID: '', callID: 'call_1' } },
      },
      { type: 'question.asked', properties: { id: 'que_1', sessionID: 'ses_child', questions: [{ question: 'Which?', header: 'Pick', options: [] }] } },
    ]);
    useRuntimePendingStore.setState({
      permissions: { perm_1: events[0]!.properties as never },
      questions: { que_1: events[1]!.properties as never },
    });
    expect(pendingEventsOfLogState(state({ permissions: [permission], questions: [question] }), ['ses_root', 'ses_child']) as unknown).toEqual([]);
  });

  test("a request the log no longer lists is answered — only for this session's threads", () => {
    useRuntimePendingStore.setState({
      permissions: {
        perm_1: { id: 'perm_1', sessionID: 'ses_root' } as never,
        perm_other: { id: 'perm_other', sessionID: 'ses_elsewhere' } as never,
      },
      questions: { que_1: { id: 'que_1', sessionID: 'ses_child' } as never },
    });
    expect(pendingEventsOfLogState(state({ permissions: [], questions: [] }), ['ses_root', 'ses_child']) as unknown).toEqual([
      { type: 'permission.replied', properties: { sessionID: 'ses_root', requestID: 'perm_1', reply: 'once' } },
      { type: 'question.replied', properties: { sessionID: 'ses_child', requestID: 'que_1', answers: [] } },
    ]);
  });

  test('a state without pending changes nothing', () => {
    useRuntimePendingStore.setState({ permissions: { perm_1: { id: 'perm_1', sessionID: 'ses_root' } as never }, questions: {} });
    expect(pendingEventsOfLogState({ type: 'log.state', properties: { generation: 1, session: { title: 'x' } } }, ['ses_root']) as unknown).toEqual([]);
  });
});
