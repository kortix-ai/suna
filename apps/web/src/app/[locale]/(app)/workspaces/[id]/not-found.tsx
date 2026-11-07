'use client';

import { usePathname } from 'next/navigation';
import { useMemo } from 'react';

import { NotFoundState } from '@/components/common/not-found-state';
import { PROJECT_LANDING_PATH } from '@kortix/ui/internal/lib/onboarding/landing-destination';

/**
 * Dashboard 404: the not-found boundary for `/workspaces/[id]/*`.
 *
 * The same `<NotFoundState />` as the app-wide 404, inside the workspace shell
 * (sidebar + tab bar). "Go back to home" returns to the workspace home.
 *
 * not-found boundaries don't receive route params, so the workspace id is read
 * back off the pathname (`/workspaces/<id>/…`).
 */
export default function ProjectNotFound() {
  const pathname = usePathname();

  const projectId = useMemo(() => {
    const segments = pathname?.split('/').filter(Boolean) ?? [];
    return segments[0] === 'workspaces' || segments[0] === 'projects' ? segments[1] : undefined;
  }, [pathname]);

  // Without a workspace id the shell does not mount: fill the viewport instead.
  if (!projectId) {
    return <NotFoundState homeHref={PROJECT_LANDING_PATH} className="h-dvh" />;
  }

  return <NotFoundState homeHref={`/workspaces/${projectId}`} className="min-h-0 flex-1" />;
}
