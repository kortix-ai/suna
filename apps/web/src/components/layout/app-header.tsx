'use client';

import { lazy, Suspense } from 'react';
import { useTranslations } from 'next-intl';

/**
 * AppHeader — the canonical top bar used outside the (dashboard) shell.
 *
 * Layout:
 *  - LEFT:  KortixLogo + AccountSwitcher (which account / workspace) + an
 *           optional `breadcrumb` crumb for the current section ("Projects").
 *  - RIGHT: optional `actions` slot + UserMenu (you + settings).
 *
 * Variants:
 *  - default  — renders as an in-flow header (use inside a flex column page).
 *  - overlay  — renders absolutely positioned at the top of its container,
 *               sitting over a full-screen loader / shell.
 */

import Link from 'next/link';
import type { User } from '@supabase/supabase-js';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { UserMenu } from '@/components/layout/user-menu';
import { AccountSwitcher } from '@/components/layout/account-switcher';
import { cn } from '@/lib/utils';

// Lazy so the command palette (and its dependency graph) only loads once a
// header page is actually on screen, mirroring project-shell.
const CommandPalette = lazy(() =>
  import('@/components/command-palette').then((mod) => ({
    default: mod.CommandPalette,
  })),
);

export function AppHeader({
  user,
  leading,
  breadcrumb,
  actions,
  variant = 'default',
  logoHref = '/projects',
}: {
  user: User;
  leading?: React.ReactNode;
  /** Current-section crumb shown after the account pill (e.g. "Projects"). */
  breadcrumb?: React.ReactNode;
  actions?: React.ReactNode;
  variant?: 'default' | 'overlay';
  /** Where the logo navigates on click. Defaults to /projects (the main app
   * landing). Pass an explicit href to override on a specific surface. */
  logoHref?: string;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
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
    <>
    <header
      className={cn(
        'kx-app-header flex shrink-0 items-center justify-between gap-3 px-6 py-4',
        variant === 'overlay' && 'pointer-events-none absolute inset-x-0 top-0 z-20',
      )}
    >
      <div
        className={cn(
          'flex min-w-0 items-center gap-1',
          variant === 'overlay' && 'pointer-events-auto',
        )}
      >
        <Link
          href={logoHref}
          aria-label={tHardcodedUi.raw('componentsLayoutAppHeader.line72JsxAttrAriaLabelKortixHome')}
          className="mr-1 inline-flex cursor-pointer items-center rounded-md transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <KortixLogo variant="logomark" size={16} />
        </Link>
        {/* Vercel-style breadcrumb: the account is the workspace your projects
            live under, so it's the first pill (which project lives in the
            project shell's sidebar). An optional section crumb follows. */}
        <BreadcrumbDivider />
        <AccountSwitcher variant="header" />
        {breadcrumb != null && (
          <>
            <BreadcrumbDivider />
            <span className="select-none px-2 text-sm font-medium text-foreground">
              {breadcrumb}
            </span>
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
        <UserMenu
          user={{ name: displayName, email: displayEmail, avatar: avatarUrl }}
          variant="header"
        />
      </div>
    </header>
    {/* Cmd+K — available on every header page, not just the project shell. */}
    <Suspense fallback={null}>
      <CommandPalette />
    </Suspense>
    </>
  );
}

/** Subtle Vercel-style separator between breadcrumb pills. Skewed so the
 *  "/" reads as a divider, not a textual slash inside a pill. */
function BreadcrumbDivider() {
  return (
    <span
      aria-hidden="true"
      className="select-none px-0.5 text-sm font-light text-muted-foreground/40 transform -skew-x-12"
    >
      /
    </span>
  );
}
