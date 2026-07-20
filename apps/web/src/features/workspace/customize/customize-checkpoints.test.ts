import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { menuRegistry } from '@/lib/menu-registry';

const customizePanelSource = readFileSync(join(import.meta.dir, 'customize-panel.tsx'), 'utf8');

describe('Customize information architecture', () => {
  test('Git and Sandbox templates live in Manage without a Workspace group', () => {
    expect(customizePanelSource).not.toContain("label: 'Workspace'");
    expect(customizePanelSource).toContain("section: 'git', label: 'Git'");
    expect(customizePanelSource).toContain("section: 'sandbox', label: 'Sandbox templates'");
    expect(customizePanelSource).not.toContain("section: 'changes'");
    expect(customizePanelSource).not.toContain("section: 'dev'");

    const git = menuRegistry.find((item) => item.id === 'proj-git');
    expect(git?.label).toBe('Customize · Git');
    expect(menuRegistry.find((item) => item.id === 'proj-sandbox')?.label).toBe(
      'Customize · Sandbox templates',
    );
    expect(menuRegistry.find((item) => item.id === 'proj-changes')).toBeUndefined();
  });

  test('Files is not a customize rail section — it lives on the standalone files page', () => {
    expect(customizePanelSource).not.toContain("section: 'files'");
    const entry = menuRegistry.find((item) => item.id === 'proj-files');
    expect(entry?.label).toBe('Files');
    expect(entry?.href).toBe('/projects/{projectId}/files');
  });
});
