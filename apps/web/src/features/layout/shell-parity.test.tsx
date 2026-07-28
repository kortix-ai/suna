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

describe('the shell does not claim a variant it never renders', () => {
  const CHROME = readFileSync(
    join(SRC, 'features/workspace/project-sidebar/sidebar-chrome.tsx'),
    'utf8',
  );

  test('the sidebar is not the inset variant', () => {
    // `variant="inset"` asks SidebarInset for a floating rounded panel via
    // `peer-data-[variant=inset]` — a sibling combinator that AppProviders'
    // wrapper defeats. The app has always shipped flat; saying so removes the
    // dependency on DOM nesting, which is what let the two shells diverge.
    expect(CHROME).toContain('variant="sidebar"');
    expect(CHROME).not.toContain('variant="inset"');
  });

  test('both shells therefore render the same panel regardless of nesting', () => {
    // Neither shell can now be changed by an intermediate wrapper element.
    expect(SIDEBAR_UI).toContain('peer-data-[variant=inset]');
    expect(ANON_SHELL).not.toContain('variant="inset"');
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
