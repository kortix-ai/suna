'use client';

import { Suspense } from 'react';

import { AuthPendingScreen } from '@kortix/ui/internal/auth/auth-consent';
import { ChannelInstallComplete } from '@/features/auth/channel-install-complete';
import { MicrosoftTeams } from '@kortix/ui/internal/icons/microsoft-teams';
import { completeTeamsInstall } from '@kortix/sdk';

/**
 * Teams OAuth install completion. The API callback hands the browser here
 * with the provider code and the signed state; the install is recorded only
 * for the Kortix user who started it.
 */
export default function TeamsInstallPage() {
  return (
    <Suspense fallback={<AuthPendingScreen />}>
      <ChannelInstallComplete
        service="Teams"
        icon={MicrosoftTeams}
        path="/teams/install"
        complete={completeTeamsInstall}
      />
    </Suspense>
  );
}
