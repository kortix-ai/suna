'use client';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { FeatureGateScreen } from '@/features/workspace/feature-gate-screen';
import { useFeatureFlag } from '@kortix/sdk/react';
import { KanbanIcon } from '@phosphor-icons/react';

import { StageBoard } from './stage-board';
import { useMonitoringSessions } from './use-monitoring-sessions';

const DESCRIPTION =
  'Where every session is in its work. The agent moves its own card with `kortix sessions stage`; a card parked in Ready waits for your approval.';

function BoardSkeleton() {
  return (
    <div className="flex gap-2 overflow-hidden">
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-48 min-w-48 flex-1 rounded-md" />
      ))}
    </div>
  );
}

/**
 * /projects/[id]/monitoring — the stage board. The tab bar above it lives in
 * the route layout (`monitoring/layout.tsx`); this is the `flex-1` scroller
 * under it, the same split the Customize tabs use.
 */
export function StageBoardPage({ projectId }: { projectId: string }) {
  const gate = useFeatureFlag(projectId, 'monitoring');
  const sessions = useMonitoringSessions(projectId, gate.enabled);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex min-h-full w-full flex-col space-y-4 px-4 py-6 pb-20 md:px-8">
        {gate.isLoading ? (
          <BoardSkeleton />
        ) : !gate.enabled ? (
          <FeatureGateScreen featureName="Monitoring" description={DESCRIPTION} />
        ) : (
          <>
            <p className="text-muted-foreground text-sm text-balance">{DESCRIPTION}</p>
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
          </>
        )}
      </div>
    </div>
  );
}
