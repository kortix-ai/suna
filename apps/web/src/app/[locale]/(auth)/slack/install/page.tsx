'use client';

import { Suspense } from 'react';

import { AuthPendingScreen } from '@/features/auth/auth-consent';
import { ChannelInstallComplete } from '@/features/auth/channel-install-complete';
import { completeSlackInstall } from '@kortix/sdk';

/**
 * Slack OAuth install completion. The API callback hands the browser here
 * with the provider code and the signed state; the install is recorded only
 * for the Kortix user who started it.
 */
export default function SlackInstallPage() {
  return (
    <Suspense fallback={<AuthPendingScreen />}>
      <ChannelInstallComplete service="Slack" path="/slack/install" complete={completeSlackInstall} />
    </Suspense>
  );
}
