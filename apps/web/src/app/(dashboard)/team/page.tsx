'use client';

/**
 * Global team page — single-sandbox.
 *
 * Renders the team view (project_agents) for `proj-workspace`. Sibling to
 * /board, /milestones. Gated by `featureFlags.enableProjects`.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { featureFlags } from '@/lib/feature-flags';
import { TeamTab } from '@/components/kortix/team-tab';

const PROJECT_ID = 'proj-workspace';

function TeamRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/workspace'); }, [router]);
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      Redirecting to workspace…
    </div>
  );
}

export default function TeamPage() {
  if (!featureFlags.enableProjects) return <TeamRedirect />;
  return (
    <div className="flex h-full flex-col">
      <TeamTab projectId={PROJECT_ID} />
    </div>
  );
}
