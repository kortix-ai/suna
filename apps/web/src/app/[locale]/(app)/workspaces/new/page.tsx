'use client';

import { Suspense } from 'react';

import { NewWorkspacePage } from '@/features/workspace/new/new-workspace-page';

/**
 * Route wrapper for `/workspaces/new`. The form itself lives in
 * `features/workspace/new/new-workspace-page.tsx` — this file only wires the
 * route.
 *
 * Auth comes from the `(app)` route group; `/workspaces/new` is on DESKTOP_ALLOWED_ROUTES
 * (middleware.ts) and deliberately absent from PUBLIC_ROUTES.
 */
export default function Page() {
  return (
    <Suspense fallback={null}>
      <NewWorkspacePage />
    </Suspense>
  );
}
