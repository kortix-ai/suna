'use client';

import { use } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Container } from 'lucide-react';

import { getProject } from '@/lib/projects-client';
import { SandboxSnapshotCard } from '@/components/projects/sandbox-snapshot-card';

/**
 * Customize → Sandbox. The project's runtime image: per-commit snapshots that
 * every session boots from, their health, retention, and recovery (Retry /
 * Fix with agent). Env vars live under Secrets; this surface owns the image.
 */
export default function ProjectSandboxPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: projectId } = use(params);
  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId),
    staleTime: 20_000,
  });
  const canManage = projectQuery.data?.effective_project_role === 'manager';

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4">
        <Container className="h-4 w-4 text-muted-foreground" />
        <h1 className="text-sm font-semibold text-foreground">Sandbox</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8">
          <SandboxSnapshotCard projectId={projectId} canManage={!!canManage} />
        </div>
      </div>
    </div>
  );
}
