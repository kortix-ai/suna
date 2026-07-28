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

import type { ComponentType, ReactNode } from 'react';

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

/** The panel itself. */
export function SidebarShell({ children }: { children: ReactNode }) {
  return (
    <Sidebar
      collapsible="offcanvas"
      variant="inset"
      className="bg-sidebar [scrollbar-width:'none'] [-ms-overflow-style:'none'] [&::-webkit-scrollbar]:hidden"
    >
      {children}
    </Sidebar>
  );
}

/** Kortix mark on the left, whatever the surface puts beside it on the right. */
export function SidebarBrandHeader({
  homeHref,
  children,
}: { homeHref: string; children?: ReactNode }) {
  return (
    <SidebarHeader className="space-y-2 pt-[max(0.5rem,env(safe-area-inset-top,0px))]">
      <div className="flex w-full items-center justify-between gap-1">
        <Button type="button" variant="ghost" size="icon" asChild>
          <Link href={homeHref}>
            <Icon.Kortix className="text-foreground size-4.5" />
          </Link>
        </Button>
        {children ? <div className="w-full min-w-0">{children}</div> : null}
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

/**
 * A top-level sidebar row: icon, sentence-case label, one line.
 *
 * Every primary entry is one of these — Sessions, Files, Customize, Settings —
 * so they read as one family. The reference has no uppercase micro-labels
 * anywhere; mixing a tiny SESSIONS caption with an icon-bearing Files row is
 * exactly what made this look unfinished.
 * See ux-references/perplexity/01-home-search.png.
 */
export function SidebarNavRow({
  icon: RowIcon,
  label,
  href,
  onClick,
  isActive,
  trailing,
  className,
}: {
  icon: ComponentType<{ className?: string }>;
  label: ReactNode;
  href?: string;
  onClick?: () => void;
  isActive?: boolean;
  /** Right-aligned affordance (a filter menu, a count). */
  trailing?: ReactNode;
  className?: string;
}) {
  const body = (
    <>
      <RowIcon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
    </>
  );

  const buttonClass = cn(
    'flex h-8 items-center gap-2 px-2 text-sm font-medium [&_svg]:size-4',
    className,
  );

  return (
    <SidebarMenuItem className="flex items-center gap-0.5">
      {href ? (
        <SidebarMenuButton asChild isActive={isActive} className={buttonClass}>
          <Link href={href} onClick={onClick}>
            {body}
          </Link>
        </SidebarMenuButton>
      ) : (
        <SidebarMenuButton isActive={isActive} onClick={onClick} className={buttonClass}>
          {body}
        </SidebarMenuButton>
      )}
      {trailing}
    </SidebarMenuItem>
  );
}

/**
 * Retained for surfaces that still want a caption. New rows should use
 * {@link SidebarNavRow} — the reference has no uppercase labels.
 */
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
 * A child of a nav row: plain text, indented past the parent's icon, no icon of
 * its own. That restraint is what keeps the sidebar light, and the indent is
 * what makes it read as belonging to the row above it.
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
  // pl-8 lines the label up with the parent row's label, past its icon.
  const className = cn(
    'text-muted-foreground hover:text-sidebar-foreground h-7 pr-2 pl-8 text-sm font-normal',
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
