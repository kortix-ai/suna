import { describe, expect, test } from 'bun:test';
import { turnWaitingIn } from './turn-waiting';

/** A `/kortix/runtime/state` document with only the sections the reader uses. */
function stateDoc(input: {
  sessions?: Array<{ id: string; parent_id: string | null }>;
  permissions?: Array<{ sessionID: string }>;
  questions?: Array<{ sessionID: string }>;
  unreadable?: Array<'sessions' | 'permissions' | 'questions'>;
}): Record<string, unknown> {
  const section = (name: 'sessions' | 'permissions' | 'questions', value: unknown[]) =>
    input.unreadable?.includes(name) ? { known: false, reason: 'timeout', value } : { known: true, value };
  return {
    sessions: section('sessions', input.sessions ?? [{ id: 'ses_root', parent_id: null }]),
    permissions: section('permissions', input.permissions ?? []),
    questions: section('questions', input.questions ?? []),
  };
}

describe('turnWaitingIn: does the turn on a root conversation wait on a person?', () => {
  test('an open permission ask on the root: permission', () => {
    expect(turnWaitingIn(stateDoc({ permissions: [{ sessionID: 'ses_root' }] }), 'ses_root')).toBe('permission');
  });

  test('a question from a task inside a task (a grandchild): question', () => {
    const doc = stateDoc({
      sessions: [
        { id: 'ses_root', parent_id: null },
        { id: 'ses_child', parent_id: 'ses_root' },
        { id: 'ses_grandchild', parent_id: 'ses_child' },
      ],
      questions: [{ sessionID: 'ses_grandchild' }],
    });
    expect(turnWaitingIn(doc, 'ses_root')).toBe('question');
  });

  test('an ask on another root conversation of the same box: not this turn', () => {
    const doc = stateDoc({
      sessions: [
        { id: 'ses_root', parent_id: null },
        { id: 'ses_other', parent_id: null },
      ],
      permissions: [{ sessionID: 'ses_other' }],
    });
    expect(turnWaitingIn(doc, 'ses_root')).toBeNull();
  });

  test('no open ask: null', () => {
    expect(turnWaitingIn(stateDoc({}), 'ses_root')).toBeNull();
  });

  test('a section the daemon could not read counts as no answer, whatever it lists', () => {
    const doc = stateDoc({
      permissions: [{ sessionID: 'ses_root' }],
      questions: [{ sessionID: 'ses_root' }],
      unreadable: ['permissions', 'questions'],
    });
    expect(turnWaitingIn(doc, 'ses_root')).toBeNull();
  });

  test('an unreadable session list still sees an ask on the root itself', () => {
    const doc = stateDoc({
      sessions: [{ id: 'ses_child', parent_id: 'ses_root' }],
      questions: [{ sessionID: 'ses_child' }, { sessionID: 'ses_root' }],
      unreadable: ['sessions'],
    });
    expect(turnWaitingIn(doc, 'ses_root')).toBe('question');
    expect(turnWaitingIn({ ...doc, questions: { known: true, value: [{ sessionID: 'ses_child' }] } }, 'ses_root')).toBeNull();
  });

  test('a document without the sections (an old daemon): null', () => {
    expect(turnWaitingIn({}, 'ses_root')).toBeNull();
    expect(turnWaitingIn({ permissions: { known: true, value: 'not a list' } }, 'ses_root')).toBeNull();
  });
});
