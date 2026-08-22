import { describe, expect, test } from 'bun:test';

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
