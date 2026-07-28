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

describe('the inset keeps its peer relationship', () => {
  test("SidebarInset still depends on being the sidebar's sibling", () => {
    // If this ever stops being true the guard below is pointless — rewrite it
    // rather than deleting it.
    expect(SIDEBAR_UI).toContain('peer-data-[variant=inset]');
  });

  test('the signed-in shell does not wrap the sidebar in the normal case', () => {
    expect(APP_PROVIDERS).toContain('if (!obActive) return <>{sidebarContent}</>;');
  });

  test('the signed-out shell renders the sidebar unwrapped', () => {
    // Directly inside SidebarProvider, immediately before SidebarInset.
    const provider = ANON_SHELL.indexOf('<SidebarProvider>');
    const sidebar = ANON_SHELL.indexOf('<AnonymousSidebar', provider);
    const inset = ANON_SHELL.indexOf('<SidebarInset>', provider);
    expect(sidebar).toBeGreaterThan(provider);
    expect(inset).toBeGreaterThan(sidebar);
    expect(ANON_SHELL.slice(sidebar, inset)).not.toContain('<div');
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
