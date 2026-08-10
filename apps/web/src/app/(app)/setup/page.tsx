'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { WORKSPACE_LANDING_PATH } from '@/lib/onboarding/landing-destination';

/**
 * /setup redirects into the repo-first workspace shell. Setup now happens from
 * account and workspace settings rather than the legacy dashboard workspace.
 */
export default function SetupPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace(WORKSPACE_LANDING_PATH);
  }, [router]);

  return null;
}
