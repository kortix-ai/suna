'use client';

import { Badge } from '@/components/ui/badge';
import Hint from '@/components/ui/hint';
import { Switch } from '@/components/ui/switch';
import { errorToast } from '@/components/ui/toast';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import {
  getProjectDetail,
  updateExperimentalFeature,
  type ProjectDetail,
} from '@kortix/sdk/projects-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/**
 * The `experimental_harnesses` per-project experiment, surfaced where users
 * actually hit its wall: the connect modal. Claude Code / Codex / Pi
 * subscriptions and keys can be connected any time, but those harnesses only
 * become SELECTABLE once the experiment is on — without this row, someone
 * connects Claude here and then can't see why the harness stays locked (the
 * only other switch lives in Customize → Settings → Experimental). Same flag,
 * same server catalog entry, same query cache as that Settings row, so the
 * two toggles can never disagree.
 */
export function MultiHarnessToggle({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  // PROJECT_WRITE is what gates the Settings experimental rows too — a
  // non-writer sees the state but can't flip it (the switch disables instead
  // of letting the mutation 403).
  const canWrite = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_WRITE).allowed === true;
  const detailQuery = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    staleTime: 60_000,
  });
  const feature = (detailQuery.data?.project?.experimental_features ?? []).find(
    (entry) => entry.key === 'experimental_harnesses',
  );

  const mutation = useMutation({
    mutationFn: (next: boolean) =>
      updateExperimentalFeature(projectId, 'experimental_harnesses', next),
    // Same cache choreography as the Settings row (`ExperimentalFeatureRow`),
    // so both surfaces flip together instantly.
    onSuccess: (updated) => {
      queryClient.setQueryData(['project', projectId], updated);
      queryClient.setQueryData<ProjectDetail | undefined>(
        ['project-detail', projectId],
        (current) => (current ? { ...current, project: updated } : current),
      );
      queryClient.invalidateQueries({ queryKey: ['project-detail', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to update multi-harness'),
  });

  // Platform doesn't support the experiment (or detail hasn't loaded) → no row.
  if (!feature?.available) return null;

  const row = (
    <div
      data-testid="multi-harness-toggle"
      className="bg-popover flex items-center justify-between gap-4 rounded-md border px-4 py-2.5"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="text-foreground text-sm font-medium">Multi-harness</p>
          <Badge variant="highlight" size="xs">
            Experimental
          </Badge>
        </div>
        <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
          Run sessions on Claude Code, Codex, and Pi in addition to OpenCode. May change between
          versions.
        </p>
      </div>
      <Switch
        data-testid="multi-harness-switch"
        aria-label="Multi-harness"
        checked={feature.enabled}
        disabled={!canWrite || mutation.isPending}
        onCheckedChange={(next) => mutation.mutate(next)}
      />
    </div>
  );

  if (canWrite) return row;
  return (
    <Hint side="top" className="text-xs" label="Only project editors can change this">
      {row}
    </Hint>
  );
}
