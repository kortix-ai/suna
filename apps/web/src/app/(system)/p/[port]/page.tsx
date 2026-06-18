'use client';

import { use, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useTabStore } from '@/stores/tab-store';

/**
 * Preview route handler for /p/[port].
 *
 * Preview tabs are normally opened via the LocalhostLinkInterceptor or other
 * tab-system entry points, both of which use `history.pushState` to flip the
 * URL while keeping the surrounding shell (project shell, etc.) mounted —
 * that's where PreviewTabContent actually renders. This page exists only for
 * direct navigation / refresh of `/p/[port]` URLs.
 *
 * Behavior:
 *   - If the preview tab already exists in the persisted store, activate it.
 *     A surrounding shell that mounts <PreviewTabContent /> will then render
 *     the iframe (project-shell does this on /projects/*).
 *   - Otherwise we can't reconstruct the sandbox context, so we redirect to
 *     the projects index instead of leaving the user on a blank page.
 */
export default function PreviewPage({
  params,
}: {
  params: Promise<{ port: string }>;
}) {
  const { port } = use(params);
  const router = useRouter();
  const { tabs, setActiveTab } = useTabStore();

  useEffect(() => {
    const tabId = `preview:${port}`;
    if (tabs[tabId]) {
      setActiveTab(tabId);
    } else {
      router.replace('/projects');
    }
  }, [port, tabs, setActiveTab, router]);

  return null;
}
