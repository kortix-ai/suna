'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { PROJECT_LANDING_PATH } from '@/lib/onboarding/landing-destination';

/**
 * /setup redirects into the repo-first project shell. Setup now happens from
 * account and project settings rather than the legacy dashboard workspace.
 */
export default function SetupPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace(PROJECT_LANDING_PATH);
  }, [router]);

  return null;
}
