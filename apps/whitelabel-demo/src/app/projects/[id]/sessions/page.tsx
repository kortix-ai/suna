'use client';

/**
 * The isolation view: which end-user this browser is, and exactly which
 * sessions upstream is willing to hand it.
 *
 * It exists as its own URL so the two-browser check is a single step — sign in
 * as one email here, as another there, and compare. The session ids are printed
 * in full for the same reason: "the two lists are disjoint" is only convincing
 * if you can see the ids that are supposed to differ.
 */

import { ProjectShell } from '@/components/project-shell';
import { SessionIsolationPanel } from '@/components/session-isolation-panel';
import { Skeleton } from '@/components/ui/skeleton';
import { kortix } from '@/lib/kortix';
import { qk } from '@/lib/query-keys';
import { relativeTime } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';

export default function SessionIsolationPage() {
  return (
    <ProjectShell>
      <Isolation />
    </ProjectShell>
  );
}

function Isolation() {
  const params = useParams();
  const projectId = String(params.id);

  const sessions = useQuery({
    queryKey: qk.sessions(projectId),
    queryFn: () => kortix.project(projectId).sessions.list(),
    retry: false,
  });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-xl">
        <h1 className="text-sm font-medium">Who this browser is</h1>
        <p className="mb-3 mt-0.5 text-xs text-muted-foreground">
          One operator API key serves every Lumen user. This is what keeps them apart.
        </p>

        <SessionIsolationPanel projectId={projectId} />

        <h2 className="mt-6 text-sm font-medium">The sessions upstream returned</h2>
        <p className="mb-3 mt-0.5 text-xs text-muted-foreground">
          Exactly what the filtered read gave this browser — nothing is hidden client-side.
        </p>
        <div className="space-y-2">
          {sessions.isLoading &&
            Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 rounded-md" />)}
          {sessions.isError && (
            <p className="rounded-md border border-border bg-card px-3 py-2.5 text-xs text-muted-foreground">
              The session list could not be read just now.
            </p>
          )}
          {sessions.isSuccess && sessions.data.length === 0 && (
            <p className="rounded-md border border-border bg-card px-3 py-2.5 text-xs text-muted-foreground">
              No sessions are attributed to you in this project yet.
            </p>
          )}
          {(sessions.data ?? []).map((s) => (
            <Link
              key={s.session_id}
              href={`/projects/${projectId}/sessions/${s.session_id}`}
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
