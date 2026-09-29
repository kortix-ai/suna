import { describe, expect, test } from 'bun:test';

import * as sidebar from './sidebar';
import type { SidebarToggleOptions } from './sidebar';

/**
 * Characterization test for the `@/components/ui/sidebar` public surface.
 *
 * Phase 1 of `code-spec:split-sidebar-tsx` moves the context kernel into
 * `sidebar-context.tsx` and re-exports it from `sidebar.tsx`. The risk of that
 * move is a dropped name: 27 files import these names from
 * `@/components/ui/sidebar`, and nothing else would fail if one vanished. This
 * test pins the surface before and after the move.
 */
describe('@/components/ui/sidebar public surface', () => {
  test('still exports every runtime name the app imports', () => {
    const exported = [
      'Sidebar',
      'SidebarContent',
      'SidebarContext',
      'SidebarEdgePeek',
      'SidebarFooter',
      'SidebarGroup',
      'SidebarGroupAction',
      'SidebarGroupContent',
      'SidebarGroupLabel',
      'SidebarHeader',
      'SidebarInput',
      'SidebarInset',
      'SidebarMenu',
      'SidebarMenuAction',
      'SidebarMenuBadge',
      'SidebarMenuButton',
      'SidebarMenuItem',
      'SidebarMenuSkeleton',
      'SidebarMenuSub',
      'SidebarMenuSubButton',
      'SidebarMenuSubItem',
      'SidebarProvider',
      'SidebarRail',
      'SidebarSeparator',
      'SidebarTrigger',
      'useOptionalSidebar',
      'useSidebar',
    ] as const;

    for (const name of exported) {
      expect(sidebar[name], name).toBeDefined();
    }
  });

  test('still exports the SidebarToggleOptions type', () => {
    // Type-only export: the compiler is what pins it. The runtime read keeps
    // the assertion in the test report.
    const options: SidebarToggleOptions = { instant: true, detail: 0 };
    expect(options.instant).toBe(true);
  });
});
