'use client';

import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { cn } from '@/lib/utils';
import type { PageTree } from 'fumadocs-core/server';
import { SidebarSeparator } from 'fumadocs-ui/components/layout/sidebar';
import { useSearchContext, useSidebar } from 'fumadocs-ui/provider';
import { PanelLeftIcon, Search } from 'lucide-react';

// App-Button replacements for fumadocs' built-in sidebar chrome (search
// toggles, collapse trigger, collapsed floating control) so the docs share
// the app's control language instead of fumadocs' default styling.

// Section labels ("Learn", "Reference", …) — the stock separator inherits the
// sidebar's 12px, too faint next to 14px items; render at text-sm instead.
// mt-6/first:mt-0 reproduces the default's spacing (mt-6 on all but the first).
export function DocsSidebarSeparator({ item }: { item: PageTree.Separator }) {
  return (
    <SidebarSeparator className="mt-6 text-sm first:mt-0">
      {item.icon}
      {item.name}
    </SidebarSeparator>
  );
}

// Sidebar search row — same shape as the app sidebar's Search entry.
export function DocsSearchButton() {
  const { enabled, hotKey, setOpenSearch } = useSearchContext();
  if (!enabled) return null;

  return (
    <Button variant="secondary" onClick={() => setOpenSearch(true)} className="group/row w-full">
      <Search className="text-sidebar-foreground shrink-0" />
      <span className="flex-1 text-left">Search</span>
      <KbdGroup className="ml-auto opacity-0 transition-opacity duration-150 group-hover/row:opacity-100">
        {hotKey.map((k, i) => (
          <Kbd key={i}>{k.display}</Kbd>
        ))}
      </KbdGroup>
    </Button>
  );
}

// Mobile navbar search — icon-only.
export function DocsSearchIconButton() {
  const { enabled, setOpenSearch } = useSearchContext();
  if (!enabled) return null;

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Open search"
      onClick={() => setOpenSearch(true)}
    >
      <Search />
    </Button>
  );
}

// Sidebar-header collapse trigger (desktop only) — replaces the stock
// SidebarCollapseTrigger that `sidebar.collapsible: false` removes.
export function DocsSidebarCollapseButton() {
  const { collapsed, setCollapsed } = useSidebar();

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Collapse sidebar"
      className="text-muted-foreground mb-auto max-md:hidden"
      onClick={() => setCollapsed(!collapsed)}
    >
      <PanelLeftIcon />
    </Button>
  );
}

// Floating expand/search pair shown while the sidebar is collapsed. Replaces
// fumadocs' CollapsibleControl (a shadowed pill that jumps to the right edge
// below xl); this one is a flat bordered ButtonGroup pinned to the far left.
export function DocsCollapsedControls() {
  const { collapsed, setCollapsed } = useSidebar();
  const { enabled, setOpenSearch } = useSearchContext();

  return (
    <div
      className={cn(
        'fixed start-4 z-10 transition-opacity max-md:hidden',
        !collapsed && 'pointer-events-none opacity-0',
      )}
      style={{
        top: 'calc(var(--fd-banner-height) + var(--fd-tocnav-height) + var(--spacing) * 4)',
      }}
    >
      <ButtonGroup className="bg-secondary rounded-md">
        <Button
          variant="outline"
          size="icon"
          aria-label="Open sidebar"
          onClick={() => setCollapsed(false)}
        >
          <PanelLeftIcon />
        </Button>
        {enabled && (
          <Button
            variant="outline"
            size="icon"
            aria-label="Open search"
            onClick={() => setOpenSearch(true)}
          >
            <Search />
          </Button>
        )}
      </ButtonGroup>
    </div>
  );
}
