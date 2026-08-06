import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { qk } from './query-keys';
import {
  invalidateProject,
  invalidateProjectIdentity,
  writeProjectNameOptimistically,
} from './invalidate-project';

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const ID = 'proj_1';

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

  test('leaves an unrelated project untouched', async () => {
    const qc = client();
    qc.setQueryData(qk.project.detail('other'), { project: { name: 'Other' } });
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

  test('is a no-op when neither cache is populated', () => {
    const qc = client();
    expect(() => writeProjectNameOptimistically(qc, ID, 'New')).not.toThrow();
    expect(qc.getQueryData(qk.project.detail(ID))).toBeUndefined();
  });
});
