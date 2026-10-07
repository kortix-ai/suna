'use client';

import { ArrowLeftIcon, CaretDownIcon, GearSixIcon, SignOutIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Loading from '@/components/ui/loading';
import { useTranslations } from '@/i18n/use-translations';

/**
 * The top row of the account-level pages that sit outside a project —
 * `/projects` and `/new`.
 *
 * Left: an optional way back. Right: who you are, as a button. Log out lives
 * in its menu rather than as a bare button in the corner — it is the rarest
 * action on these pages, and the identity above it is what a user checks
 * first ("am I in the right account?").
 *
 * Presentational on purpose: the page owns sign-out (`performSignOut` replaces
 * the document, so `signingOut` is never cleared) and passes the state in.
 *
 * `kx-desktop-band-row` keeps the row under the desktop title-bar band, clear
 * of the macOS traffic lights and the Win/Linux window controls.
 */
export function AccountTopBar({
  email,
  name,
  signingOut,
  onLogOut,
  back,
  trailing,
}: {
  email: string | null;
  name?: string | null;
  signingOut: boolean;
  onLogOut: () => void;
  /** Rendered as a ghost link on the left. Omit on a page with nowhere to go back to. */
  back?: { href: string; label: string };
  /** Extra controls after the account button (the desktop close button). */
  trailing?: ReactNode;
}) {
  const t = useTranslations('newWorkspace');
  const identity = name?.trim() || email;

  return (
    <div className="kx-desktop-band-row absolute inset-x-0 top-3 z-10 flex items-center justify-between gap-3 px-4 sm:top-4 sm:px-6">
      {back ? (
        // The web needs an in-page exit; Electron supplies Back in its band.
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="kx-web-only-back text-muted-foreground hover:text-foreground shrink-0 gap-1.5"
        >
          <Link href={back.href}>
            <ArrowLeftIcon className="size-4" />
            {back.label}
          </Link>
        </Button>
      ) : (
        <span aria-hidden />
      )}

      <div className="flex min-w-0 items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={signingOut}
              aria-label={identity ? `${t('account.loggedInAs')} ${identity}` : t('account.label')}
              className="hover:bg-hover data-[state=open]:bg-hover focus-visible:ring-ring flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors duration-(--duration-normal) ease-out focus-visible:ring-2 focus-visible:outline-none"
            >
              <span className="flex min-w-0 flex-col">
                <span className="text-muted-foreground text-xs">{t('account.loggedInAs')}</span>
                <span className="text-foreground max-w-56 truncate text-sm">
                  {identity ?? t('account.label')}
                </span>
              </span>
              {signingOut ? (
                <Loading className="size-4 shrink-0" />
              ) : (
                <CaretDownIcon className="text-muted-foreground size-3.5 shrink-0" />
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {/* Settings must be reachable from every account-level page,
                regardless of project count: with no projects this menu was
                Log out only, and /settings/profile had no link at all
                (KRTX-1327). A real anchor, so the menu closes on navigate. */}
            <DropdownMenuItem asChild>
              <Link href="/settings/profile" prefetch>
                <GearSixIcon />
                {t('actions.settings')}
              </Link>
            </DropdownMenuItem>

            {/* Log out is the only row that ends something, so it gets its own
                group — the last item in a menu is the one a slipped pointer
                lands on. */}
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={signingOut} onSelect={onLogOut}>
              <SignOutIcon />
              {signingOut ? t('actions.signingOut') : t('actions.logOut')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {trailing}
      </div>
    </div>
  );
}
