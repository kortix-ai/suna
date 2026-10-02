import { describe, expect, test } from 'bun:test';
import { runtimeSupports } from '@kortix/sdk';

import { LEGACY_PALETTE_HIDDEN } from '@/features/workspace/command-palette-visibility';
import { menuRegistry } from '@/lib/menu-registry';

describe('session maintenance command palette actions', () => {
  test('exposes config reload and agent branch reconciliation only for active sessions', () => {
    for (const id of ['restart-config', 'sync-session-branch']) {
      const item = menuRegistry.find((entry) => entry.id === id);

      expect(item?.showIn).toContain('commandPalette');
      expect(item?.requiresSession).toBe(true);
      expect(LEGACY_PALETTE_HIDDEN.has(id)).toBe(false);
    }
  });
});

describe('runtime-gated command palette actions (E1)', () => {
  test('Compact Session needs a runtime that compacts on demand, so a pi session never offers it', () => {
    const compact = menuRegistry.find((entry) => entry.id === 'compact-session');
    expect(compact?.requiresRuntime).toBe('session.compact');
    const pi = ['file.import', 'file.append', 'session.subagents'];
    expect(runtimeSupports(pi, compact!.requiresRuntime!)).toBe(false);
    expect(runtimeSupports([...pi, 'session.compact'], compact!.requiresRuntime!)).toBe(true);
  });

  test('the palette drops a row whose runtime capability is absent', async () => {
    const source = await Bun.file(new URL('./command-palette.tsx', import.meta.url)).text();
    expect(source).toContain(
      'if (item.requiresRuntime && !runtimeSupports(runtimeCapabilities, item.requiresRuntime)) continue;',
    );
  });
});
