// The sidebar's Files entry follows the organization's Volumes switch: off, it
// is the repo browser (the product before volumes); on, Files is the project
// drive and the repo browser is Repo.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { repoNavLabel } from './files-nav-label';

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');

describe('sidebar Files label', () => {
  test('Volumes off: Files is the repo browser; on: Files is the drive and the repo browser is Repo', () => {
    expect(repoNavLabel(false)).toBe('files');
    expect(repoNavLabel(true)).toBe('repo');

    const repoNav = read('./project-files-nav.tsx');
    expect(repoNav).toContain("useFeatureFlag(projectId, 'drives')");
    expect(repoNav).toContain('repoNavLabel(volumes.enabled)');
    expect(repoNav).toContain('href={`/projects/${projectId}/files`}');

    // The shared folders are the Files tab under Customize, only with Volumes on.
    const tabs = read('../../capabilities/shared/capability-tabs.tsx');
    expect(tabs).toContain("useFeatureFlag(projectId, 'drives')");
  });
});
