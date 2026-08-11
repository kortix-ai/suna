'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { WORKSPACE_ACTIONS } from '@/lib/workspace-actions';
import { useWorkspaceCan } from '@/lib/use-workspace-can';
import {
  getWorkspaceDetail,
  updateFeatureFlag,
  updateWorkspaceSandboxProvider,
  type FeatureFlagStability,
  type FeatureFlagView,
  type KortixWorkspace,
  type WorkspaceDetail,
  type SandboxProviderName,
} from '@kortix/sdk';
import {
  contract,
  invalidateWorkspace,
  qk,
  refreshWorkspaceProviderState,
} from '@kortix/sdk/react';
import { FlagIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import CustomizeSectionWrapper from '../component/section-wrapper';
import {
  applySandboxProviderResult,
  pollSandboxProviderTransition,
} from './sandbox-provider-result';

/**
 * Customize → Feature flags.
 *
 * The system is called "Feature flags". "Experimental", "Beta" and "Stable" are
 * per-flag STABILITY badges, not the name of the section — anything can ship
 * dark behind a flag, including a finished feature.
 *
 * Reads are consolidated onto the workspace DETAIL query (`qk.workspace.detail`) —
 * the same entry `useFeatureFlag`, the Customize rail, and the command palette
 * read — so one cache write lights every gated surface up together. The write
 * ALSO patches the summary entry because the PATCH response IS a `KortixWorkspace`
 * (the summary payload) and `settings-view` still renders off it.
 */
export function FeatureFlagsView({ workspaceId }: { workspaceId: string }) {
  const detailQuery = useQuery({
    queryKey: qk.workspace.detail(workspaceId),
    queryFn: () => getWorkspaceDetail(workspaceId),
    ...contract('config'),
  });

  // The API asserts `workspace.customize.write` on `PATCH /workspaces/:id/features`,
  // so the switches gate on exactly that leaf — not on `workspace.write` and not
  // on the manager role. FAIL-CLOSED while the probe is in flight: `isLoading`
  // is checked explicitly, so a slow probe renders read-only rather than
  // briefly offering a toggle the server would reject.
  const writeCap = useWorkspaceCan(workspaceId, WORKSPACE_ACTIONS.WORKSPACE_CUSTOMIZE_WRITE);
  const canWrite = !writeCap.isLoading && writeCap.allowed === true;

  const workspace = detailQuery.data?.workspace;
  // Server order is intentional (the registry's declaration order in
  // `apps/api/src/feature-flags/registry.ts`) — render it as served, never
  // re-sorted. Unavailable flags are not offered at all: the platform does not
  // support them here, so a switch would be a lie.
  const flags = (workspace?.experimental_features ?? []).filter((f) => f.available);

  return (
    <CustomizeSectionWrapper
      title="Feature flags"
      description="Turn individual platform capabilities on or off for this workspace."
    >
      {detailQuery.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[74px] rounded-md" />
          ))}
        </div>
      ) : detailQuery.isError ? (
        <ErrorState
          size="sm"
          title="Failed to load feature flags"
          description={(detailQuery.error as Error).message}
          action={
            <Button variant="outline" size="sm" onClick={() => detailQuery.refetch()}>
              Retry
            </Button>
          }
        />
      ) : (
        <div className="space-y-8">
          <section className="space-y-4">
            <Label>Flags</Label>
            {flags.length === 0 ? (
              <EmptyState
                size="sm"
                icon={FlagIcon}
                title="No feature flags"
                description="This deployment exposes no per-workspace feature flags."
              />
            ) : (
              <ul className="space-y-2">
                {flags.map((flag) => (
                  <li key={flag.key}>
                    <FeatureFlagRow workspaceId={workspaceId} flag={flag} canWrite={canWrite} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          {workspace ? (
            <section className="space-y-4">
              <Label>Runtime</Label>
              <SandboxProviderRow workspace={workspace} canWrite={canWrite} />
            </section>
          ) : null}

          {!canWrite && !writeCap.isLoading ? (
            <p className="text-muted-foreground text-xs">
              You need the workspace&apos;s customize-write permission to change a feature flag.
            </p>
          ) : null}
        </div>
      )}
    </CustomizeSectionWrapper>
  );
}

const STABILITY_BADGE: Record<
  FeatureFlagStability,
  { label: string; variant: 'beta' | 'highlight' | 'outline' }
> = {
  // `beta` and `highlight` are the same token pair today; they are kept
  // distinct so the two stabilities can diverge without touching call sites.
  experimental: { label: 'Experimental', variant: 'highlight' },
  beta: { label: 'Beta', variant: 'beta' },
  stable: { label: 'Stable', variant: 'outline' },
};

/** The origin line under a flag: inherited platform default, or this workspace's
 *  own choice. `FeatureFlagView` reports WHETHER the workspace overrode the flag,
 *  not what the default was — so an overridden flag says only that, rather than
 *  guessing a default it cannot see. */
function originLabel(flag: FeatureFlagView): string {
  if (flag.overridden) return 'Overridden for this workspace';
  return flag.enabled ? 'Default on' : 'Default off';
}

function FeatureFlagRow({
  workspaceId,
  flag,
  canWrite,
}: {
  workspaceId: string;
  flag: FeatureFlagView;
  canWrite: boolean;
}) {
  const queryClient = useQueryClient();
  // Show the intended position while the request is in flight. `flag.enabled`
  // only reflects server state, so without this the switch does not move at all
  // until the mutation resolves and a slow request looks like a frozen toggle.
  const [pendingValue, setPendingValue] = useState<boolean | null>(null);
  const badge = STABILITY_BADGE[flag.stability] ?? STABILITY_BADGE.experimental;

  const mutation = useMutation({
    // Canonical route: `PATCH /workspaces/:id/features`.
    mutationFn: (next: boolean) => updateFeatureFlag(workspaceId, flag.key, next),
    onSettled: () => setPendingValue(null),
    onSuccess: (updated) => {
      queryClient.setQueryData(qk.workspace.summary(workspaceId), updated);
      queryClient.setQueryData<WorkspaceDetail | undefined>(qk.workspace.detail(workspaceId), (current) =>
        current ? { ...current, workspace: updated } : current,
      );
      void invalidateWorkspace(queryClient, workspaceId);
      // Only workspaceId is passed down to this row, not the owning account_id,
      // so this can't target one qk.workspaces.list(accountId) entry —
      // qk.workspaces.scope() is the shared prefix every list form lives under.
      queryClient.invalidateQueries({ queryKey: qk.workspaces.scope() });
      if (flag.key === 'llm_gateway') {
        refreshWorkspaceProviderState(queryClient, workspaceId, {
          removeWorkspaceScopedCache: true,
        });
      }
    },
    onError: (error: Error) => errorToast(error.message || `Failed to update ${flag.name}`),
  });

  return (
    <div className="bg-popover flex items-start justify-between gap-4 rounded-md border px-4 py-3">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-foreground text-sm font-medium">{flag.name}</p>
          <Badge variant={badge.variant} size="sm">
            {badge.label}
          </Badge>
          <span className="text-muted-foreground/70 text-xs">{originLabel(flag)}</span>
        </div>
        <p className="text-muted-foreground text-xs text-pretty">{flag.description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        {mutation.isPending ? <Loading className="text-muted-foreground size-3.5" /> : null}
        <Switch
          aria-label={flag.name}
          checked={pendingValue ?? flag.enabled}
          disabled={!canWrite || mutation.isPending}
          onCheckedChange={(v) => {
            setPendingValue(v);
            mutation.mutate(v);
          }}
        />
      </div>
    </div>
  );
}

// Per-workspace sandbox-provider pin. Overrides the platform's weighted
// distribution for THIS workspace only (e.g. put one workspace on Platinum even
// when the fleet is mostly Daytona). Options come from the workspace payload
// (`available_sandbox_providers` = the usable set). It moved here with the flag
// list — it is the same kind of per-workspace platform override, and it was only
// ever reachable from inside the old collapsed disclosure. Hidden when no
// provider is usable.
const AUTO_PROVIDER = '__auto__';
function SandboxProviderRow({
  workspace,
  canWrite,
}: {
  workspace: KortixWorkspace;
  canWrite: boolean;
}) {
  const queryClient = useQueryClient();
  const available = workspace.available_sandbox_providers ?? [];
  const current = workspace.default_sandbox_provider ?? null;
  const label = (p: string) => p.charAt(0).toUpperCase() + p.slice(1);

  const mutation = useMutation({
    mutationFn: (next: SandboxProviderName | null) =>
      updateWorkspaceSandboxProvider(workspace.workspace_id, next),
    onSuccess: (result, next) => {
      // The PATCH returns EITHER the updated workspace (immediate) OR a
      // preparation object (the prepare branch — a switch to a different
      // enabled provider). Write the workspace cache ONLY for the immediate
      // result; a preparation is a transition, not a workspace, and must not
      // clobber the cached workspace shape.
      const kind = applySandboxProviderResult(queryClient, workspace.workspace_id, result);
      if (kind === 'preparation') {
        successToast(
          `Preparing ${next ? label(next) : 'the sandbox provider'}… this can take a few minutes`,
        );
        // Poll the durable transition (bounded, backoff, terminal-stop, 404 =
        // done) and refresh the workspace once it settles so the now-active
        // provider shows.
        void pollSandboxProviderTransition(workspace.workspace_id, {
          onSettled: (state) => {
            // invalidateWorkspace() reaches qk.workspace.scope(workspace.workspace_id),
            // which qk.workspace.summary(workspace.workspace_id) nests under — so it
            // already covers the bare-workspace row too.
            void invalidateWorkspace(queryClient, workspace.workspace_id);
            queryClient.invalidateQueries({ queryKey: qk.workspaces.scope() });
            const status = state?.latest?.status;
            if (status === 'activated') {
              successToast(`Switched to ${label(state?.latest?.target_provider ?? '')}`);
            } else if (status === 'failed') {
              errorToast(state?.latest?.label || 'Sandbox provider switch failed');
            }
          },
        });
      }
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to update sandbox provider'),
  });

  if (available.length === 0) return null;

  return (
    <div className="bg-popover flex items-start justify-between gap-4 rounded-md border px-4 py-3">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-foreground text-sm font-medium">Sandbox provider</p>
          <Badge variant="highlight" size="sm">
            Experimental
          </Badge>
        </div>
        <p className="text-muted-foreground text-xs text-pretty">
          Pin this workspace to a specific sandbox provider, overriding the platform default. New
          sessions here run on the chosen provider — “Automatic” follows the platform default.
        </p>
      </div>
      <Select
        value={current ?? AUTO_PROVIDER}
        onValueChange={(v) =>
          mutation.mutate(
            v === AUTO_PROVIDER ? null : (available.find((provider) => provider === v) ?? null),
          )
        }
        disabled={!canWrite || mutation.isPending}
      >
        <SelectTrigger className="w-40 shrink-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AUTO_PROVIDER}>Automatic</SelectItem>
          {available.map((p) => (
            <SelectItem key={p} value={p}>
              {label(p)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
