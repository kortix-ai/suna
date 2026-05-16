'use client';

/**
 * AppHeader — the canonical top bar used outside the (dashboard) shell.
 *
 * Layout:
 *  - LEFT:  KortixLogo + optional `leading` slot (e.g. a back button).
 *  - RIGHT: optional `actions` slot + WorkspaceMenu (single widget that
 *           carries identity + workspace context + settings).
 *
 * Variants:
 *  - default  — renders as an in-flow header (use inside a flex column page).
 *  - overlay  — renders absolutely positioned at the top of its container,
 *               sitting over a full-screen loader / shell.
 */

import { useRouter, usePathname } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { ArrowLeftRight } from 'lucide-react';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { WorkspaceMenu } from '@/components/sidebar/workspace-menu';
import {
  AccountSwitcher,
  ProjectSwitcher,
} from '@/components/layout/account-switcher';
import { cn } from '@/lib/utils';

export function AppHeader({
  user,
  leading,
  actions,
  variant = 'default',
}: {
  user: User;
  leading?: React.ReactNode;
  actions?: React.ReactNode;
  variant?: 'default' | 'overlay';
}) {
  const pathname = usePathname();
  const onProjectsRoute = pathname?.startsWith('/projects') ?? false;

  const displayName =
    (user.user_metadata?.name as string | undefined) ||
    user.email?.split('@')[0] ||
    'User';
  const displayEmail = user.email || '';
  const avatarUrl =
    (user.user_metadata?.avatar_url as string | undefined) ||
    (user.user_metadata?.picture as string | undefined) ||
    '';

  return (
    <header
      className={cn(
        'flex shrink-0 items-center justify-between gap-3 px-6 py-4',
        variant === 'overlay' && 'pointer-events-none absolute inset-x-0 top-0 z-20',
      )}
    >
      <div
        className={cn(
          'flex min-w-0 items-center gap-1',
          variant === 'overlay' && 'pointer-events-auto',
        )}
      >
        <KortixLogo size={20} className="mr-1" />
        {/* Vercel-style breadcrumb: pills separated by skewed dividers that
            sit BETWEEN them — not inside the buttons themselves. */}
        {onProjectsRoute && (
          <>
            <BreadcrumbDivider />
            <AccountSwitcher />
            <BreadcrumbDivider />
            <ProjectSwitcher />
          </>
        )}
        {leading}
      </div>
      <div
        className={cn(
          'flex items-center gap-2',
          variant === 'overlay' && 'pointer-events-auto',
        )}
      >
        {actions}
        <WorkspaceMenu
          user={{ name: displayName, email: displayEmail, avatar: avatarUrl }}
          variant="header"
        />
      </div>
    </header>
  );
}

/** Subtle Vercel-style separator between breadcrumb pills. Skewed so the
 *  "/" reads as a divider, not a textual slash inside a pill. */
function BreadcrumbDivider() {
  return (
    <span
      aria-hidden="true"
      className="select-none px-0.5 text-[14px] font-light text-muted-foreground/40 transform -skew-x-12"
    >
      /
    </span>
  );
}

/**
 * Project picker link — small "Projects" button intended for the
 * AppHeader's `actions` slot on full-screen loader states. Provides a
 * one-click escape from an unreachable workspace.
 */
export function WorkspacePickerLink({
  href = '/projects',
}: {
  href?: string;
}) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => router.push(href)}
      className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
    >
      <ArrowLeftRight className="h-3.5 w-3.5" />
      Projects
    </button>
  );
}
