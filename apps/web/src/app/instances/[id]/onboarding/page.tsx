'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { buildInstancePath } from '@/lib/instance-routes';

/**
 * Legacy onboarding route — redirects to the dashboard, where onboarding is
 * handled as a state within the dashboard layout itself. Renders the single
 * canonical ConnectingScreen for the sub-second redirect so users don't see
 * any other loader style.
 */
export default function OnboardingPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();

  useEffect(() => {
    router.replace(buildInstancePath(id, '/dashboard'));
  }, [router, id]);

  return <ConnectingScreen forceConnecting overrideStage="routing" />;
}
