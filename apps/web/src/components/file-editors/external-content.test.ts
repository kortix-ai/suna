import { describe, expect, test } from 'bun:test';

import { contentAfterExternalChange } from './external-content';

// The persisted file changed underneath an open editor — the agent's turn end
// refetched it. The editor must follow the new bytes unless the user has
// edits of their own, which are never overwritten.
describe('contentAfterExternalChange', () => {
  const base = { readOnly: false, justSaved: false };

  test('an unedited editor adopts the new content', () => {
    expect(
      contentAfterExternalChange({ ...base, local: 'A', saved: 'A', next: 'B' }),
    ).toBe('B');
  });

  test('an editor with unsaved edits keeps them', () => {
    expect(
      contentAfterExternalChange({ ...base, local: 'A + mine', saved: 'A', next: 'B' }),
    ).toBeNull();
  });

  test('right after a save, a stale refetch does not flash the old content back', () => {
    expect(
      contentAfterExternalChange({ ...base, justSaved: true, local: 'X', saved: 'X', next: 'A' }),
    ).toBeNull();
  });

  test('a read-only view always follows the new content', () => {
    expect(
      contentAfterExternalChange({ ...base, readOnly: true, local: 'A', saved: 'Z', next: 'B' }),
    ).toBe('B');
  });

  test('no change when the content is already current', () => {
    expect(
      contentAfterExternalChange({ ...base, local: 'B', saved: 'A', next: 'B' }),
    ).toBeNull();
  });
});
