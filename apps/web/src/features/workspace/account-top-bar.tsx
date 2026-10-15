'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { BackPillBody, backPillClass } from '@/components/ui/back-pill';

import { AccountMenuButton } from './account-menu-button';

// Client only: the inbox is per signed-in person and polls, so the server
// renders no bell and these pages' static tests need no query client. The
// bell itself renders only while a cached project has the
// `notification_center` flag on (these pages have no project of their own).
const NotificationBell = dynamic(
  () => import('@/features/notifications/notification-bell').then((mod) => mod.NotificationBell),
  { ssr: false },
);

/**
 * The top row of the account-level pages that sit outside a project —
 * `/projects`, `/new`, `/checkout`, `/connections`.
 *
 * Left: an optional way back. Right: the notification bell (KRTX-1742, behind
 * the `notification_center` flag), then who you are, as a button. Log out lives
 * in its menu rather than as a bare button in the corner — it is the rarest
 * action on these pages, and the identity above it is what a user checks
 * first ("am I in the right account?").
 *
 * The identity chip and its menu live in `AccountMenuButton`, which reads the
 * session itself; this bar no longer threads sign-out state through.
 *
 * `kx-desktop-band-row` keeps the row under the desktop title-bar band, clear
 * of the macOS traffic lights and the Win/Linux window controls.
 */
export function AccountTopBar({
  back,
  trailing,
}: {
  /** Rendered as a ghost link on the left. Omit on a page with nowhere to go back to. */
  back?: { href: string; label: string };
  /** Extra controls after the account button (the desktop close button). */
  trailing?: ReactNode;
}) {
  return (
    <div className="kx-desktop-band-row absolute inset-x-0 top-3 z-10 flex items-center justify-between gap-3 px-4 sm:top-4 sm:px-6">
      {back ? (
        // The web needs an in-page exit; Electron supplies Back in its band.
        <Button
          asChild
          variant="ghost"
          size="xs"
          className={backPillClass('kx-web-only-back')}
        >
          <Link href={back.href}>
            <BackPillBody label={back.label} />
          </Link>
        </Button>
      ) : (
        <span aria-hidden />
      )}

      <div className="flex min-w-0 items-center gap-2">
        <NotificationBell />
        <AccountMenuButton />
        {trailing}
      </div>
    </div>
  );
}
