import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { useSettingsPanelStore } from '@/stores/settings-panel-store';
import { SettingsPanel } from './settings-panel';

/**
 * project-shell.tsx mounts SettingsPanel on every project page. Before the
 * split, the panel's static imports (every tab, both icon pickers) shipped
 * with the project home — on dev the largest chunk alone was 338 KB decoded.
 */
describe('SettingsPanel mount point', () => {
  afterEach(() => useSettingsPanelStore.setState({ open: false }));

  test('imports no tab and no body statically', () => {
    const source = readFileSync(join(import.meta.dir, 'settings-panel.tsx'), 'utf8');
    const staticImports = source.match(/^import [^;]+;$/gm) ?? [];
    for (const line of staticImports) {
      expect(line, line).not.toMatch(/settings-panel-body|\/tabs\/|project-icon|glyph|emoji/);
    }
    expect(source).toContain("import('./settings-panel-body')");
  });

  test('the panel body loader carries the stale-chunk recovery (KRTX-1616)', () => {
    // A pin, like the test above: the recovery lives inside the loader, so a
    // refactor that drops the wrapper silently reopens the stale-deploy error
    // page. Behavior is covered in lib/chunk-reload.test.ts.
    const source = readFileSync(join(import.meta.dir, 'settings-panel.tsx'), 'utf8');
    expect(source).toContain("withStaleChunkRecovery(() => import('./settings-panel-body')");
  });

  test('renders nothing while Settings has never been opened', () => {
    useSettingsPanelStore.setState({ open: false });
    expect(renderToStaticMarkup(<SettingsPanel projectId="p" />)).toBe('');
  });
});
