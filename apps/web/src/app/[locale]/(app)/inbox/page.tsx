'use client';

import { useState } from 'react';

import { useAuth } from '@/features/providers/auth-provider';
import { AccountTopBar } from '@/features/workspace/account-top-bar';
import { useTranslations } from '@/i18n/use-translations';
import { performSignOut } from '@/lib/auth/perform-sign-out';
import { useSignedOutRedirect } from '@/lib/auth/use-signed-out-redirect';
import { NotificationInbox } from '@kortix/ui/internal/notifications/notification-inbox';

/**
 * /inbox — the Inbox (KRTX-1742) outside a project: the same page as
 * `/workspaces/[id]/inbox`, under the account pages' top bar. The Inbox button
 * of `/projects` and `/new` opens it. These pages mount no Settings overlay,
 * so "Notification settings" navigates to `/settings/sessions`.
 */
export default function InboxPage() {
  const t = useTranslations('newWorkspace');
  const { user } = useAuth();
  // Never cleared: `performSignOut` replaces the document.
  const [signingOut, setSigningOut] = useState(false);
  useSignedOutRedirect();

  return (
    <NotificationInbox
      settingsHref="/settings/sessions"
      header={
        // The bar is `absolute`: this box holds its row, so the page starts
        // below it. `h-24` (~88px) clears the bar on the web (bottom ~58px)
        // and under the desktop title-bar band (`kx-desktop-band-row`, bottom
        // ~90px at 100% zoom, inside the column's top padding).
        <div className="relative h-24 shrink-0">
          <AccountTopBar
            email={user?.email ?? null}
            name={user?.user_metadata?.name}
            signingOut={signingOut}
            onLogOut={() => {
              setSigningOut(true);
              void performSignOut();
            }}
            back={{ href: '/projects', label: t('actions.back') }}
            inbox={false}
          />
        </div>
      }
    />
  );
}
