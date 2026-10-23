import { describe, expect, test } from 'bun:test';
import { PRIVATE_THREAD_LABEL, type Refs, threadRuleGate, visibleSource } from './serialize';

const threads = [
  { sessionId: 'own', visibility: 'private', createdBy: 'priya' },
  { sessionId: 'shared', visibility: 'project', createdBy: 'sam' },
  { sessionId: 'priya-dm', visibility: 'private', createdBy: 'priya' },
  { sessionId: 'sam-private', visibility: 'private', createdBy: 'sam' },
  { sessionId: 'restricted', visibility: 'restricted', createdBy: 'priya' },
];

type Source = { kind: string; sessionId: string | null; messageId: string | null; label: string };
const source = (value: Source): Source => value;

describe('which threads a memory source may name', () => {
  test("a project-visible thread's agent names itself and project-visible threads only", async () => {
    const open = await threadRuleGate({ threadSessionId: 'channel-thread', threadVisibility: 'project', threadOwner: 'priya' })([
      ...threads,
      { sessionId: 'channel-thread', visibility: 'project', createdBy: 'priya' },
    ]);
    expect([...open].sort()).toEqual(['channel-thread', 'shared']);
  });

  test("a private thread's agent also names its owner's private threads, never another member's", async () => {
    const open = await threadRuleGate({ threadSessionId: 'own', threadVisibility: 'private', threadOwner: 'priya' })(threads);
    expect([...open].sort()).toEqual(['own', 'priya-dm', 'shared']);
  });

  test('a thread the viewer cannot open loses its id, message and title; a person source keeps its name', () => {
    const refs: Refs = {
      names: new Map(),
      threads: new Map([
        ['hidden', { label: 'Salary talk with Sam', hint: { space_kind: 'dm', agent: 'writer' }, open: false }],
        ['seen', { label: 'Q4 plan', hint: null, open: true }],
      ]),
    };
    expect(visibleSource(source({ kind: 'thread', sessionId: 'hidden', messageId: 'm1', label: 'Salary talk with Sam' }), refs)).toEqual({
      kind: 'thread',
      sessionId: null,
      messageId: null,
      label: PRIVATE_THREAD_LABEL,
    });
    expect(visibleSource(source({ kind: 'person', sessionId: 'hidden', messageId: 'm1', label: 'Priya' }), refs)).toEqual({
      kind: 'person',
      sessionId: null,
      messageId: null,
      label: 'Priya',
    });
    const seen = source({ kind: 'thread', sessionId: 'seen', messageId: 'm2', label: 'Q4 plan' });
    expect(visibleSource(seen, refs)).toBe(seen);
    // A session that no longer exists reads as hidden too.
    expect(visibleSource(source({ kind: 'thread', sessionId: 'gone', messageId: null, label: 'x' }), refs).label).toBe(PRIVATE_THREAD_LABEL);
  });
});
