import { Suspense } from 'react';

import { BillingReturnWatcher } from '@/features/billing/billing-return';
import { ProjectSwitchWatcher } from '@/features/workspace/project-switch-watcher';

/**
 * Shell for every authenticated app route.
 *
 * Its only job is to host behaviour that must not depend on WHICH app route the
 * user happens to be on. Returning from Stripe is the first such case: the
 * handling used to live in the projects list page, which forced every checkout
 * `success_url` to point at `/projects` — the one surface that is deliberately
 * never a destination. Ending a workspace switch is the second: the picker that
 * starts one closes immediately, and the route it navigates to is a different
 * one on either side, so only a shell above both can watch it land.
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
      <ProjectSwitchWatcher />
      {children}
    </>
  );
}
