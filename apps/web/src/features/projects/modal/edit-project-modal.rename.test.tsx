import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QueryClient } from '@tanstack/react-query';
import { qk } from '@kortix/sdk/react';

import {
  renameOnError,
  renameOnMutate,
  renameOnSettled,
} from '@/hooks/projects/project-rename-cache';

const ID = 'proj_1';

/**
 * `EditProjectModal` cannot be rendered or driven interactively in this
 * harness: `apps/web`'s `bun test` runs WITHOUT `--isolate`
 * (`suna-web-test-isolation`), so a `mock.module('@tanstack/react-query', …)`
 * here would be PROCESS-WIDE and corrupt every other file in the same run —
 * exactly the reason `project-switcher-icon.test.tsx` already gives for not
 * rendering `ProjectSwitcher` directly. There is also no jsdom/
 * `@testing-library/react` in this repo's test setup, so there is no
 * `fireEvent`-style path either.
 *
 * SPLIT INTO TWO HALVES the same way that file is, and for the same reason —
 * neither half alone proves the fix, together they cover the whole path:
 *
 *   1. The source scan below pins that `EditProjectModal`'s `saveMutation`
 *      wires `onMutate`/`onError`/`onSettled` to the shared
 *      `renameOnMutate`/`renameOnError`/`renameOnSettled` functions, with the
 *      right arguments — so this test fails if the wiring is ever silently
 *      reverted to a local no-op, which is exactly the gap a
 *      helpers-in-isolation test cannot see.
 *   2. `project-rename-cache.test.ts` proves what those exact functions DO —
 *      including the Critical rollback path — against a real QueryClient.
 *
 * The cache-contract tests below additionally pin the underlying two-cache
 * behavior directly, independent of which component calls it.
 */
const source = readFileSync(
  join(import.meta.dir, 'edit-project-modal.tsx'),
  'utf8',
);
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const mutationStart = code.indexOf('useMutation({');
const mutationEnd = code.indexOf('});', mutationStart);
const mutationBlock =
  mutationStart < 0 || mutationEnd < 0 ? '' : code.slice(mutationStart, mutationEnd);

describe('EditProjectModal: the source the component actually renders', () => {
  test('the scan found the save mutation', () => {
    // Guard the guards, same reasoning as project-switcher-icon.test.tsx: an
    // empty string passes every `.not.toContain` below silently.
    expect(mutationBlock.length).toBeGreaterThan(0);
    expect(mutationBlock).toContain('mutationFn:');
  });

  test('onMutate is wired to the shared renameOnMutate, not a local write', () => {
    expect(mutationBlock).toMatch(
      /onMutate:\s*\(patch\)\s*=>\s*renameOnMutate\(queryClient,\s*projectId,\s*patch\.name\)/,
    );
  });

  test('onError is wired to the shared renameOnError — the rollback call', () => {
    const onErrorStart = mutationBlock.indexOf('onError:');
    const onErrorBlock = mutationBlock.slice(onErrorStart, mutationBlock.indexOf('onSettled:'));
    expect(onErrorBlock).toContain('renameOnError(queryClient, projectId, context)');
  });

  test('onSettled is wired to the shared renameOnSettled', () => {
    expect(mutationBlock).toMatch(/onSettled:\s*\(\)\s*=>\s*renameOnSettled\(queryClient,\s*projectId\)/);
  });
});

describe('project rename cache contract', () => {
  // Before this, rename invalidated ['projects'] alone. The sidebar reads the
  // list and showed the new name; the project home title reads the detail and
  // showed the old one until eviction. A hard refresh made them agree, which
  // is what made it look like a render bug rather than a cache bug.
  test('a rename updates the name in both caches, then invalidates both', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(qk.projects.list('acct_1'), [{ project_id: ID, name: 'Old' }]);
    qc.setQueryData(qk.project.detail(ID), { project: { project_id: ID, name: 'Old' } });

    const context = renameOnMutate(qc, ID, 'New');

    const list = qc.getQueryData(qk.projects.list('acct_1')) as Array<{ name: string }>;
    const detail = qc.getQueryData(qk.project.detail(ID)) as { project: { name: string } };
    expect(list[0].name).toBe('New');
    expect(detail.project.name).toBe('New');

    await renameOnSettled(qc, ID);
    expect(qc.getQueryState(qk.projects.list('acct_1'))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.project.detail(ID))?.isInvalidated).toBe(true);
    // No rollback needed on the success path.
    expect(context).toBeDefined();
  });

  // THE Critical path: a rejected rename must not leave the wrong name
  // permanently cached.
  test('a REJECTED rename rolls the name back in both caches', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(qk.projects.list('acct_1'), [{ project_id: ID, name: 'Old' }]);
    qc.setQueryData(qk.project.detail(ID), { project: { project_id: ID, name: 'Old' } });

    const context = renameOnMutate(qc, ID, 'New');
    renameOnError(qc, ID, context);

    const list = qc.getQueryData(qk.projects.list('acct_1')) as Array<{ name: string }>;
    const detail = qc.getQueryData(qk.project.detail(ID)) as { project: { name: string } };
    expect(list[0].name).toBe('Old');
    expect(detail.project.name).toBe('Old');
  });

  // Guards the actual regression, not just the helper: an unrelated project's
  // cache entries must not move when this project renames.
  test('leaves an unrelated project untouched', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const OTHER = 'proj_2';
    qc.setQueryData(qk.projects.list('acct_1'), [
      { project_id: ID, name: 'Old' },
      { project_id: OTHER, name: 'Keep' },
    ]);
    qc.setQueryData(qk.project.detail(OTHER), { project: { project_id: OTHER, name: 'Keep' } });

    renameOnMutate(qc, ID, 'New');
    await renameOnSettled(qc, ID);

    const list = qc.getQueryData(qk.projects.list('acct_1')) as Array<{
      project_id: string;
      name: string;
    }>;
    expect(list.find((p) => p.project_id === OTHER)?.name).toBe('Keep');
    expect(qc.getQueryState(qk.project.detail(OTHER))?.isInvalidated).toBe(false);
  });
});
