'use client';

import { ProjectShell } from '@/components/project-shell';
import { ProjectAccessPanel } from '@/components/project-access-panel';
import { Skeleton } from '@/components/ui/skeleton';
import { kortix } from '@/lib/kortix';
import { qk } from '@/lib/query-keys';
import { relativeTime } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';

export default function ProjectAccessPage() {
  return (
    <ProjectShell>
      <ProjectAccess />
    </ProjectShell>
  );
}

function ProjectAccess() {
  const params = useParams();
  const workspaceId = String(params.id);

  const sessions = useQuery({
    queryKey: qk.sessions(workspaceId),
    queryFn: () => kortix.project(workspaceId).sessions.list(),
    retry: false,
  });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-xl">
        <h1 className="text-sm font-medium">Project access</h1>
        <p className="mb-3 mt-0.5 text-xs text-muted-foreground">
          The wrapper uses its local application identity to enforce project
          ownership.
        </p>

        <ProjectAccessPanel workspaceId={workspaceId} />

        <h2 className="mt-6 text-sm font-medium">Sessions in this project</h2>
        <p className="mb-3 mt-0.5 text-xs text-muted-foreground">
          The project-scoped read returns every session in the project.
        </p>
        <div className="space-y-2">
          {sessions.isLoading &&
            Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-12 rounded-md" />
            ))}
          {sessions.isError && (
            <p className="rounded-md border border-border bg-card px-3 py-2.5 text-xs text-muted-foreground">
              The session list could not be read just now.
            </p>
          )}
          {sessions.isSuccess && sessions.data.length === 0 && (
            <p className="rounded-md border border-border bg-card px-3 py-2.5 text-xs text-muted-foreground">
              No sessions exist in this project yet.
            </p>
          )}
          {(sessions.data ?? []).map((s) => (
            <Link
              key={s.session_id}
              href={`/projects/${workspaceId}/sessions/${s.session_id}`}
              className="block rounded-md border border-border bg-card px-3 py-2.5 transition-colors hover:bg-accent/40"
            >
              <div className="truncate text-sm">
                {s.name || s.custom_name || s.branch_name || 'Untitled session'}
              </div>
              <div className="mt-0.5 break-all font-mono text-xs text-muted-foreground">
                {s.session_id}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground/70">
                {relativeTime(s.updated_at)}
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
