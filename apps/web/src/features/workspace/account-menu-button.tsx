'use client';

import { CaretDownIcon, GearSixIcon, SignOutIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Loading from '@/components/ui/loading';
import { useAuth } from '@/features/providers/auth-provider';
import { useTranslations } from '@/i18n/use-translations';
import { performSignOut } from '@/lib/auth/perform-sign-out';

/**
 * Who you are, as a button: the identity chip and its menu (profile settings,
 * log out). Extracted from `AccountTopBar` (KRTX-2145) so every authenticated
 * surface can render the same control, not just the account-level pages whose
 * top row already carried it.
 *
 * Self-contained on purpose. The pages that hosted the old presentational chip
 * all threaded the identical `email` / `name` / `signingOut` / `onLogOut`
 * plumbing through; reading the session from `useAuth()` and owning sign-out
 * here (`performSignOut` replaces the document, so `signingOut` is never
 * cleared) removes that duplication from every call site.
 *
 * `embedded` stamps `data-kx-account-owner` on the root: the marker the project
 * shell's floating account corner (see `project-shell.tsx` and the
 * `.kx-app-account-corner` rules in `globals.css`) uses to step aside when a
 * view carries its own chip in a page header. Two identity buttons for one
 * person is the bug, not the feature.
 *
 * The marker is owned for the VISIBLE route only. Next's client cache keeps
 * recently visited session views mounted inside React `<Activity mode="hidden">`
 * (see `session-route-cache.tsx`): a hidden tree stays in the DOM, so a plain
 * declarative attribute would keep matching the shell's `:has()` rule and hide
 * the corner on the view the user is actually looking at. React unmounts a
 * hidden tree's effects and remounts them when it shows again — so the marker
 * lives in an effect: present while the owning view is visible, absent while
 * it is hidden. The declarative attribute stays for SSR and first paint, which
 * the effect then re-asserts; hidden trees render nothing visible anyway.
 */
export function AccountMenuButton({ embedded = false }: { embedded?: boolean }) {
  const t = useTranslations('newWorkspace');
  const { user } = useAuth();
  const identity = user?.user_metadata?.name?.trim() || user?.email || null;
  // Never cleared: `performSignOut` replaces the document.
  const [signingOut, setSigningOut] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Present on mount, absent while hidden. StrictMode double-invocation is
  // harmless (set → remove → set); the declarative attribute above makes the
  // first paint match, so this only matters for the Activity hide/unhide cycle.
  useEffect(() => {
    if (!embedded) return;
    const root = rootRef.current;
    if (!root) return;
    root.setAttribute('data-kx-account-owner', '');
    return () => root.removeAttribute('data-kx-account-owner');
  }, [embedded]);

  return (
    <div
      ref={rootRef}
      data-kx-account-owner={embedded ? '' : undefined}
      className="flex min-w-0 items-center"
    >
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
          {/* Settings must be reachable from every authenticated page,
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
          <DropdownMenuItem
            disabled={signingOut}
            onSelect={() => {
              setSigningOut(true);
              void performSignOut();
            }}
          >
            <SignOutIcon />
            {signingOut ? t('actions.signingOut') : t('actions.logOut')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
