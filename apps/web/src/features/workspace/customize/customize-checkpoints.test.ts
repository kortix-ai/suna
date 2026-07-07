import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { menuRegistry } from '@/lib/menu-registry';

const customizePanelSource = readFileSync(join(import.meta.dir, 'customize-panel.tsx'), 'utf8');

describe('Changes customize section naming', () => {
  test('rail and command palette use plain "Changes" instead of git jargon', () => {
    expect(customizePanelSource).toContain("label: 'Changes'");
    expect(customizePanelSource).not.toContain("label: 'Checkpoints'");
    expect(customizePanelSource).not.toContain('GitCommitHorizontal');
    const entry = menuRegistry.find((item) => item.id === 'proj-changes');
    expect(entry?.label).toBe('Customize · Changes');
    expect(entry?.keywords).toContain('checkpoint');
    expect(entry?.keywords).toContain('proposed');
  });

  test('Files is not a customize rail section — it lives on the standalone files page', () => {
    expect(customizePanelSource).not.toContain("section: 'files'");
    const entry = menuRegistry.find((item) => item.id === 'proj-files');
    expect(entry?.label).toBe('Files');
    expect(entry?.href).toBe('/projects/{projectId}/files');
  });
});
