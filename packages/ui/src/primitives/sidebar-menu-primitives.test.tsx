import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
} from './sidebar';

test('sidebar menu primitives retain their slots, variants, nesting and tooltip', () => {
  const html = renderToStaticMarkup(
    <SidebarProvider defaultOpen={false}>
      <SidebarGroup>
        <SidebarGroupLabel>Group</SidebarGroupLabel>
        <SidebarGroupAction aria-label="Group action" />
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton variant="success" size="sm" isActive tooltip="Details">
                Item
              </SidebarMenuButton>
              <SidebarMenuAction showOnHover aria-label="Item action" />
              <SidebarMenuBadge>2</SidebarMenuBadge>
              <SidebarMenuSub>
                <SidebarMenuSubItem>
                  <SidebarMenuSubButton href="#item" size="sm" isActive>
                    Child
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              </SidebarMenuSub>
            </SidebarMenuItem>
          </SidebarMenu>
          <SidebarMenuSkeleton showIcon />
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarProvider>,
  );

  for (const slot of [
    'sidebar-group', 'sidebar-group-label', 'sidebar-group-action', 'sidebar-group-content',
    'sidebar-menu', 'sidebar-menu-item', 'sidebar-menu-button', 'sidebar-menu-action',
    'sidebar-menu-badge', 'sidebar-menu-sub', 'sidebar-menu-sub-item',
    'sidebar-menu-sub-button', 'sidebar-menu-skeleton',
  ]) {
    expect(html).toContain(`data-slot="${slot}"`);
  }
  expect(html).toContain('data-active="true"');
  expect(html).toContain('data-size="sm"');
  expect(html).toContain('bg-kortix-green/10');
  expect(html).toContain('data-state="closed"');
  expect(html).toContain('data-sidebar="menu-skeleton-icon"');
});
