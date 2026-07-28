import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The signed-in and signed-out shells must render the SAME shell.
 *
 * They kept drifting for invisible reasons — the last one being DOM nesting:
 * SidebarInset styles itself with `md:peer-data-[variant=inset]:rounded-xl`,
 * and `peer-*` is a sibling combinator, so an extra wrapper element between
 * <Sidebar> and <SidebarInset> silently removed the rounded inset on one side
 * only. Nothing about that is visible in either component.
 *
 * These are structural guards, not style assertions.
 */

const SRC = join(import.meta.dir, '..', '..');
const APP_PROVIDERS = readFileSync(join(SRC, 'features/layout/app-providers.tsx'), 'utf8');
const ANON_SHELL = readFileSync(join(SRC, 'features/home/anonymous-home-shell.tsx'), 'utf8');
const SIDEBAR_UI = readFileSync(join(SRC, 'components/ui/sidebar.tsx'), 'utf8');

describe('both shells wrap the sidebar the same way', () => {
  const CHROME = readFileSync(
    join(SRC, 'features/workspace/project-sidebar/sidebar-chrome.tsx'),
    'utf8',
  );

  test('the wrapper is load-bearing and both shells have one', () => {
    // SidebarInset's rounded panel hangs off `peer-data-[variant=inset]`, a
    // sibling combinator. The wrapper defeats it, which is why prod renders
    // flat. A shell missing the wrapper renders a rounded panel the other
    // never has.
    expect(SIDEBAR_UI).toContain('peer-data-[variant=inset]');
    expect(CHROME).toContain('variant="inset"');
    expect(APP_PROVIDERS).toContain('data-slot="sidebar-left-slot"');
    expect(ANON_SHELL).toContain('<SidebarSlot>');
  });

  test('the wrapper is shared, not copied', () => {
    expect(CHROME).toContain('export function SidebarSlot');
  });
});

describe('both shells use the shared chrome', () => {
  const SHARED = ['SidebarProvider', 'SidebarInset', 'ShellInset'];

  for (const symbol of SHARED) {
    test(`the signed-out shell renders through ${symbol}`, () => {
      expect(ANON_SHELL).toContain(symbol);
    });
  }

  test('the signed-in shell renders through the same inset', () => {
    expect(APP_PROVIDERS).toContain('SidebarInset');
  });
});
