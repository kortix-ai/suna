'use client';

import { useParams } from 'next/navigation';

import { CapabilityTabs } from '@/features/workspace/capabilities/capability-tabs';

/**
 * Shared shell for /projects/[id]/{connectors,skills,commands}. The `(capabilities)`
 * route group keeps the segment out of the URL. The tab bar lives here — not
 * in each page — so it does not remount when switching tabs.
 */
export default function CapabilitiesLayout({ children }: { children: React.ReactNode }) {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <CapabilityTabs projectId={projectId} />
      {children}
    </div>
  );
}
