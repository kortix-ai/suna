import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { qk } from '@kortix/sdk/react';

import { renameOnError, renameOnMutate, renameOnSettled } from './project-rename-cache';

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const ID = 'proj_1';

/**
 * These are the EXACT functions `edit-project-modal.tsx` and
 * `settings-view.tsx` wire into `useMutation({ onMutate, onError, onSettled })`
 * — see the source-scan assertions in `edit-project-modal.rename.test.tsx`
 * and `settings-view.rename.test.tsx` that pin the wiring itself. This file
 * covers what the functions those two components call actually DO, against a
 * real QueryClient — no react-query mocking (mocking `@tanstack/react-query`
 * here would be process-wide across `bun test`'s non---isolate run in
 * `apps/web` and corrupt every other test file in the run).
 */
describe('renameOnMutate', () => {
  test('writes the optimistic name and returns a restorable snapshot', () => {
    const qc = client();
    qc.setQueryData(qk.projects.list('acct_1'), [{ project_id: ID, name: 'Old' }]);
    qc.setQueryData(qk.project.detail(ID), { project: { project_id: ID, name: 'Old' } });

    const context = renameOnMutate(qc, ID, 'New');

    expect(context).toBeDefined();
    expect(qc.getQueryData(qk.projects.list('acct_1'))).toEqual([
      { project_id: ID, name: 'New' },
    ]);
    expect(qc.getQueryData(qk.project.detail(ID))).toEqual({
      project: { project_id: ID, name: 'New' },
    });
  });

  test('is a no-op and returns undefined for an icon-only edit (no name in the patch)', () => {
    const qc = client();
    qc.setQueryData(qk.project.detail(ID), { project: { project_id: ID, name: 'Old' } });

    const context = renameOnMutate(qc, ID, undefined);

    expect(context).toBeUndefined();
    expect(qc.getQueryData(qk.project.detail(ID))).toEqual({
      project: { project_id: ID, name: 'Old' },
    });
  });

  test('is a no-op and returns undefined without a projectId', () => {
    const qc = client();
    expect(renameOnMutate(qc, null, 'New')).toBeUndefined();
    expect(renameOnMutate(qc, undefined, 'New')).toBeUndefined();
  });
});

describe('renameOnError — the Critical rollback path', () => {
  // A failed rename must not leave the wrong name permanently cached. Before
  // this fix, onMutate wrote optimistically but nothing ever restored the
  // prior value on failure — and with refetchOnMount:false (also fixed
  // separately), invalidateQueries never self-healed an unmounted observer
  // either. The wrong name was permanent until a hard refresh.
  test('restores the exact prior name everywhere it was cached', () => {
    const qc = client();
    qc.setQueryData(qk.projects.list('acct_1'), [
      { project_id: ID, name: 'Original' },
      { project_id: 'other', name: 'Untouched' },
    ]);
    qc.setQueryData(qk.project.detail(ID), { project: { project_id: ID, name: 'Original' } });

    const context = renameOnMutate(qc, ID, 'Optimistic-New');
    // The server rejected the rename.
    renameOnError(qc, ID, context);

    expect(qc.getQueryData(qk.projects.list('acct_1'))).toEqual([
      { project_id: ID, name: 'Original' },
      { project_id: 'other', name: 'Untouched' },
    ]);
    expect(qc.getQueryData(qk.project.detail(ID))).toEqual({
      project: { project_id: ID, name: 'Original' },
    });
  });

  test('is a no-op when context is undefined (renameOnMutate wrote nothing)', () => {
    const qc = client();
    qc.setQueryData(qk.project.detail(ID), { project: { project_id: ID, name: 'Original' } });

    expect(() => renameOnError(qc, ID, undefined)).not.toThrow();

    expect(qc.getQueryData(qk.project.detail(ID))).toEqual({
      project: { project_id: ID, name: 'Original' },
    });
  });
});

describe('renameOnSettled', () => {
  test('invalidates every account-scoped list and the detail entry', async () => {
    const qc = client();
    qc.setQueryData(qk.projects.list('acct_1'), [{ project_id: ID, name: 'New' }]);
    qc.setQueryData(qk.project.detail(ID), { project: { project_id: ID, name: 'New' } });

    await renameOnSettled(qc, ID);

    expect(qc.getQueryState(qk.projects.list('acct_1'))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.project.detail(ID))?.isInvalidated).toBe(true);
  });

  test('is a no-op without a projectId', () => {
    const qc = client();
    expect(() => renameOnSettled(qc, null)).not.toThrow();
    expect(() => renameOnSettled(qc, undefined)).not.toThrow();
  });
});

describe('the full success and failure round trips', () => {
  test('success: optimistic write survives settle-time invalidation until refetch', async () => {
    const qc = client();
    qc.setQueryData(qk.projects.list('acct_1'), [{ project_id: ID, name: 'Old' }]);
    qc.setQueryData(qk.project.detail(ID), { project: { project_id: ID, name: 'Old' } });

    const context = renameOnMutate(qc, ID, 'New');
    expect(context).toBeDefined();
    await renameOnSettled(qc, ID);

    // The optimistic value is still what's rendered; invalidation only marks
    // it stale for the next observed refetch, it doesn't overwrite it.
    expect(qc.getQueryData(qk.projects.list('acct_1'))).toEqual([
      { project_id: ID, name: 'New' },
    ]);
    expect(qc.getQueryState(qk.projects.list('acct_1'))?.isInvalidated).toBe(true);
  });

  test('failure: rollback then settle leaves the ORIGINAL name, invalidated', async () => {
    const qc = client();
    qc.setQueryData(qk.projects.list('acct_1'), [{ project_id: ID, name: 'Original' }]);
    qc.setQueryData(qk.project.detail(ID), { project: { project_id: ID, name: 'Original' } });

    const context = renameOnMutate(qc, ID, 'Optimistic-New');
    renameOnError(qc, ID, context);
    await renameOnSettled(qc, ID);

    expect(qc.getQueryData(qk.projects.list('acct_1'))).toEqual([
      { project_id: ID, name: 'Original' },
    ]);
    expect(qc.getQueryData(qk.project.detail(ID))).toEqual({
      project: { project_id: ID, name: 'Original' },
    });
    expect(qc.getQueryState(qk.projects.list('acct_1'))?.isInvalidated).toBe(true);
  });
});
