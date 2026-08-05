import { describe, expect, test } from 'bun:test';

import type { ProjectSession } from '@kortix/sdk';
import { applySessionRename } from './rename-session-cache';

function makeSession(overrides: Partial<ProjectSession> = {}): ProjectSession {
  return {
    session_id: 's1',
    project_id: 'p1',
    status: 'running',
    created_at: '2026-01-01T00:00:00.000Z',
    custom_name: null,
    name: null,
    branch_name: null,
    metadata: null,
    ...overrides,
  } as unknown as ProjectSession;
}

describe('applySessionRename', () => {
  test('writes the new name into the matching session', () => {
    const sessions = [makeSession({ session_id: 's1', custom_name: 'Old name' })];

    const result = applySessionRename(sessions, 's1', 'New name');

    expect(result[0].custom_name).toBe('New name');
  });

  test('leaves every other row byte-identical (same object reference)', () => {
    const other = makeSession({ session_id: 's2', custom_name: 'Untouched' });
    const sessions = [makeSession({ session_id: 's1' }), other];

    const result = applySessionRename(sessions, 's1', 'New name');

    // Reference equality, not just deep equality — nothing about the other
    // row was recreated, so a consumer memoized on it never re-renders.
    expect(result[1]).toBe(other);
  });

  test('an unknown sessionId returns the SAME array, unchanged', () => {
    const sessions = [makeSession({ session_id: 's1', custom_name: 'Old name' })];

    const result = applySessionRename(sessions, 'does-not-exist', 'New name');

    expect(result).toBe(sessions);
    expect(result[0].custom_name).toBe('Old name');
  });

  test('an empty list is a no-op, not a throw', () => {
    expect(applySessionRename([], 's1', 'New name')).toEqual([]);
  });

  test('an empty name clears the override (custom_name: null) rather than storing ""', () => {
    // Mirrors the API's own clear-vs-set rule: `name: ''` deletes
    // metadata.custom_name server-side, reverting to the auto title.
    const sessions = [makeSession({ session_id: 's1', custom_name: 'Old name' })];

    const result = applySessionRename(sessions, 's1', '');

    expect(result[0].custom_name).toBeNull();
  });

  test('the returned array is a new reference when a rename applies', () => {
    const sessions = [makeSession({ session_id: 's1' })];

    const result = applySessionRename(sessions, 's1', 'New name');

    expect(result).not.toBe(sessions);
  });
});
