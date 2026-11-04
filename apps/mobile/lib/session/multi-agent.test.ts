import { describe, expect, test } from 'bun:test';
import type { PeerMessage } from '@kortix/sdk';
import {
  heldMessages,
  heldPreview,
  looksLikeTeamTaskInput,
  parsePeerSend,
  parseReachable,
  parseStoppedChild,
  parseTasks,
  peerHeadline,
  peerMessagePreview,
  taskGlyph,
} from './multi-agent';

describe('send_message result', () => {
  test('reads the receiver, the text and the delivery; an unknown status is not a send', () => {
    expect(
      parsePeerSend({ status: 'held', to: { handle: '@scout' }, message: { message: 'Post it?', summary: null }, note: 'Waiting for approval.' }),
    ).toEqual({ status: 'held', to: 'scout', message: 'Post it?', summary: null, note: 'Waiting for approval.' });
    expect(parsePeerSend({ status: 'sent' })).toBeNull();
  });
});

describe('team results', () => {
  test('tasks: one, a list, and a malformed entry dropped', () => {
    expect(parseTasks({ task: { seq: 3, subject: 'Write the fix', status: 'in_progress', owner_handle: 'dev' } })).toEqual([
      { seq: 3, subject: 'Write the fix', status: 'in_progress', owner: 'dev', blockedBy: [], blocked: false },
    ]);
    expect(parseTasks({ tasks: [{ seq: 1, subject: 'A', status: 'pending' }, { seq: 0, subject: 'bad', status: 'pending' }] })).toHaveLength(1);
  });

  test('list_agents leaves the asking session out; task_stop needs its session', () => {
    const rows = parseReachable({ agents: [{ handle: 'me', session_id: 's0', relation: 'self' }, { handle: 'scout', session_id: 's1', state: 'working' }] });
    expect(rows?.map((row) => row.handle)).toEqual(['scout']);
    expect(parseStoppedChild({ stopped: true, sessionId: 's1', handle: 'scout' })?.stopped).toBe(true);
    expect(parseStoppedChild({ stopped: true })).toBeNull();
  });

  test('a task status reads as a session glyph; a blocked open task is the stopped ring', () => {
    expect(taskGlyph({ status: 'completed', blocked: false })).toBe('done');
    expect(taskGlyph({ status: 'in_progress', blocked: false })).toBe('running');
    expect(taskGlyph({ status: 'pending', blocked: false })).toBe('starting');
    expect(taskGlyph({ status: 'pending', blocked: true })).toBe('stopped');
  });

  test("pi's task tools take a subject or a task number; the older tools take neither", () => {
    expect(looksLikeTeamTaskInput({ subject: 'Write it' })).toBe(true);
    expect(looksLikeTeamTaskInput({ seq: 2 })).toBe(true);
    expect(looksLikeTeamTaskInput({ description: 'old plugin' })).toBe(false);
  });
});

describe('peer messages', () => {
  test('the preview is the summary, else the first line; an idle notice reads its last answer', () => {
    expect(peerMessagePreview({ summary: 'Heads up', text: 'Line one.' })).toBe('Heads up');
    expect(peerMessagePreview({ summary: null, text: '\nLine one.\nLine two.' })).toBe('Line one.');
    expect(peerMessagePreview({ kind: 'idle_notice', summary: null, text: 'scout finished its turn and is idle.\nIts last answer: Indexed.' })).toBe('Indexed.');
    expect(peerHeadline('message', '@scout')).toBe('Message from @scout');
    expect(peerHeadline('idle_notice', '@scout')).toBe('@scout finished');
  });

  test('held: only the messages that wait, oldest first; the preview is the summary, else the first line', () => {
    const m = (id: string, status: string, at: string) => ({ id, status, created_at: at, summary: null, message: `${id}\nmore` }) as unknown as PeerMessage;
    expect(heldMessages([m('b', 'held', '2026-11-03T10:02:00Z'), m('x', 'delivered', '2026-11-03T10:00:00Z'), m('a', 'held', '2026-11-03T10:01:00Z')]).map((x) => x.id)).toEqual(['a', 'b']);
    expect(heldPreview(m('first line', 'held', ''))).toBe('first line');
  });
});
