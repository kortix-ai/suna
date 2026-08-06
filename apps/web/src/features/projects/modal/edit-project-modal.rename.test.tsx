import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import {
  qk,
  invalidateProjectIdentity,
  writeProjectNameOptimistically,
} from '@kortix/sdk/react';

const ID = 'proj_1';

describe('project rename cache contract', () => {
  // Before this, rename invalidated ['projects'] alone. The sidebar reads the
  // list and showed the new name; the project home title reads the detail and
  // showed the old one until eviction. A hard refresh made them agree, which
  // is what made it look like a render bug rather than a cache bug.
  test('a rename updates the name in both caches', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(qk.projects.list(), [{ project_id: ID, name: 'Old' }]);
    qc.setQueryData(qk.project.detail(ID), { project: { project_id: ID, name: 'Old' } });

    writeProjectNameOptimistically(qc, ID, 'New');

    const list = qc.getQueryData(qk.projects.list()) as Array<{ name: string }>;
    const detail = qc.getQueryData(qk.project.detail(ID)) as { project: { name: string } };
    expect(list[0].name).toBe('New');
    expect(detail.project.name).toBe('New');

    await invalidateProjectIdentity(qc, ID);
    expect(qc.getQueryState(qk.projects.list())?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.project.detail(ID))?.isInvalidated).toBe(true);
  });

  // Guards the actual regression, not just the helper: an unrelated project's
  // cache entries must not move when this project renames.
  test('leaves an unrelated project untouched', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const OTHER = 'proj_2';
    qc.setQueryData(qk.projects.list(), [
      { project_id: ID, name: 'Old' },
      { project_id: OTHER, name: 'Keep' },
    ]);
    qc.setQueryData(qk.project.detail(OTHER), { project: { project_id: OTHER, name: 'Keep' } });

    writeProjectNameOptimistically(qc, ID, 'New');
    await invalidateProjectIdentity(qc, ID);

    const list = qc.getQueryData(qk.projects.list()) as Array<{
      project_id: string;
      name: string;
    }>;
    expect(list.find((p) => p.project_id === OTHER)?.name).toBe('Keep');
    expect(qc.getQueryState(qk.project.detail(OTHER))?.isInvalidated).toBe(false);
  });
});
