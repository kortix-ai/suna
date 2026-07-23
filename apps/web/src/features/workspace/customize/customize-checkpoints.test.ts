import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { menuRegistry } from '@/lib/menu-registry';

const customizePanelSource = readFileSync(join(import.meta.dir, 'customize-panel.tsx'), 'utf8');
// WS5-P5-a extracted the rail groups out of customize-panel.tsx into their
// own testable module — see `rail-groups.ts`. The rail source these
// assertions care about is the union of both files now, not
// customize-panel.tsx alone.
const railGroupsSource = readFileSync(join(import.meta.dir, 'rail-groups.ts'), 'utf8');
const railSource = customizePanelSource + railGroupsSource;

describe('Customize information architecture', () => {
  test('Git and Sandbox templates live in Manage without a Workspace group', () => {
    expect(railSource).not.toContain("label: 'Workspace'");
    expect(railSource).toContain("section: 'git', label: 'Git'");
    expect(railSource).toContain("section: 'sandbox', label: 'Sandbox templates'");
    expect(railSource).not.toContain("section: 'changes'");
    expect(railSource).not.toContain("section: 'dev'");

    const git = menuRegistry.find((item) => item.id === 'proj-git');
    expect(git?.label).toBe('Customize · Git');
    expect(menuRegistry.find((item) => item.id === 'proj-sandbox')?.label).toBe(
      'Customize · Sandbox templates',
    );
    expect(menuRegistry.find((item) => item.id === 'proj-changes')).toBeUndefined();
  });

  test('Files is not a customize rail section — it lives on the standalone files page', () => {
    expect(railSource).not.toContain("section: 'files'");
    const entry = menuRegistry.find((item) => item.id === 'proj-files');
    expect(entry?.label).toBe('Files');
    expect(entry?.href).toBe('/projects/{projectId}/files');
  });
});
