'use client';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/features/layout/section/error-state';
import { FeatureGateScreen } from '@/features/workspace/feature-gate-screen';
import { useFeatureFlag, useProjectTriggers } from '@kortix/sdk/react';

import { TriggerRuns } from './trigger-runs';
import { useMonitoringSessions } from './use-monitoring-sessions';

const DESCRIPTION =
  'Every session a schedule, webhook, or monitor started, under its trigger. Open a trigger to see all of its runs.';

/**
 * /projects/[id]/monitoring/runs — trigger runs. Shares the board's session
 * query (one cache entry, no refetch on tab switch) and adds the trigger list.
 */
export function TriggerRunsPage({ projectId }: { projectId: string }) {
  const gate = useFeatureFlag(projectId, 'monitoring');
  const sessions = useMonitoringSessions(projectId, gate.enabled);
  const triggers = useProjectTriggers(gate.enabled ? projectId : null);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col space-y-4 px-4 py-6 pb-20 md:px-8">
        {gate.isLoading ? (
          <Skeleton className="h-24 w-full rounded-md" />
        ) : !gate.enabled ? (
          <FeatureGateScreen featureName="Monitoring" description={DESCRIPTION} />
        ) : (
          <>
            <p className="text-muted-foreground text-sm text-balance">{DESCRIPTION}</p>
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
          </>
        )}
      </div>
    </div>
  );
}
