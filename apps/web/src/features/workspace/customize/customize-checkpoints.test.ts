import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { menuRegistry } from '@/lib/menu-registry';

const customizePanelSource = readFileSync(join(import.meta.dir, 'customize-panel.tsx'), 'utf8');
// WS5-P5-a extracted the rail groups (including the "Changes" item this
// suite pins) out of customize-panel.tsx into their own testable module —
// see `rail-groups.ts`. The rail source these assertions care about is the
// union of both files now, not customize-panel.tsx alone.
const railGroupsSource = readFileSync(join(import.meta.dir, 'rail-groups.ts'), 'utf8');
const railSource = customizePanelSource + railGroupsSource;

describe('Changes customize section naming', () => {
  test('rail and command palette use plain "Changes" instead of git jargon', () => {
    expect(railSource).toContain("label: 'Changes'");
    expect(railSource).not.toContain("label: 'Checkpoints'");
    expect(railSource).not.toContain('GitCommitHorizontal');
    const entry = menuRegistry.find((item) => item.id === 'proj-changes');
    expect(entry?.label).toBe('Customize · Changes');
    expect(entry?.keywords).toContain('checkpoint');
    expect(entry?.keywords).toContain('proposed');
  });

  test('Files is not a customize rail section — it lives on the standalone files page', () => {
    expect(railSource).not.toContain("section: 'files'");
    const entry = menuRegistry.find((item) => item.id === 'proj-files');
    expect(entry?.label).toBe('Files');
    expect(entry?.href).toBe('/projects/{projectId}/files');
  });
});
