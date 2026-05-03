'use client';

/**
 * Redirect stub for /onboarding (bare, no instance prefix).
 *
 * In cloud mode, onboarding lives at /instances/:id/onboarding.
 * In self-hosted mode, there's typically a single instance — resolve it
 * from the server store and redirect, or fall back to /dashboard.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getActiveInstanceId } from '@/stores/server-store';
import { getActiveInstanceIdFromCookie } from '@/lib/instance-routes';
import { ConnectingScreen } from '@/components/dashboard/connecting-screen';

export default function OnboardingRedirect() {
  const router = useRouter();

  useEffect(() => {
    const instanceId = getActiveInstanceId() || getActiveInstanceIdFromCookie();
    if (instanceId) {
      router.replace(`/instances/${instanceId}/onboarding${window.location.search}`);
    } else {
      router.replace('/dashboard');
    }
  }, [router]);

  return <ConnectingScreen forceConnecting minimal />;
}
