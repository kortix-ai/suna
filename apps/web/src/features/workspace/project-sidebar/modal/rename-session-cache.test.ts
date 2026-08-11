import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';

import type { ProjectSession } from '@kortix/sdk';
import {
  applyRenameResponse,
  applySessionRename,
  beginOptimisticRename,
  rollbackOptimisticRename,
} from './rename-session-cache';

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
    const sessions: ProjectSession[] = [];

    // Same standard as the other no-op cases above: reference equality, not
    // just an equivalent empty array.
    expect(applySessionRename(sessions, 's1', 'New name')).toBe(sessions);
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

/**
 * `beginOptimisticRename` / `rollbackOptimisticRename` are `onMutate` /
 * `onError`'s cache write and restore, extracted from the mutation so a real
 * `QueryClient` — a plain class, no provider or component needed — can drive
 * the exact write-then-restore sequence the rename modal performs, without
 * mounting anything or mocking a module.
 */
describe('beginOptimisticRename + rollbackOptimisticRename', () => {
  const QUERY_KEY = ['project-sessions', 'p1'];

  test('begin writes the new name into the cache and returns the pre-rename snapshot', () => {
    const queryClient = new QueryClient();
    const original = [makeSession({ session_id: 's1', custom_name: 'Old name' })];
    queryClient.setQueryData(QUERY_KEY, original);

    const { previous } = beginOptimisticRename(queryClient, QUERY_KEY, 's1', 'New name');

    expect(previous).toBe(original);
    expect(queryClient.getQueryData<ProjectSession[]>(QUERY_KEY)?.[0].custom_name).toBe('New name');
  });

  test('the rollback path restores the exact pre-rename snapshot', () => {
    // The case the Important review finding asked for: drive begin, THEN
    // rollback, and assert the cache is back to what it was before either
    // ran — not just that the two functions individually behave.
    const queryClient = new QueryClient();
    const s2 = makeSession({ session_id: 's2', custom_name: 'Other' });
    const original = [makeSession({ session_id: 's1', custom_name: 'Old name' }), s2];
    queryClient.setQueryData(QUERY_KEY, original);

    const { previous } = beginOptimisticRename(queryClient, QUERY_KEY, 's1', 'New name');
    // Sanity check: the optimistic write actually landed before rolling it
    // back — otherwise the restore assertion below would pass vacuously.
    expect(queryClient.getQueryData<ProjectSession[]>(QUERY_KEY)?.[0].custom_name).toBe('New name');

    rollbackOptimisticRename(queryClient, QUERY_KEY, previous);

    // `toEqual`, not `toBe`: QueryClient's default structural sharing
    // rebuilds a fresh array/object on every `setQueryData` call, even when
    // the values it produces are deeply equal to what went in. Reference
    // stability is `applySessionRename`'s own contract (covered above,
    // directly, with no QueryClient involved) — here the property under test
    // is that the CONTENT is exactly what it was before the rename.
    const restored = queryClient.getQueryData<ProjectSession[]>(QUERY_KEY);
    expect(restored).toEqual(original);
    expect(restored?.[0].custom_name).toBe('Old name');
    expect(restored?.[1].custom_name).toBe('Other');
  });

  test('no sessionId (nothing selected yet): begin leaves the cache untouched', () => {
    const queryClient = new QueryClient();
    const original = [makeSession({ session_id: 's1', custom_name: 'Old name' })];
    queryClient.setQueryData(QUERY_KEY, original);

    const { previous } = beginOptimisticRename(queryClient, QUERY_KEY, null, 'New name');

    expect(previous).toBe(original);
    expect(queryClient.getQueryData(QUERY_KEY)).toBe(original);
  });

  test('an empty cache: begin returns undefined, and rolling that back is a no-op', () => {
    const queryClient = new QueryClient();

    const { previous } = beginOptimisticRename(queryClient, QUERY_KEY, 's1', 'New name');
    expect(previous).toBeUndefined();

    rollbackOptimisticRename(queryClient, QUERY_KEY, previous);

    expect(queryClient.getQueryData(QUERY_KEY)).toBeUndefined();
  });
});

/**
 * `onSuccess`'s write. The PATCH response is authoritative for the NAME, and
 * for nothing else: `serializeSession` is called there with no `ownerEmail`,
 * `ownerName`, `runtimeStatus` or `deletedAt`, so a wholesale substitution
 * blanked fields the LIST endpoint had populated.
 */
describe('applyRenameResponse', () => {
  test('renaming a SHARED session does not blank owner_email', () => {
    const cached = makeSession({
      session_id: 's1',
      custom_name: 'Old name',
      name: 'Old name',
      owner_email: 'ada@dosco.live',
      owner_name: 'Ada',
      runtime_status: 'active',
    });
    // Exactly what PATCH /projects/:id/sessions/:id returns: the name fields
    // are real, the resolved-owner fields were never asked for.
    const patched = makeSession({
      session_id: 's1',
      custom_name: 'New name',
      name: 'New name',
      updated_at: '2026-02-02T00:00:00.000Z',
      owner_email: null,
      owner_name: null,
      runtime_status: null,
    });

    const [row] = applyRenameResponse([cached], patched);

    expect(row.custom_name).toBe('New name');
    expect(row.name).toBe('New name');
    expect(row.updated_at).toBe('2026-02-02T00:00:00.000Z');
    // `share-session-modal.tsx` reads owner_email for "shared by X".
    expect(row.owner_email).toBe('ada@dosco.live');
    expect(row.owner_name).toBe('Ada');
    expect(row.runtime_status).toBe('active');
  });

  test('every other row is left byte-identical (same object reference)', () => {
    const other = makeSession({ session_id: 's2', custom_name: 'Untouched' });
    const patched = makeSession({ session_id: 's1', custom_name: 'New name' });

    const result = applyRenameResponse([makeSession({ session_id: 's1' }), other], patched);

    expect(result[1]).toBe(other);
  });

  test('a response for a session that is no longer cached changes nothing', () => {
    const sessions = [makeSession({ session_id: 's1', custom_name: 'Old name' })];

    const result = applyRenameResponse(sessions, makeSession({ session_id: 'gone' }));

    expect(result).toEqual(sessions);
  });
});
