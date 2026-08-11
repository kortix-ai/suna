import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The workspace-files barrel re-enters features/files through useChangeRequests.
// Keep this import concrete because workspaceFileSource reads it during module
// evaluation.
test('file-source imports FilePathBreadcrumbs directly, never through the barrel', () => {
  const source = readFileSync(join(import.meta.dir, 'file-source.tsx'), 'utf8');
  expect(source).toContain("from '@/features/workspace-files/components/file-breadcrumbs'");
  expect(source).not.toMatch(/from '@\/features\/project-files';/);
});
