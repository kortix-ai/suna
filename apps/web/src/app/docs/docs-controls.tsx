'use client';

import { ThemeToggle } from '@/components/home/theme-toggle';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { Github } from '@/features/icon/icons/github';
import { cn } from '@/lib/utils';
import {
  SidebarSimpleIcon as PanelLeftIcon,
  MagnifyingGlassIcon as Search,
} from '@phosphor-icons/react';
import type * as PageTree from 'fumadocs-core/page-tree';
import { SidebarSeparator, useSidebar } from 'fumadocs-ui/components/sidebar/base';
import { useSearchContext } from 'fumadocs-ui/contexts/search';

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
        {hotKey.map((k) => (
          <Kbd key={String(k.display)}>{k.display}</Kbd>
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

/**
 * The sidebar's bottom row: one link out, and the theme control.
 *
 * It lives in `sidebar.footer` rather than in fumadocs' `links` +
 * `themeSwitch` slots, and that is the whole fix. Those slots render into a
 * container whose classes are hardcoded in the package —
 * `flex items-center border bg-fd-secondary/50 p-0.5 rounded-lg`
 * (`fumadocs-ui/dist/layouts/docs/slots/sidebar.js`) — so the bar arrived as a
 * bordered, tinted pill with a filled segmented control inside it: four
 * surfaces stacked at the quietest corner of the page, and no prop to turn any
 * of them off. Emptying both slots lets the package's own `empty:hidden` drop
 * that container, and this row takes its place. The same `footer` node is what
 * the mobile drawer renders, so the two surfaces cannot drift.
 *
 * `Github` is the app's own brand mark (`features/icon/icons/github.tsx`), the
 * one `docs-page-actions.tsx` already uses — not phosphor's `GithubLogoIcon`,
 * so one GitHub glyph appears across the docs. It is a client component, which
 * is why this row is one too; a server layout may RENDER it, it just cannot
 * call into it.
 */
export function DocsSidebarFooter() {
  return (
    <div className="text-muted-foreground flex w-full items-center justify-between">
      <a
        href="https://github.com/kortix-ai/suna"
        target="_blank"
        rel="noreferrer"
        aria-label="Kortix on GitHub"
        // Sized and toned exactly like a theme segment, so the row reads as
        // one strip of icons rather than a link beside a control.
        className="hover:text-foreground inline-flex size-7 items-center justify-center rounded-md transition-colors duration-150 ease-out"
      >
        <Github className="size-4" />
      </a>
      <ThemeToggle className="hover:bg-card ml-auto rounded-sm" />
    </div>
  );
}
