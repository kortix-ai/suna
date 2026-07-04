import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sidebarSource = readFileSync(join(import.meta.dir, 'project-sidebar.tsx'), 'utf8');
const filesNavSource = readFileSync(join(import.meta.dir, 'project-files-nav.tsx'), 'utf8');

describe('sidebar Files entry', () => {
  test('sidebar renders the Files rail item in collapsed state', () => {
    expect(sidebarSource).toContain('<ProjectFilesRailItem />');
  });

  test('Files item jumps straight to the customize Files section', () => {
    expect(filesNavSource).toContain("openCustomize('files')");
  });
});
