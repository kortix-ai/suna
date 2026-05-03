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
import { Loader2 } from 'lucide-react';

export default function OnboardingRedirect() {
  const router = useRouter();

  useEffect(() => {
    const instanceId = getActiveInstanceId() || getActiveInstanceIdFromCookie();
    if (instanceId) {
      router.replace(`/instances/${instanceId}/onboarding${window.location.search}`);
    } else {
      // No instance context — punt to the workspace picker so the user
      // chooses one explicitly instead of getting auto-routed.
      router.replace('/instances');
    }
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}
