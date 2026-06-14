'use client';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { AccountSwitcher } from '@/features/layout/account-switcher';
import { UserMenu } from '@/features/layout/user-menu';
import { useIsMobile } from '@/hooks/utils';
import { cn } from '@/lib/utils';
import type { User } from '@supabase/supabase-js';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { lazy, Suspense } from 'react';

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
  breadcrumb?: React.ReactNode;
  actions?: React.ReactNode;
  variant?: 'default' | 'overlay';
  logoHref?: string;
}) {
  const isMobile = useIsMobile();
  const tHardcodedUi = useTranslations('hardcodedUi');
  const displayName =
    (user.user_metadata?.name as string | undefined) || user.email?.split('@')[0] || 'User';
  const displayEmail = user.email || '';
  const avatarUrl =
    (user.user_metadata?.avatar_url as string | undefined) ||
    (user.user_metadata?.picture as string | undefined) ||
    '';

  return (
    <>
      <header
        className={cn(
          'kx-app-header px-mobile mx-auto flex w-full max-w-6xl shrink-0 items-center justify-between gap-2 py-4 sm:gap-3',
          variant === 'overlay' && 'pointer-events-none absolute inset-x-0 top-0 z-20',
        )}
      >
        <div
          className={cn(
            'flex min-w-0 items-center gap-1',
            variant === 'overlay' && 'pointer-events-auto',
          )}
        >
          <Breadcrumb className="min-w-0 flex-1 overflow-hidden">
            <BreadcrumbList className="min-w-0 flex-nowrap gap-2.5 sm:flex-wrap">
              <BreadcrumbItem className="shrink-0">
                <BreadcrumbLink asChild>
                  <Link
                    href={logoHref}
                    aria-label={tHardcodedUi.raw(
                      'componentsLayoutAppHeader.line72JsxAttrAriaLabelKortixHome',
                    )}
                    className="focus-visible:ring-ring/50 text-foreground inline-flex cursor-pointer items-center rounded-md focus-visible:ring-2 focus-visible:outline-none"
                  >
                    <KortixLogo
                      variant={isMobile ? 'symbol' : 'logomark'}
                      size={isMobile ? 20 : 16}
                    />
                  </Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden sm:inline-flex" />
              <BreadcrumbItem className="min-w-0 shrink">
                <AccountSwitcher variant="header" />
              </BreadcrumbItem>
              {breadcrumb != null && (
                <div className="hidden lg:block">
                  <BreadcrumbSeparator className="hidden sm:inline-flex" />
                  <BreadcrumbItem className="min-w-0 overflow-hidden">
                    <BreadcrumbPage className="block max-w-20 truncate font-medium select-none sm:max-w-none">
                      {breadcrumb}
                    </BreadcrumbPage>
                  </BreadcrumbItem>
                </div>
              )}
            </BreadcrumbList>
          </Breadcrumb>
          {leading}
        </div>
        <div
          className={cn(
            'flex shrink-0 items-center gap-2',
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

      <Suspense fallback={null}>
        <CommandPalette />
      </Suspense>
    </>
  );
}
