'use client';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useOptionalSidebar } from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { FeatureGateScreen } from '@/features/workspace/feature-gate-screen';
import { SidebarToggle } from '@/features/workspace/project-layout/sidebar-toggle';
import { projectSessionsRefetchInterval } from '@/features/workspace/project-sidebar/project-session-list-helpers';
import { listProjectSessions, type ProjectSession } from '@kortix/sdk';
import { contract, qk, useFeatureFlag, useProjectTriggers } from '@kortix/sdk/react';
import { ArrowUpRightIcon, KanbanIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';

import { StageBoard } from './stage-board';
import { TriggerRuns } from './trigger-runs';

const DESCRIPTION =
  'Where every session is in its work — agents move their own card with `kortix sessions stage`, and a card parked in Ready waits for your approval.';

function MonitoringHeader() {
  const sidebar = useOptionalSidebar();
  return (
    <div
      className="kx-titlebar-row relative flex shrink-0 items-center gap-1 border-b px-2"
      data-sidebar-collapsed={sidebar?.state === 'collapsed' || undefined}
    >
      <SidebarToggle />
      <div className="flex min-w-0 flex-1 items-center gap-2 px-3 py-3">
        <h1 className="text-foreground shrink-0 text-sm font-medium">Monitoring</h1>
      </div>
      <Link
        href="/docs/feature-flags/monitoring"
        target="_blank"
        rel="noopener noreferrer"
        prefetch={false}
        className="text-muted-foreground hover:text-foreground flex w-fit flex-none items-center gap-1 px-3 py-3 text-sm font-medium whitespace-nowrap transition-colors"
      >
        Docs
        <ArrowUpRightIcon className="size-3 opacity-60" aria-hidden />
      </Link>
    </div>
  );
}

function BoardSkeleton() {
  return (
    <div className="flex gap-3 overflow-hidden">
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-48 w-72 shrink-0 rounded-md" />
      ))}
    </div>
  );
}

/**
 * /projects/[id]/monitoring — the stage board over every session the caller
 * can see, then each trigger's runs. Same shell as Apps: a bounded `h-svh`
 * column, a title bar with the sidebar toggle, one scroll box below it.
 *
 * Reads the SAME `qk.project.sessions(projectId)` entry the sidebar polls, at
 * the sidebar's cadence, so a board move (which invalidates the family) and a
 * session the agent renames land in both at once — no second transport.
 */
export function MonitoringPage({ projectId }: { projectId: string }) {
  const gate = useFeatureFlag(projectId, 'monitoring');
  const sessions = useQuery({
    queryKey: qk.project.sessions(projectId),
    queryFn: () => listProjectSessions(projectId),
    enabled: gate.enabled,
    refetchInterval: (query) =>
      projectSessionsRefetchInterval({
        sessions: query.state.data as ProjectSession[] | undefined,
        hasOpenSession: true,
      }),
    refetchOnWindowFocus: true,
    ...contract('inventory'),
  });
  const triggers = useProjectTriggers(gate.enabled ? projectId : null);

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <MonitoringHeader />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex min-h-full w-full flex-col space-y-8 px-4 py-6 pb-20 md:px-8">
          {gate.isLoading ? (
            <BoardSkeleton />
          ) : !gate.enabled ? (
            <FeatureGateScreen featureName="Monitoring" description={DESCRIPTION} />
          ) : (
            <>
              <section className="space-y-4">
                <div className="space-y-1">
                  <Label>Stage board</Label>
                  <p className="text-muted-foreground text-sm text-balance">{DESCRIPTION}</p>
                </div>
                {sessions.isLoading ? (
                  <BoardSkeleton />
                ) : sessions.isError ? (
                  <ErrorState
                    size="sm"
                    title="Could not load sessions"
                    action={
                      <Button variant="outline" size="sm" onClick={() => void sessions.refetch()}>
                        Retry
                      </Button>
                    }
                  />
                ) : (sessions.data?.length ?? 0) === 0 ? (
                  <EmptyState
                    size="sm"
                    icon={KanbanIcon}
                    title="No sessions yet"
                    description="Start a session and its card appears in Backlog. The agent moves it from there."
                  />
                ) : (
                  <StageBoard projectId={projectId} sessions={sessions.data ?? []} />
                )}
              </section>

              <section className="space-y-4">
                <div className="space-y-1">
                  <Label>Trigger runs</Label>
                  <p className="text-muted-foreground text-sm text-balance">
                    Every session a schedule, webhook, or monitor started, under its trigger.
                  </p>
                </div>
                {triggers.isLoading || sessions.isLoading ? (
                  <Skeleton className="h-24 w-full rounded-md" />
                ) : triggers.isError ? (
                  <ErrorState
                    size="sm"
                    title="Could not load triggers"
                    action={
                      <Button variant="outline" size="sm" onClick={() => void triggers.refetch()}>
                        Retry
                      </Button>
                    }
                  />
                ) : (
                  <TriggerRuns
                    projectId={projectId}
                    sessions={sessions.data ?? []}
                    triggers={triggers.data?.triggers ?? []}
                  />
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
