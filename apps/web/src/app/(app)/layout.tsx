import { Suspense } from 'react';

import { BillingReturnWatcher } from '@/features/billing/billing-return';

/**
 * Shell for every authenticated app route.
 *
 * Its only job is to host behaviour that must not depend on WHICH app route the
 * user happens to be on. Returning from Stripe is the first such case: the
 * handling used to live in the workspaces list page, which forced every checkout
 * `success_url` to point at `/projects` — the one surface that is deliberately
 * never a destination.
 *
 * Keep this thin. Route-specific work belongs in the route.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* useSearchParams needs a Suspense boundary to avoid opting every route
          under (app) into client-side rendering at build time. */}
      <Suspense fallback={null}>
        <BillingReturnWatcher />
      </Suspense>
      {children}
    </>
  );
}
