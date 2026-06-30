import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { menuRegistry } from '@/lib/menu-registry';

const customizePanelSource = readFileSync(join(import.meta.dir, 'customize-panel.tsx'), 'utf8');

describe('Checkpoints customize section naming', () => {
  test('rail and command palette use Checkpoints instead of Changes', () => {
    expect(customizePanelSource).toContain("label: 'Checkpoints'");
    expect(customizePanelSource).toContain('GitCommitHorizontal');
    const entry = menuRegistry.find((item) => item.id === 'proj-changes');
    expect(entry?.label).toBe('Customize · Checkpoints');
    expect(entry?.keywords).toContain('checkpoint');
  });
});
