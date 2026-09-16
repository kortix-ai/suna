import { Suspense } from 'react';

import { AccountHubPanel } from '@/features/accounts/hub/account-hub-panel';
import { BillingReturnWatcher } from '@/features/billing/billing-return';
import { UpgradeModalHost } from '@/features/billing/global-upgrade-modal';
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
 * The account hub overlay is the third such case. It opens over whatever app
 * route you are on — a project, a session, the projects list — so only a
 * shell above all of them can mount it. It renders nothing until something
 * opens it, and it stands down entirely while an `/accounts/**` route is
 * showing the same surface. See `features/accounts/hub/account-hub-panel.tsx`.
 *
 * Keep this thin. Route-specific work belongs in the route.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <UpgradeModalHost>
      {/* useSearchParams needs a Suspense boundary to avoid opting every route
          under (app) into client-side rendering at build time. */}
      <Suspense fallback={null}>
        <BillingReturnWatcher />
      </Suspense>
      <ProjectSwitchWatcher />
      {/* Closed, this is one store subscription and a `popstate` listener. The
          hub's own chunk is not fetched until the first open — or until
          `preloadAccountHub()` warms it on pointer intent. */}
      <Suspense fallback={null}>
        <AccountHubPanel />
      </Suspense>
      {children}
    </UpgradeModalHost>
  );
}
