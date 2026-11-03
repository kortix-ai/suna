'use client';

import { Suspense } from 'react';

import { AuthPendingScreen } from '@kortix/ui/internal/auth/auth-consent';
import { ChannelInstallComplete } from '@/features/auth/channel-install-complete';
import { Discord } from '@kortix/ui/internal/icons/discord';
import { completeDiscordInstall } from '@kortix/sdk';

/**
 * "Add to Discord" completion. The API callback hands the browser here with
 * the provider code and the signed state; the install is recorded only for
 * the Kortix user who started it.
 */
export default function DiscordInstallPage() {
  return (
    <Suspense fallback={<AuthPendingScreen />}>
      <ChannelInstallComplete
        service="Discord"
        icon={Discord}
        path="/discord/install"
        complete={completeDiscordInstall}
      />
    </Suspense>
  );
}
