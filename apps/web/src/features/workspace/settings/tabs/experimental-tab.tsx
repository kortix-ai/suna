'use client';

/**
 * The Experimental tab — one row per `experimental_features` catalog entry
 * with its stability badge, each with an on/off switch. Split off
 * `settings-view.tsx`'s `ExperimentalCard` (Task 18's brief); the
 * sandbox-provider pin that used to render as the LAST row inside that same
 * disclosure moved to `general-tab.tsx` instead — see that file's header
 * comment — so it is deliberately NOT rendered here.
 *
 * **Design difference from the old `ExperimentalCard`.** The old card was a
 * collapsed `Disclosure` ("N features" / expand to see them) — reasonable
 * when it shared a page with General, Repository, and Automation and had to
 * stay out of the way. Now that Experimental is its own tab, collapsing it
 * behind a second click would just add a step to reach the only content the
 * tab has, so this renders the list flat, unconditionally open.
 *
 * **Per-row toggling without a slot-per-row.** Each row's on/off switch used
 * to be its own smart subcomponent (`ExperimentalFeatureRow`, its own
 * `useMutation`) — that doesn't fit the slot pattern (`connected-tab.tsx`'s
 * `githubAppSetupSlot`) because features are a DYNAMIC, server-driven list:
 * there's no fixed set of named slots to declare ahead of time. Instead,
 * `ExperimentalTabView`'s row is pure (no hooks) and takes `features` +
 * `pendingKeys` + `onToggle` as data/callback props; `ExperimentalTab` owns
 * ONE `useMutation` keyed by feature key, with an optimistic `pendingValues`
 * map so a just-clicked switch reflects its target position immediately
 * (same UX the old row's own `pendingValue` state gave, without needing a
 * `useState`+`useMutation` pair per row) — same reasoning `ProfileTabView`'s
 * `FactorRow` uses for a dynamic, server-driven list of MFA factors.
 *
 * `ExperimentalTabView` is the pure, props-only half — no hooks, no data
 * fetching — so it renders under `renderToStaticMarkup` (see
 * `experimental-tab.test.tsx`). `ExperimentalTab` is the container: every
 * hook only runs once this tab is actually mounted, which `SettingsTabPane`
 * in `settings-panel.tsx` guarantees happens only while this tab is active.
 */

import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/features/layout/section/error-state';
import Loading from '@/components/ui/loading';
import { SettingsSectionHeader } from '@/components/ui/settings-section-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { errorToast } from '@/components/ui/toast';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import {
  getProject,
  updateExperimentalFeature,
  type ExperimentalFeatureKey,
  type ExperimentalFeatureView,
  type ProjectDetail,
} from '@kortix/sdk';
import { contract, invalidateProject, qk, refreshProjectProviderState } from '@kortix/sdk/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

function ExperimentalFeatureRow({
  feature,
  pending,
  canManage,
  onToggle,
}: {
  feature: ExperimentalFeatureView;
  pending: boolean;
  canManage: boolean;
  onToggle: (key: string, next: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-foreground text-sm font-medium">{feature.name}</p>
          <Badge variant={feature.stability === 'beta' ? 'beta' : 'highlight'} size="sm">
            {feature.stability === 'beta' ? 'Beta' : 'Experimental'}
          </Badge>
        </div>
        <p className="text-muted-foreground mt-0.5 text-xs text-pretty">{feature.description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {pending ? <Loading className="text-muted-foreground size-3.5" /> : null}
        <Switch
          checked={feature.enabled}
          disabled={!canManage || pending}
          onCheckedChange={(v) => onToggle(feature.key, v)}
        />
      </div>
    </div>
  );
}

export interface ExperimentalTabViewProps {
  isLoading?: boolean;
  isError?: boolean;
  errorMessage?: string;
  onRetry?: () => void;
  /** Already filtered to `available` entries and already carrying any
   *  optimistic in-flight value on `enabled` — see `ExperimentalTab`'s
   *  header comment. */
  features?: ExperimentalFeatureView[];
  /** Feature keys with a mutation in flight — disables that row's switch
   *  and shows `Loading` beside it. */
  pendingKeys?: readonly string[];
  canManage?: boolean;
  onToggle?: (key: string, next: boolean) => void;
}

/** Presentational only — no hooks, no data fetching, no store or Supabase
 *  read. Kept separate from `ExperimentalTab` so this renders under
 *  `renderToStaticMarkup` without a `QueryClientProvider` — see
 *  `GeneralTabView` for the same split. Every prop is optional with a safe
 *  default so the bare `<ExperimentalTabView />` the test file renders shows
 *  the header and empty state fully formed. */
export function ExperimentalTabView({
  isLoading = false,
  isError = false,
  errorMessage = '',
  onRetry = () => {},
  features = [],
  pendingKeys = [],
  canManage = true,
  onToggle = () => {},
}: ExperimentalTabViewProps) {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-8 px-6 py-10">
      <SettingsSectionHeader
        title="Experimental"
        description="Early-access capabilities that may change or be removed."
      />

      {isLoading ? (
        <Skeleton className="h-40 rounded-md" />
      ) : isError ? (
        <ErrorState
          size="sm"
          title="Failed to load project"
          description={errorMessage}
          action={
            <Button variant="outline" size="sm" onClick={onRetry}>
              Retry
            </Button>
          }
        />
      ) : features.length === 0 ? (
        <p className="text-muted-foreground text-sm text-pretty">
          No experimental features are available on this project yet.
        </p>
      ) : (
        <div className="bg-popover divide-border divide-y rounded-md border">
          {features.map((feature) => (
            <ExperimentalFeatureRow
              key={feature.key}
              feature={feature}
              pending={pendingKeys.includes(feature.key)}
              canManage={canManage}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Container: owns every hook (React Query, IAM probe, the optimistic
 *  pending map) and renders `ExperimentalTabView` with real data + handlers.
 *  Only ever mounted while this tab is active (`SettingsTabPane` in
 *  `settings-panel.tsx` returns `null` otherwise), so nothing here fetches on
 *  panel open. */
export function ExperimentalTab({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();

  const projectQuery = useQuery({
    queryKey: qk.project.summary(projectId),
    queryFn: () => getProject(projectId),
    ...contract('config'),
  });

  const project = projectQuery.data;
  // Same manager-OR-project.write gate `settings-view.tsx`'s
  // `ExperimentalCard` used (it received `canManage={canEdit}` from
  // `SettingsView`, not the raw manager-only flag) — see `general-tab.tsx`'s
  // header comment for the full split.
  const canManage = project?.effective_project_role === 'manager';
  const canWrite = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_WRITE).allowed === true;
  const canEdit = canManage || canWrite;

  // Show the intended position while a toggle's request is in flight — same
  // reason the old per-row `pendingValue` state existed, now lifted to the
  // container since there's no per-row hook anymore (see this file's header
  // comment).
  const [pendingValues, setPendingValues] = useState<Record<string, boolean>>({});

  const toggleMutation = useMutation({
    mutationFn: ({ key, next }: { key: ExperimentalFeatureKey; next: boolean }) =>
      updateExperimentalFeature(projectId, key, next),
    onSettled: (_data, _error, variables) => {
      setPendingValues((prev) => {
        if (!(variables.key in prev)) return prev;
        const next = { ...prev };
        delete next[variables.key];
        return next;
      });
    },
    onSuccess: (updated, variables) => {
      queryClient.setQueryData(qk.project.summary(projectId), updated);
      queryClient.setQueryData<ProjectDetail | undefined>(qk.project.detail(projectId), (current) =>
        current ? { ...current, project: updated } : current,
      );
      void invalidateProject(queryClient, projectId);
      // Only projectId is known here, not the owning account_id, so this
      // can't target one qk.projects.list(accountId) entry —
      // qk.projects.scope() is the shared prefix every list form (every
      // account's, plus the accountless slot) lives under.
      queryClient.invalidateQueries({ queryKey: qk.projects.scope() });
      if (variables.key === 'llm_gateway') {
        refreshProjectProviderState(queryClient, projectId, { removeProjectScopedCache: true });
      }
    },
    onError: (error: Error, variables) => {
      errorToast(error.message || `Failed to update ${variables.key}`);
    },
  });

  const rawFeatures = (project?.experimental_features ?? []).filter((f) => f.available);
  const features = rawFeatures.map((f) => ({
    ...f,
    enabled: pendingValues[f.key] ?? f.enabled,
  }));

  const handleToggle = (key: string, next: boolean) => {
    setPendingValues((prev) => ({ ...prev, [key]: next }));
    toggleMutation.mutate({ key: key as ExperimentalFeatureKey, next });
  };

  return (
    <ExperimentalTabView
      isLoading={projectQuery.isLoading}
      isError={projectQuery.isError}
      errorMessage={(projectQuery.error as Error)?.message ?? ''}
      onRetry={() => projectQuery.refetch()}
      features={features}
      pendingKeys={Object.keys(pendingValues)}
      canManage={canEdit}
      onToggle={handleToggle}
    />
  );
}
