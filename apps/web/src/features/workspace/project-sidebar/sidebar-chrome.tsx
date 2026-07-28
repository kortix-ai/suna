'use client';

/**
 * The sidebar's chrome, shared by the signed-in shell and the signed-out
 * homepage.
 *
 * These two surfaces must be visually identical — the logged-out page IS the
 * product, so any drift between them reads as a different app. Sharing the
 * components rather than copying the markup is what guarantees that: change a
 * class here and both move together.
 *
 * Only the chrome lives here. What fills it differs (real sessions vs. an
 * empty state, a working New button vs. a sign-in gate), and that stays with
 * each caller.
 */

import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { Icon } from '@/features/icon/icon';
import { cn } from '@/lib/utils';
import Link from 'next/link';

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
export const MOD_SYMBOL = isMac ? '⌘' : 'Ctrl';

/**
 * The panel itself.
 *
 * `variant="sidebar"`, NOT `"inset"`. The inset variant asks SidebarInset for a
 * floating, rounded, margined content panel — and it was never actually
 * rendered: AppProviders wraps the sidebar in a positioning div, and the
 * inset's styling hangs off `peer-data-[variant=inset]`, a sibling combinator
 * that the wrapper defeats. So the app has always shipped flat, while claiming
 * a variant it does not render.
 *
 * That gap is what made the two shells look different the moment one of them
 * lost the wrapper. Declaring the variant we actually want removes the
 * dependency on DOM nesting altogether, in both shells.
 */
export function SidebarShell({ children }: { children: ReactNode }) {
  return (
    <Sidebar
      collapsible="offcanvas"
      variant="sidebar"
      className="bg-sidebar [scrollbar-width:'none'] [-ms-overflow-style:'none'] [&::-webkit-scrollbar]:hidden"
    >
      {children}
    </Sidebar>
  );
}

/**
 * Kortix mark on the left, whatever the surface puts beside it on the right.
 *
 * No collapse control here. Every page carries one in its own top bar
 * (SidebarPeekToggle), which is also the only control that exists once the
 * panel is off-canvas — putting a second one inside the panel just meant two
 * identical buttons a few pixels apart whenever it was open.
 */
export function SidebarBrandHeader({
  homeHref,
  children,
}: { homeHref: string; children?: ReactNode }) {
  return (
    <SidebarHeader className="space-y-2 pt-[max(0.5rem,env(safe-area-inset-top,0px))]">
      <div className="flex w-full items-center gap-1">
        <Button type="button" variant="ghost" size="icon" asChild>
          <Link href={homeHref}>
            <Icon.Kortix className="text-foreground size-4.5" />
          </Link>
        </Button>
        {children ? <div className="min-w-0 flex-1">{children}</div> : null}
      </div>
    </SidebarHeader>
  );
}

export function SidebarBody({ children }: { children: ReactNode }) {
  return (
    <SidebarContent className="relative min-h-0 flex-1 [scrollbar-width:'none'] overflow-hidden [-ms-overflow-style:'none'] [&::-webkit-scrollbar]:hidden">
      <div className="flex h-full min-h-0 flex-col space-y-4">{children}</div>
    </SidebarContent>
  );
}

/** The bordered New button, with its ⌘J hint on hover. */
export function SidebarNewButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <SidebarGroup className="py-0">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            onClick={onClick}
            size="md"
            className="group/menu-button text-sidebar-foreground border-border dark:bg-background dark:hover:bg-background/90 bg-background hover:bg-background/90 relative flex items-center justify-center gap-2 border-[1.2px] text-center !text-sm font-medium [&_svg]:!size-4"
          >
            <span>{label}</span>
            <KbdGroup className="absolute top-1/2 right-2 -translate-y-1/2 opacity-0 transition-opacity duration-200 group-hover/menu-button:opacity-100">
              <Kbd>{MOD_SYMBOL}</Kbd>
              <Kbd>J</Kbd>
            </KbdGroup>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  );
}

/** The quiet uppercase group label (SESSIONS, CUSTOMIZE). */
export function SidebarSectionLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <SidebarGroupLabel
      className={cn(
        'text-muted-foreground/60 flex h-6 items-center px-2 text-[11px] font-medium tracking-wider uppercase',
        className,
      )}
    >
      {children}
    </SidebarGroupLabel>
  );
}

/**
 * A Customize child: plain text, no icon, no box. That restraint is what makes
 * the sidebar feel light — see ux-references/perplexity/01-home-search.png.
 */
export function SidebarPlainLink({
  href,
  onClick,
  isActive,
  children,
}: {
  href?: string;
  onClick?: () => void;
  isActive?: boolean;
  children: ReactNode;
}) {
  const className = cn(
    'text-muted-foreground hover:text-sidebar-foreground h-7 px-2 text-sm font-normal',
    isActive && 'text-sidebar-foreground font-medium',
  );

  return (
    <SidebarMenuItem>
      {href ? (
        <SidebarMenuButton asChild size="sm" className={className}>
          <Link href={href} onClick={onClick}>
            {children}
          </Link>
        </SidebarMenuButton>
      ) : (
        <SidebarMenuButton size="sm" className={className} onClick={onClick}>
          {children}
        </SidebarMenuButton>
      )}
    </SidebarMenuItem>
  );
}

export function SidebarFooterSlot({ children }: { children: ReactNode }) {
  return (
    <SidebarFooter className="space-y-0.5 pt-1 pb-[max(0.5rem,env(safe-area-inset-bottom,0px))]">
      {children}
    </SidebarFooter>
  );
}
