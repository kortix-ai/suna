import { describe, expect, test } from 'bun:test';
import { turnWaitingInPending } from './turn-waiting';


/** A `GET /kortix/runtime/pending` answer: one session, its root and its subagent threads. */
function pendingDoc(input: {
  statuses?: Record<string, 'idle' | 'busy' | 'compacting'>;
  permissions?: string[];
  questions?: string[];
}): Record<string, unknown> {
  const record = (thread_id: string, i: number) => ({ id: `req_${i}`, thread_id, payload: {}, asked_at: '2026-10-31T00:00:00.000Z' });
  return {
    statuses: input.statuses ?? { ses_root: 'busy' },
    permissions: (input.permissions ?? []).map(record),
    questions: (input.questions ?? []).map(record),
  };
}

describe('turnWaitingInPending: does the turn on a root conversation wait on a person?', () => {
  test('a permission ask on the busy root: permission', () => {
    expect(turnWaitingInPending(pendingDoc({ permissions: ['ses_root'] }), 'ses_root')).toBe('permission');
  });

  test('a question from a busy subagent while the root waits on it: question', () => {
    const doc = pendingDoc({ statuses: { ses_root: 'busy', ses_child: 'busy' }, questions: ['ses_child'] });
    expect(turnWaitingInPending(doc, 'ses_root')).toBe('question');
  });

  test('a subagent that still works beside the ask: none', () => {
    const doc = pendingDoc({
      statuses: { ses_root: 'busy', ses_child: 'busy', ses_sibling: 'busy' },
      permissions: ['ses_child'],
    });
    expect(turnWaitingInPending(doc, 'ses_root')).toBe('none');
  });

  test('a compacting thread works; an idle one does not', () => {
    const working = pendingDoc({ statuses: { ses_root: 'busy', ses_child: 'busy', ses_sibling: 'compacting' }, questions: ['ses_child'] });
    expect(turnWaitingInPending(working, 'ses_root')).toBe('none');
    const done = pendingDoc({ statuses: { ses_root: 'busy', ses_child: 'busy', ses_sibling: 'idle' }, questions: ['ses_child'] });
    expect(turnWaitingInPending(done, 'ses_root')).toBe('question');
  });

  test('an ask left on a thread that no longer runs: none', () => {
    expect(turnWaitingInPending(pendingDoc({ statuses: { ses_root: 'idle' }, permissions: ['ses_root'] }), 'ses_root')).toBe('none');
    expect(turnWaitingInPending(pendingDoc({ permissions: ['ses_gone'] }), 'ses_root')).toBe('none');
  });

  test('a busy root with no ask: none', () => {
    expect(turnWaitingInPending(pendingDoc({}), 'ses_root')).toBe('none');
  });

  test('an answer about another root (a stale root id): unknown, whatever its asks say', () => {
    const doc = pendingDoc({ statuses: { ses_other: 'busy' }, questions: ['ses_other'] });
    expect(turnWaitingInPending(doc, 'ses_root')).toBe('unknown');
    expect(turnWaitingInPending(pendingDoc({ statuses: {} }), 'ses_root')).toBe('unknown');
  });

  test('a malformed answer: unknown', () => {
    expect(turnWaitingInPending({}, 'ses_root')).toBe('unknown');
    expect(turnWaitingInPending(null, 'ses_root')).toBe('unknown');
    expect(turnWaitingInPending({ ...pendingDoc({}), statuses: [] }, 'ses_root')).toBe('unknown');
    expect(turnWaitingInPending({ ...pendingDoc({}), questions: 'none' }, 'ses_root')).toBe('unknown');
  });
});
