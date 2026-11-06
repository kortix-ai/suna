import { describe, expect, test } from 'bun:test';
import type { PeerMessage } from '../rest/projects-client/multi-agent';
import {
  heldMessages,
  looksLikeTeamTaskInput,
  parsePeerSend,
  parseReachable,
  parseStoppedChild,
  parseTasks,
  peerMessagePreview,
} from './tool-data';

const peerMessage = (id: string, status: PeerMessage['status'], extra: Partial<PeerMessage> = {}): PeerMessage => ({
  id,
  project_id: 'proj_1',
  from_session_id: 'ses_rev',
  from_handle: 'reviewer',
  to_session_id: 'ses_lead',
  to_handle: 'lead',
  type: 'message',
  message: `${id}\nmore`,
  summary: null,
  status,
  notify_when_idle: false,
  created_at: '2026-11-03T10:00:00Z',
  decided_at: null,
  ...extra,
});

describe('send_message result', () => {
  test('reads the receiver, the text and the delivery; an unknown status is not a send', () => {
    expect(
      parsePeerSend({ status: 'held', to: { handle: '@scout' }, message: { message: 'Post it?', summary: null }, note: 'Waiting for approval.' }),
    ).toEqual({ status: 'held', to: 'scout', message: 'Post it?', summary: null, note: 'Waiting for approval.' });
    expect(parsePeerSend({ status: 'sent' })).toBeNull();
    expect(parsePeerSend(null)).toBeNull();
  });

  test('without a resolved receiver the handle comes from the message', () => {
    expect(parsePeerSend({ status: 'refused', to: null, message: { to_handle: '@lead', message: '  hi  ' } })).toEqual({
      status: 'refused',
      to: 'lead',
      message: 'hi',
      summary: null,
      note: null,
    });
  });
});

describe('team results', () => {
  test('tasks: one, a list, and a malformed entry dropped', () => {
    expect(parseTasks({ task: { seq: 3, subject: 'Write the fix', status: 'in_progress', owner_handle: 'dev' } })).toEqual([
      { seq: 3, subject: 'Write the fix', status: 'in_progress', owner: 'dev', blockedBy: [], blocked: false },
    ]);
    expect(parseTasks({ tasks: [{ seq: 1, subject: 'A', status: 'pending' }, { seq: 0, subject: 'bad', status: 'pending' }] })).toHaveLength(1);
  });

  test('tasks: a bare task, its blockers, and shapes that are not tasks', () => {
    expect(parseTasks({ seq: 2, subject: 'B', status: 'pending', blocked_by: [1, 0, 'x', 1.5, 4], blocked: true })).toEqual([
      { seq: 2, subject: 'B', status: 'pending', owner: null, blockedBy: [1, 4], blocked: true },
    ]);
    expect(parseTasks({ task: { seq: 2, subject: 'B', status: 'done' } })).toBeNull();
    expect(parseTasks([])).toBeNull();
  });

  test('list_agents leaves the asking session out; task_stop needs its session', () => {
    const rows = parseReachable({ agents: [{ handle: 'me', session_id: 's0', relation: 'self' }, { handle: 'scout', session_id: 's1', state: 'working' }] });
    expect(rows?.map((row) => row.handle)).toEqual(['scout']);
    expect(parseStoppedChild({ stopped: true, sessionId: 's1', handle: 'scout' })?.stopped).toBe(true);
    expect(parseStoppedChild({ stopped: true })).toBeNull();
  });

  test('list_agents: defaults for a sparse row, an unknown state, and at most 50 rows', () => {
    expect(parseReachable({ agents: [{ handle: '@scout', session_id: 's1', state: 'dreaming' }] })).toEqual([
      { handle: 'scout', sessionId: 's1', title: null, agentName: null, relation: 'session', state: null, canReceive: true },
    ]);
    expect(parseReachable({ agents: [{ handle: 'busy', session_id: 's2', can_receive: false }] })?.[0]?.canReceive).toBe(false);
    const many = Array.from({ length: 60 }, (_, index) => ({ handle: `a${index}`, session_id: `s${index}` }));
    expect(parseReachable({ agents: many })).toHaveLength(50);
    expect(parseReachable({ agents: 'none' })).toBeNull();
  });

  test("pi's task tools take a subject or a task number; the older tools take neither", () => {
    expect(looksLikeTeamTaskInput({ subject: 'Write it' })).toBe(true);
    expect(looksLikeTeamTaskInput({ seq: 2 })).toBe(true);
    expect(looksLikeTeamTaskInput({ description: 'old plugin' })).toBe(false);
    expect(looksLikeTeamTaskInput(null)).toBe(false);
  });
});

describe('peer messages', () => {
  test('the preview is the summary, else the first line; an idle notice reads its last answer', () => {
    expect(peerMessagePreview({ summary: 'Heads up', text: 'Line one.' })).toBe('Heads up');
    expect(peerMessagePreview({ summary: null, text: '\nLine one.\nLine two.' })).toBe('Line one.');
    expect(peerMessagePreview({ summary: '  Short  ', text: 'Long body' })).toBe('Short');
    expect(peerMessagePreview({ kind: 'idle_notice', summary: null, text: 'scout finished its turn and is idle.\nIts last answer: Indexed.' })).toBe('Indexed.');
  });

  test('an idle notice without an answer previews nothing, unless its first line says something else', () => {
    expect(peerMessagePreview({ kind: 'idle_notice', summary: null, text: 'scout finished its turn and is idle.' })).toBe('');
    expect(peerMessagePreview({ kind: 'idle_notice', summary: null, text: 'scout failed: out of credits' })).toBe('scout failed: out of credits');
    expect(peerMessagePreview({ kind: 'message', summary: null, text: '' })).toBe('');
  });

  test('held: only the messages that wait, oldest first', () => {
    const messages = [
      peerMessage('b', 'held', { created_at: '2026-11-03T10:02:00Z' }),
      peerMessage('x', 'delivered', { created_at: '2026-11-03T10:00:00Z' }),
      peerMessage('a', 'held', { created_at: '2026-11-03T10:01:00Z' }),
    ];
    expect(heldMessages(messages).map((message) => message.id)).toEqual(['a', 'b']);
    expect(heldMessages(undefined)).toEqual([]);
  });
});
