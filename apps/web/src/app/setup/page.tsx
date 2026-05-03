'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * /setup — redirects into the dashboard. Setup now lives as an overlay inside
 * the dashboard layout after workspace resolution.
 */
export default function SetupPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/dashboard');
  }, [router]);

  return null;
}
