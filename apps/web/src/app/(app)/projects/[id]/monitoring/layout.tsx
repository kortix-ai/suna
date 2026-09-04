'use client';

import { useParams } from 'next/navigation';

import { MonitoringTabs } from '@/features/workspace/capabilities/monitoring/monitoring-tabs';

/**
 * Shared shell for /projects/[id]/monitoring and /monitoring/runs — the same
 * shape as the `(capabilities)` layout: one bounded `h-svh` column, the tab
 * bar as its first in-flow child so it never remounts between tabs, and the
 * page below as the only scroller. See that layout for why `h-svh` is what
 * pins the bar.
 */
export default function MonitoringLayout({ children }: { children: React.ReactNode }) {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <MonitoringTabs projectId={projectId} />
      {children}
    </div>
  );
}
