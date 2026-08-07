import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { qk } from './query-keys';
import {
  invalidateProject,
  invalidateProjectIdentity,
  restoreProjectName,
  writeProjectNameOptimistically,
} from './invalidate-project';

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const ID = 'proj_1';

type ProjectsListEntry = { project_id: string; name: string };
type ProjectDetailEntry = { project: { project_id: string; name: string } };

describe('invalidateProjectIdentity', () => {
  // The bug this exists to kill: rename invalidated ['projects'] only, so the
  // sidebar (which reads the list) showed the new name while the project home
  // title (which reads the detail) showed the old one, for a full gcTime.
  test('invalidates both the list entry and the detail entry', async () => {
    const qc = client();
    qc.setQueryData(qk.projects.list(), [{ project_id: ID, name: 'Old' }]);
    qc.setQueryData(qk.project.detail(ID), { project: { project_id: ID, name: 'Old' } });

    await invalidateProjectIdentity(qc, ID);

    expect(qc.getQueryState(qk.projects.list())?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.project.detail(ID))?.isInvalidated).toBe(true);
  });

  // qk.projects.list(accountId) and qk.projects.list() are SIBLINGS under
  // qk.projects.scope() — not parent and child (see query-keys.ts's own
  // warning about exactly this). Every real project switcher reads
  // list(accountId), never the accountless list() — so a helper that only
  // ever invalidates list() is a no-op against every real cache. This must
  // reach every account-scoped list form, via the qk.projects.scope() prefix.
  test('invalidates every account-scoped list form, not just the accountless one', async () => {
    const qc = client();
    qc.setQueryData(qk.projects.list('acct_1'), [{ project_id: ID, name: 'Old' }]);
    qc.setQueryData(qk.projects.list('acct_2'), [{ project_id: ID, name: 'Old' }]);
    qc.setQueryData(qk.project.detail(ID), { project: { project_id: ID, name: 'Old' } });

    await invalidateProjectIdentity(qc, ID);

    expect(qc.getQueryState(qk.projects.list('acct_1'))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.projects.list('acct_2'))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.project.detail(ID))?.isInvalidated).toBe(true);
  });

  test('leaves an unrelated project untouched', async () => {
    const qc = client();
    qc.setQueryData(qk.project.detail('other'), { project: { name: 'Other' } });
    await invalidateProjectIdentity(qc, ID);
    expect(qc.getQueryState(qk.project.detail('other'))?.isInvalidated).toBe(false);
  });

  // qk.projects.scope() = ['kx','projects'] and qk.project.scope(id) =
  // ['kx','project', id] diverge at the very first segment ('projects' vs
  // 'project') — a prefix invalidation on the former must never reach the
  // latter, or a rename would invalidate every other project's detail too.
  test('the list-prefix invalidation does not reach an unrelated project detail', async () => {
    const qc = client();
    qc.setQueryData(qk.projects.list('acct_1'), [{ project_id: ID, name: 'Old' }]);
    qc.setQueryData(qk.project.detail('other'), { project: { project_id: 'other', name: 'Other' } });

    await invalidateProjectIdentity(qc, ID);

    expect(qc.getQueryState(qk.project.detail('other'))?.isInvalidated).toBe(false);
  });
});

describe('invalidateProject', () => {
  test('reaches every key under the project scope', async () => {
    const qc = client();
    qc.setQueryData(qk.project.detail(ID), { project: { name: 'A' } });
    qc.setQueryData(qk.project.sessions(ID), []);
    qc.setQueryData(qk.project.connectors(ID), []);

    await invalidateProject(qc, ID);

    for (const key of [
      qk.project.detail(ID),
      qk.project.sessions(ID),
      qk.project.connectors(ID),
    ]) {
      expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
    }
  });
});

describe('writeProjectNameOptimistically', () => {
  test('updates the name in both caches before any request resolves', () => {
    const qc = client();
    qc.setQueryData(qk.projects.list(), [
      { project_id: ID, name: 'Old' },
      { project_id: 'other', name: 'Keep' },
    ]);
    qc.setQueryData(qk.project.detail(ID), { project: { project_id: ID, name: 'Old' } });

    writeProjectNameOptimistically(qc, ID, 'New');

    const list = qc.getQueryData(qk.projects.list()) as Array<{
      project_id: string;
      name: string;
    }>;
    expect(list.find((p) => p.project_id === ID)?.name).toBe('New');
    expect(list.find((p) => p.project_id === 'other')?.name).toBe('Keep');
    expect(
      (qc.getQueryData(qk.project.detail(ID)) as { project: { name: string } }).project.name,
    ).toBe('New');
  });

  // Same sibling-vs-prefix requirement as invalidateProjectIdentity above,
  // but for a WRITE: setQueryData needs an exact key, so this can't just pass
  // the prefix to setQueryData — it has to fan out with setQueriesData.
  test('updates the project everywhere it is cached, across every account-scoped list', () => {
    const qc = client();
    qc.setQueryData(qk.projects.list('acct_1'), [{ project_id: ID, name: 'Old' }]);
    qc.setQueryData(qk.projects.list('acct_2'), [
      { project_id: ID, name: 'Old' },
      { project_id: 'other', name: 'Keep' },
    ]);

    writeProjectNameOptimistically(qc, ID, 'New');

    const acct1 = qc.getQueryData(qk.projects.list('acct_1')) as Array<{
      project_id: string;
      name: string;
    }>;
    const acct2 = qc.getQueryData(qk.projects.list('acct_2')) as Array<{
      project_id: string;
      name: string;
    }>;
    expect(acct1.find((p) => p.project_id === ID)?.name).toBe('New');
    expect(acct2.find((p) => p.project_id === ID)?.name).toBe('New');
    expect(acct2.find((p) => p.project_id === 'other')?.name).toBe('Keep');
  });

  test('is a no-op when neither cache is populated', () => {
    const qc = client();
    expect(() => writeProjectNameOptimistically(qc, ID, 'New')).not.toThrow();
    expect(qc.getQueryData(qk.project.detail(ID))).toBeUndefined();
  });

  test('returns a snapshot of exactly what it overwrote, restorable by restoreProjectName', () => {
    const qc = client();
    qc.setQueryData(qk.projects.list('acct_1'), [{ project_id: ID, name: 'Old' }]);
    qc.setQueryData(qk.project.detail(ID), { project: { project_id: ID, name: 'Old' } });

    const snapshot = writeProjectNameOptimistically(qc, ID, 'New');
    restoreProjectName(qc, ID, snapshot);

    expect(qc.getQueryData<ProjectsListEntry[]>(qk.projects.list('acct_1'))).toEqual([
      { project_id: ID, name: 'Old' },
    ]);
    expect(qc.getQueryData<ProjectDetailEntry>(qk.project.detail(ID))).toEqual({
      project: { project_id: ID, name: 'Old' },
    });
  });
});

describe('restoreProjectName', () => {
  // THE Critical-path test: a rename that fails must not leave the wrong name
  // permanently cached. onMutate writes optimistically, onError must put back
  // exactly what was there before.
  test('rolls back a failed rename to the exact prior name, everywhere it was cached', () => {
    const qc = client();
    qc.setQueryData(qk.projects.list('acct_1'), [
      { project_id: ID, name: 'Original' },
      { project_id: 'other', name: 'Untouched' },
    ]);
    qc.setQueryData(qk.projects.list('acct_2'), [{ project_id: ID, name: 'Original' }]);
    qc.setQueryData(qk.project.detail(ID), { project: { project_id: ID, name: 'Original' } });

    const snapshot = writeProjectNameOptimistically(qc, ID, 'Optimistic-New');
    // Simulate the mutation rejecting.
    restoreProjectName(qc, ID, snapshot);

    expect(qc.getQueryData<ProjectsListEntry[]>(qk.projects.list('acct_1'))).toEqual([
      { project_id: ID, name: 'Original' },
      { project_id: 'other', name: 'Untouched' },
    ]);
    expect(qc.getQueryData<ProjectsListEntry[]>(qk.projects.list('acct_2'))).toEqual([
      { project_id: ID, name: 'Original' },
    ]);
    expect(qc.getQueryData<ProjectDetailEntry>(qk.project.detail(ID))).toEqual({
      project: { project_id: ID, name: 'Original' },
    });
  });

  // If nothing was cached when the optimistic write happened, restoring must
  // not fabricate an entry — a plain writeProjectNameOptimistically no-op is
  // just as much a "nothing to restore" case as an explicit empty snapshot.
  test('is a no-op when the snapshot captured nothing', () => {
    const qc = client();
    const snapshot = writeProjectNameOptimistically(qc, ID, 'New');
    expect(() => restoreProjectName(qc, ID, snapshot)).not.toThrow();
    expect(qc.getQueryData(qk.project.detail(ID))).toBeUndefined();
    expect(qc.getQueryData(qk.projects.list())).toBeUndefined();
  });

  // A key that appeared AFTER the snapshot was taken (e.g. the user switched
  // to a different account while the rename was in flight) must not be
  // touched by the rollback — restoreProjectName only knows about the keys
  // that existed at snapshot time.
  test('does not touch a list key that did not exist when the snapshot was taken', () => {
    const qc = client();
    qc.setQueryData(qk.projects.list('acct_1'), [{ project_id: ID, name: 'Original' }]);
    const snapshot = writeProjectNameOptimistically(qc, ID, 'Optimistic-New');

    // A different account's list gets fetched for the first time mid-flight.
    qc.setQueryData(qk.projects.list('acct_2'), [{ project_id: ID, name: 'Optimistic-New' }]);

    restoreProjectName(qc, ID, snapshot);

    expect(qc.getQueryData<ProjectsListEntry[]>(qk.projects.list('acct_1'))).toEqual([
      { project_id: ID, name: 'Original' },
    ]);
    // Untouched — restoreProjectName never saw this key.
    expect(qc.getQueryData<ProjectsListEntry[]>(qk.projects.list('acct_2'))).toEqual([
      { project_id: ID, name: 'Optimistic-New' },
    ]);
  });
});
