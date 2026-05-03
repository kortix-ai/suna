'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * /subscription redirects to /dashboard.
 * The checkout modal is now invoked from the workspace switcher and
 * mounted globally — no separate landing page needed. This route exists
 * only for legacy links and Stripe return URLs.
 */
export default function SubscriptionRedirect() {
  const router = useRouter();

  useEffect(() => {
    const search = typeof window !== 'undefined' ? window.location.search : '';
    router.replace(`/instances${search}`);
  }, [router]);

  return null;
}
