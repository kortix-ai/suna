import { describe, expect, test } from 'bun:test';
import { runtimeSupports } from '@kortix/sdk';

import {
  LEGACY_PALETTE_HIDDEN,
  paletteRowPermitted,
  reviewPaletteRows,
} from '@/features/workspace/command-palette-visibility';
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

// A palette row is offered only when the caller can act on it: an account row
// follows its hub section, a project row the sidebar row it mirrors.
describe('paletteRowPermitted', () => {
  const byId = (id: string) => menuRegistry.find((entry) => entry.id === id)!;
  const member = {
    accountSections: { members: true, transactions: true, 'access-projects': true, help: true },
    rows: { 'proj-customize': false, 'proj-files': false, 'proj-apps': false, 'proj-invite': false },
  };

  test('a plain member sees no account section they cannot open', () => {
    const accountRows = menuRegistry.filter((e) => e.kind === 'account' && e.accountTab);
    expect(accountRows.length).toBeGreaterThan(0);
    const offered = accountRows.filter((e) => paletteRowPermitted(e, member)).map((e) => e.accountTab);
    expect(offered.sort()).toEqual(['access-projects', 'help', 'members', 'transactions']);
  });

  test('project rows follow the sidebar verdicts, and ungated rows stay', () => {
    for (const id of ['proj-customize', 'proj-files', 'proj-apps', 'proj-invite']) {
      expect(paletteRowPermitted(byId(id), member)).toBe(false);
      expect(paletteRowPermitted(byId(id), { ...member, rows: { [id]: true } })).toBe(true);
    }
    expect(paletteRowPermitted(byId('proj-sessions'), member)).toBe(true);
    expect(paletteRowPermitted(byId('nav-accounts'), member)).toBe(true);
  });
});

describe('Review palette access after leaving Customize', () => {
  const allowed = { allowed: true, isLoading: false, isError: false };

  test('navigation Review and review-changes require settled READ + ACT', () => {
    expect(reviewPaletteRows(allowed, allowed)).toEqual({
      'proj-review-inbox': true,
      'review-changes': true,
    });
  });

  test('both rows deny absent, denied, loading or erroring READ or ACT, including stale allows', () => {
    for (const probe of [undefined, { ...allowed, allowed: false }, { ...allowed, isLoading: true }, { ...allowed, isError: true }]) {
      const denied = { 'proj-review-inbox': false, 'review-changes': false };
      expect(reviewPaletteRows(probe, allowed)).toEqual(denied);
      expect(reviewPaletteRows(allowed, probe)).toEqual(denied);
    }
  });
});
