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

  test('rail lists Files before Changes in the Workspace group', () => {
    const filesIdx = customizePanelSource.indexOf("section: 'files'");
    const changesIdx = customizePanelSource.indexOf("section: 'changes'");
    expect(filesIdx).toBeGreaterThan(-1);
    expect(changesIdx).toBeGreaterThan(-1);
    expect(filesIdx).toBeLessThan(changesIdx);
  });
});
