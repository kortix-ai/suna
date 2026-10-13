import { describe, expect, test } from 'bun:test';
import { turnWaitingIn } from './turn-waiting';

type Section = 'sessions' | 'statuses' | 'permissions' | 'questions';

/** A `/kortix/runtime/state` document with only the sections the reader uses. */
function stateDoc(input: {
  sessions?: Array<{ id: string; parent_id: string | null }>;
  /** Running conversations; every other one is idle (absent), as OpenCode reports it. */
  running?: Record<string, 'busy' | 'retry'>;
  permissions?: Array<{ sessionID: string }>;
  questions?: Array<{ sessionID: string }>;
  unreadable?: Section[];
}): Record<string, unknown> {
  const section = (name: Section, value: unknown) =>
    input.unreadable?.includes(name) ? { known: false, reason: 'timeout', value } : { known: true, value };
  const statuses = Object.fromEntries(
    Object.entries(input.running ?? { ses_root: 'busy' }).map(([id, type]) => [id, { type }]),
  );
  return {
    sessions: section('sessions', input.sessions ?? [{ id: 'ses_root', parent_id: null }]),
    statuses: section('statuses', statuses),
    permissions: section('permissions', input.permissions ?? []),
    questions: section('questions', input.questions ?? []),
  };
}

const TREE = [
  { id: 'ses_root', parent_id: null },
  { id: 'ses_child', parent_id: 'ses_root' },
  { id: 'ses_grandchild', parent_id: 'ses_child' },
  { id: 'ses_sibling', parent_id: 'ses_root' },
];

describe('turnWaitingIn: does the turn on a root conversation wait on a person?', () => {
  test('a permission ask on the busy root: permission', () => {
    expect(turnWaitingIn(stateDoc({ permissions: [{ sessionID: 'ses_root' }] }), 'ses_root')).toBe('permission');
  });

  test('a question from a task inside a task, with only its ancestors running: question', () => {
    const doc = stateDoc({
      sessions: TREE,
      running: { ses_root: 'busy', ses_child: 'busy', ses_grandchild: 'busy' },
      questions: [{ sessionID: 'ses_grandchild' }],
    });
    expect(turnWaitingIn(doc, 'ses_root')).toBe('question');
  });

  test('a sub-agent that still works beside the ask: none', () => {
    const doc = stateDoc({
      sessions: TREE,
      running: { ses_root: 'busy', ses_child: 'busy', ses_sibling: 'busy' },
      permissions: [{ sessionID: 'ses_child' }],
    });
    expect(turnWaitingIn(doc, 'ses_root')).toBe('none');
  });

  test('an ask left on a conversation that no longer runs (a lost replied frame): none', () => {
    const doc = stateDoc({ running: {}, permissions: [{ sessionID: 'ses_root' }] });
    expect(turnWaitingIn(doc, 'ses_root')).toBe('none');
  });

  test('an ask on another root conversation of the same box: none', () => {
    const doc = stateDoc({
      sessions: [
        { id: 'ses_root', parent_id: null },
        { id: 'ses_other', parent_id: null },
      ],
      running: { ses_other: 'busy' },
      permissions: [{ sessionID: 'ses_other' }],
    });
    expect(turnWaitingIn(doc, 'ses_root')).toBe('none');
  });

  test('a busy root with no ask: none', () => {
    expect(turnWaitingIn(stateDoc({}), 'ses_root')).toBe('none');
  });

  test('a root that retries a model call while its ask is open still waits', () => {
    const doc = stateDoc({ running: { ses_root: 'retry' }, questions: [{ sessionID: 'ses_root' }] });
    expect(turnWaitingIn(doc, 'ses_root')).toBe('question');
  });

  test('unreadable asks, statuses or tree: unknown, whatever the readable sections say', () => {
    for (const unreadable of [['permissions'], ['questions'], ['statuses'], ['sessions']] as Section[][]) {
      const doc = stateDoc({ questions: [{ sessionID: 'ses_root' }], unreadable });
      expect(turnWaitingIn(doc, 'ses_root')).toBe('unknown');
    }
    expect(turnWaitingIn({}, 'ses_root')).toBe('unknown');
    expect(turnWaitingIn({ ...stateDoc({}), permissions: { known: true, value: 'not a list' } }, 'ses_root')).toBe('unknown');
  });

  test('a parent cycle does not loop', () => {
    const doc = stateDoc({
      sessions: [
        { id: 'ses_a', parent_id: 'ses_b' },
        { id: 'ses_b', parent_id: 'ses_a' },
      ],
      running: { ses_a: 'busy' },
      questions: [{ sessionID: 'ses_a' }],
    });
    expect(turnWaitingIn(doc, 'ses_root')).toBe('none');
  });
});
