'use client';

import { use, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useTabStore } from '@/stores/tab-store';

/**
 * Preview route handler for /p/[port].
 *
 * Preview tabs are normally opened via the tab system (sidebar, sandbox URL detector)
 * which uses pushState for URL changes. This page handles direct navigation to
 * /p/[port] (e.g. browser refresh, link sharing).
 *
 * If a preview tab for this port already exists in the store, it activates it.
 * Otherwise, it redirects to the dashboard since we don't have the sandbox URL
 * needed to create a preview tab.
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
    const existingTab = tabs[tabId];

    if (existingTab) {
      // Tab exists - activate it
      setActiveTab(tabId);
    } else {
      // No tab for this port - redirect to dashboard
      // The preview tab can only be created with proper sandbox URL context
      router.replace('/dashboard');
    }
  }, [port, tabs, setActiveTab, router]);

  // The actual preview content is rendered by SessionTabsContainer in layout-content.tsx
  // This page renders nothing visible - it just ensures the tab is activated
  return null;
}
