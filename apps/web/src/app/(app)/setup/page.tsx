'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * /setup redirects into the repo-first project shell. Setup now happens from
 * account and project settings rather than the legacy dashboard workspace.
 */
export default function SetupPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/projects');
  }, [router]);

  return null;
}
