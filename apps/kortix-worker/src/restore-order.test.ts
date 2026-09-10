import { describe, expect, test } from 'bun:test';
import { restoredMessagesFromEntries } from './worker.ts';

// Shaped exactly like the persisted entries read back from the store.
const branchNewestFirst = [
  { type: 'message', seq: 4, message: { role: 'assistant', content: [{ type: 'text', text: '6' }] } },
  { type: 'message', seq: 3, message: { role: 'user', content: [{ type: 'text', text: '3+3?' }] } },
  { type: 'message', seq: 2, message: { role: 'assistant', content: [{ type: 'text', text: '4' }] } },
  { type: 'message', seq: 1, message: { role: 'user', content: [{ type: 'text', text: '2+2?' }] } },
];

describe('restoredMessagesFromEntries', () => {
  // pi's findEntriesOnBranch walks parent links UP from the leaf. Taking that
  // order at face value seeded BOTH the agent's history and the wire
  // transcript backwards: a resumed session showed its questions answered
  // before they were asked, and the model reasoned over a reversed dialogue.
  test('returns the branch oldest-first, whatever order the walk produced', () => {
    expect(restoredMessagesFromEntries(branchNewestFirst).map((m) => m.content[0].text)).toEqual([
      '2+2?',
      '4',
      '3+3?',
      '6',
    ]);
  });

  test('drops non-message entries', () => {
    const mixed = [...branchNewestFirst, { type: 'summary', seq: 5, message: { role: 'system' } }];
    expect(restoredMessagesFromEntries(mixed)).toHaveLength(4);
  });

  test('an empty branch restores nothing rather than throwing', () => {
    expect(restoredMessagesFromEntries([])).toEqual([]);
  });
});
