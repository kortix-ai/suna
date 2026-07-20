import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'project-create-modal.tsx'), 'utf8');

describe('new project git provider default', () => {
  test('starts with a user GitHub repository and keeps managed git explicit', () => {
    expect(source).toContain("'github-create' | 'github-import' | 'managed' | 'template'");
    expect(source).toMatch(/useState<[\s\S]*?>\(\s*'github-create'/);
    expect(source).toContain('createProjectRepo');
    expect(source).toContain('Create in your GitHub');
    expect(source).toContain('Managed by Kortix');
  });

  test('keeps a selected marketplace template on the GitHub create path', () => {
    const start = source.indexOf('githubCreateMutation.mutate({');
    const end = source.indexOf('});', start);
    expect(source.slice(start, end)).toContain('source_item_id: effectiveSourceItemId');
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
});
