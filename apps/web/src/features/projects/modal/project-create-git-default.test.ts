import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'project-create-modal.tsx'), 'utf8');

describe('new project git provider default', () => {
  test('starts with a managed repository and keeps user GitHub explicit', () => {
    expect(source).toContain("'github-create' | 'github-import' | 'managed' | 'template'");
    expect(source).toMatch(/useState<[\s\S]*?>\(\s*'managed'/);
    expect(source).toContain('createProjectRepo');
    expect(source).toContain('Create in your GitHub');
    expect(source).not.toContain('Code Storage');
    expect(source).not.toMatch(/<GitFork className="size-4" \/> Managed by Kortix/);
  });

  test('keeps a selected marketplace template on the managed path', () => {
    expect(source).toMatch(/function pickTemplate[\s\S]*?setMode\('managed'\)/);
  });

  test('uses current project-modal list and radius primitives', () => {
    expect(source).not.toContain('@/components/ui/list');
    expect(source).not.toContain('rounded-2xl');
  });

  test('does not mistake the managed PAT import fallback for a GitHub App installation', () => {
    expect(source).toContain('isGitHubAppInstallationId');
    expect(source).toContain('githubAppInstallations');
    expect(source).toContain('installation_id: selectedInstallationId');
  });

  test('searches large GitHub owners remotely and exposes repository load failures', () => {
    expect(source).toContain('useDebounce(repositorySearch.trim(), 300)');
    expect(source).toContain("search: debouncedRepositorySearch || undefined");
    expect(source).toContain('onSearchChange={setRepositorySearch}');
    expect(source).toContain('githubReposQuery.isError');
    expect(source).toContain('Could not load repositories');
    expect(source).toContain('githubReposQuery.refetch()');
  });
});
