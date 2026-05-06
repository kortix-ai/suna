'use client';

/**
 * Global milestones page — single-sandbox.
 *
 * Renders the milestones view for `proj-workspace`. Sibling to /board, /team.
 * Gated by `featureFlags.enableProjects`.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { featureFlags } from '@/lib/feature-flags';
import { MilestonesTab } from '@/components/kortix/milestones-tab';

const PROJECT_ID = 'proj-workspace';

function MilestonesRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/workspace'); }, [router]);
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      Redirecting to workspace…
    </div>
  );
}

export default function MilestonesPage() {
  if (!featureFlags.enableProjects) return <MilestonesRedirect />;
  return (
    <div className="flex h-full flex-col">
      <MilestonesTab projectId={PROJECT_ID} />
    </div>
  );
}
