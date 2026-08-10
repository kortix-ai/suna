'use client';

/**
 * The Snapshots tab — the sandbox image build log: status banner, per-build
 * rows with error categories, and the project-accelerator section. **No
 * template form.** Split off `sandbox-view.tsx`'s `SandboxView`, which used
 * to render this content AND the sandbox template CRUD list together on one
 * 858-line page (Task 20's brief). Template list, create, edit, and delete
 * move to `sandbox-tab.tsx` instead — see that file's header comment.
 * `settings-panel.tsx:997-1003` used to leave `snapshots` on a bare
 * placeholder specifically BECAUSE mounting the unsplit `SandboxView` on
 * both tabs would have rendered this build log twice; that constraint is
 * what this split removes. `snapshots` stays deliberately absent from
 * `ACCOUNT_SCOPED_SETTINGS_TABS` in `settings-panel.tsx` — this tab is
 * project-scoped only, same as `sandbox`, and takes no
 * `ACCOUNT_TAB_PERMISSION` entry.
 *
 * **What moved here, verbatim, from `sandbox-view.tsx`:** `BuildRow`,
 * `isProjectAcceleratorBuild`, `SandboxStatusBanner`, `CATEGORY_LABEL`,
 * `BUILD_SOURCE_LABEL`, `BUILD_STATUS_TILE` (+ its `CheckCircleFilled`/
 * `XCircleFilled` icons), `STALE_FAILURE_LABEL`/`STALE_FAILURE_HINT`,
 * `ProviderBadge`, and `formatBuildDuration` — all per JAY-508's mapping of
 * `ProjectSnapshotBuild`/`ProjectSnapshotStatus` to the Snapshots half.
 * `formatRelative` also moved here (and is separately duplicated, not
 * shared, in `sandbox-tab.tsx` — see that file's header comment).
 *
 * **Gate — preserved exactly.** `canManage` is
 * `projectQuery.data?.effective_project_role === 'manager'`, byte-identical
 * to `sandbox-view.tsx`'s own computation — not re-derived from
 * `useProjectCan` or any other permission source in scope. It gates only
 * the status banner's Rebuild button (`SandboxStatusBanner`'s own prop),
 * matching the original exactly; the "Fix with agent" action there gates
 * separately on `status.fix_with_agent_available`, also unchanged.
 *
 * **`useTranslations('hardcodedUi')` removed** from `SandboxStatusBanner` —
 * same reasoning as `sandbox-tab.tsx`'s header comment: the one string it
 * routed through `next-intl` ("Fix with agent") is inlined as a literal,
 * checked against `translations/en.json`, matching the house pattern
 * (`general-tab.tsx`/`api-keys-tab.tsx`) and making this renderable under
 * `renderToStaticMarkup` with no `NextIntlClientProvider`.
 *
 * **`listProjectSnapshots` — shared endpoint, split rendering.** See
 * `sandbox-tab.tsx`'s header comment: both tabs call the identical
 * `useQuery({ queryKey: qk.project.snapshots(projectId), queryFn: () =>
 * listProjectSnapshots(projectId) })` against one backend endpoint; this
 * tab reads only the builds/status-shaped fields. This tab's own
 * `refetchInterval` polls only while a BUILD is `building` (the templates-
 * provider-state half of the original combined condition lives in
 * `sandbox-tab.tsx` instead).
 *
 * **The combined "fully empty" empty state is gone by construction** — see
 * `sandbox-tab.tsx`'s header comment for the general reasoning. This tab
 * keeps the per-section empty fallback `sandbox-view.tsx` already had for
 * an empty build log (`InlinePanelEmpty` inside the Build log section) and
 * simply omits the Project accelerator section when there are no
 * accelerator builds — no separate combined empty state is needed here
 * because both of those were already independent per-section checks in the
 * original, not part of the `isFullyEmpty` (templates-AND-builds) branch.
 *
 * **Test provenance.** `snapshots-tab.test.tsx` carries forward ALL of
 * `sandbox-view.test.tsx`'s coverage (`BuildRow`/`isProjectAcceleratorBuild`
 * — same assertions, import path updated) — see that test file's own header
 * comment.
 *
 * `SnapshotsTabView` is the pure, props-only half — `BuildRow` and
 * `SandboxStatusBanner` take only plain props/callbacks (no internal
 * `useMutation`/`useQueryClient` of their own — a design already true in
 * `sandbox-view.tsx`), so unlike `sandbox-tab.tsx`'s `templatesSlot`, no
 * slot is needed here: the whole build log renders directly from data
 * props. `SnapshotsTab` is the container: every hook only runs once this
 * tab is actually mounted, which `SettingsTabPane` in `settings-panel.tsx`
 * guarantees.
 */

import type { ComponentType } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Disclosure,
  DisclosureBody,
  DisclosureContent,
  DisclosureTrigger,
} from '@/components/ui/disclosure';
import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { SettingsSectionHeader } from '@/components/ui/settings-section-header';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/features/layout/section/error-state';
import { useSandboxRecovery } from '@/features/workspace/project-sidebar/footer/project-sandbox-alert';
import {
  type FailedBuildRelevance,
  describeFailedBuild,
  formatSandboxProviders,
} from '@/features/workspace/project-sidebar/footer/sandbox-alert-state';
import { relativeTime } from '@/lib/relative-time';
import { cn } from '@/lib/utils';
import {
  type ProjectSnapshotBuild,
  type ProjectSnapshotStatus,
  type SandboxRuntimeStatus,
  type SnapshotErrorCategory,
  getProject,
  listProjectSnapshots,
} from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import {
  CheckCircleIcon as CheckCircleSolid,
  CaretDownIcon as ChevronDown,
  WarningIcon as DangerTriangleSolid,
  ArrowClockwiseIcon as RefreshCw,
  SparkleIcon as SparklesSolid,
  XCircleIcon as XCircleSolid,
} from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import type { SandboxProviderMode } from '../../customize/sections/view/sandbox-provider-coverage';

/** Build-status tile icons render solid/fill — a filled status glyph inside
 *  the colored tile, distinct from the app's default outline weight. */
const CheckCircleFilled = ({ className }: { className?: string }) => (
  <CheckCircleSolid className={className} weight="fill" />
);
const XCircleFilled = ({ className }: { className?: string }) => (
  <XCircleSolid className={className} weight="fill" />
);

export const CATEGORY_LABEL: Record<SnapshotErrorCategory, string> = {
  quota: 'Snapshot quota reached',
  dockerfile: 'Dockerfile build failed',
  layer: 'Kortix runtime layer failed',
  git: 'Repository access failed',
  tunnel: 'Sandbox callback unreachable',
  provider: 'Sandbox provider error',
  timeout: 'Build timed out',
  runtime: 'Runtime artifact missing',
  unknown: 'Build failed',
};

export const BUILD_SOURCE_LABEL: Record<NonNullable<ProjectSnapshotBuild['source']>, string> = {
  'session-start': 'Session start',
  'project-create': 'Project created',
  'cr-merge': 'Code review merge',
  manual: 'Manual rebuild',
  background: 'Background sync',
  startup: 'Startup',
};

const BUILD_STATUS_TILE: Record<
  ProjectSnapshotStatus,
  {
    label: string;
    badgeVariant: 'success' | 'warning' | 'destructive';
    tileBg: string;
    iconColor: string;
    Icon: ComponentType<{ className?: string }>;
  }
> = {
  ready: {
    label: 'ready',
    badgeVariant: 'success',
    tileBg: 'bg-kortix-green/15',
    iconColor: 'text-kortix-green',
    Icon: CheckCircleFilled,
  },
  building: {
    label: 'building',
    badgeVariant: 'warning',
    tileBg: 'bg-kortix-yellow/15',
    iconColor: 'text-kortix-yellow',
    Icon: Loading,
  },
  failed: {
    label: 'failed',
    badgeVariant: 'destructive',
    tileBg: 'bg-kortix-red/15',
    iconColor: 'text-kortix-red',
    Icon: XCircleFilled,
  },
};

function ProviderBadge({ provider }: { provider: string | null | undefined }) {
  if (!provider) return null;
  return (
    <Badge variant="muted" size="sm">
      {provider === 'e2b' ? 'E2B' : provider.charAt(0).toUpperCase() + provider.slice(1)}
    </Badge>
  );
}

function formatBuildDuration(startedAt: string, finishedAt: string | null): string | null {
  if (!finishedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(finishedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const minutes = Math.round((end - start) / 60_000);
  if (minutes < 1) return 'under 1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}

function formatRelative(input: string | null | undefined): string {
  return relativeTime(input) || '—';
}

export function isProjectAcceleratorBuild(build: ProjectSnapshotBuild): boolean {
  return build.snapshot_name.startsWith('kortix-ppwarm-');
}

/**
 * A failed build that no longer describes anything bootable is history, and must
 * not keep shouting in red — that is exactly how an 11-day-old error passed for
 * a live outage. Only a failure that still blocks a session keeps the red tile.
 */
const STALE_FAILURE_LABEL: Record<Exclude<FailedBuildRelevance, 'blocking'>, string> = {
  superseded: 'superseded',
  recovered: 'resolved',
  retrying: 'retrying',
};

const STALE_FAILURE_HINT: Record<Exclude<FailedBuildRelevance, 'blocking'>, string> = {
  superseded: 'Built an older definition of this template. The current image has moved on.',
  recovered: 'This image is available now — nothing to fix.',
  retrying: 'A newer build of this same image is running.',
};

export function BuildRow({
  build,
  providerMode,
  relevance,
}: {
  build: ProjectSnapshotBuild;
  /** Only reveal the resolved provider when the project has explicitly pinned one. */
  providerMode: SandboxProviderMode;
  /** How this build relates to the image the project boots today. */
  relevance?: FailedBuildRelevance | null;
}) {
  const status = BUILD_STATUS_TILE[build.status];
  const { Icon } = status;
  const stale = relevance && relevance !== 'blocking' ? relevance : null;
  const duration = formatBuildDuration(build.started_at, build.finished_at);
  const sourceLabel = build.source ? BUILD_SOURCE_LABEL[build.source] : null;
  const timestamp = formatRelative(build.finished_at ?? build.started_at);
  const hasErrorDetails = build.status === 'failed' && !!build.error;
  const accelerator = isProjectAcceleratorBuild(build);

  const row = (
    <>
      <span
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-sm',
          stale ? 'border-border text-muted-foreground border' : status.tileBg,
        )}
      >
        <Icon className={cn('size-5 shrink-0', stale ? undefined : status.iconColor)} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              'truncate text-sm font-medium',
              stale ? 'text-muted-foreground' : 'text-foreground',
            )}
          >
            {accelerator ? 'Repository accelerator' : build.slug}
          </span>
          <Badge variant={stale ? 'muted' : status.badgeVariant} size="xs">
            {status.label}
          </Badge>
          {stale ? (
            <Hint label={STALE_FAILURE_HINT[stale]}>
              <Badge variant="muted" size="xs">
                {STALE_FAILURE_LABEL[stale]}
              </Badge>
            </Hint>
          ) : null}
          {providerMode === 'pinned' ? <ProviderBadge provider={build.provider} /> : null}
        </div>
        <div className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs">
          <span className="truncate font-mono">{build.snapshot_name}</span>
          {sourceLabel ? (
            <>
              <span className="text-muted-foreground/40">&bull;</span>
              <span className="shrink-0">{sourceLabel}</span>
            </>
          ) : null}
          {timestamp ? (
            <>
              <span className="text-muted-foreground/40">&bull;</span>
              <span className="shrink-0 tabular-nums">{timestamp}</span>
            </>
          ) : null}
        </div>
      </div>
      {build.status === 'building' ? null : duration ? (
        <span className="text-muted-foreground/70 shrink-0 font-mono text-xs tabular-nums">
          {duration}
        </span>
      ) : null}
      {hasErrorDetails ? (
        <ChevronDown className="text-muted-foreground size-4 shrink-0 transition-transform duration-150 ease-out group-data-[state=open]/build:rotate-180" />
      ) : null}
    </>
  );

  if (hasErrorDetails) {
    return (
      <li className="overflow-hidden transition-colors">
        <Disclosure
          className="group/build bg-popover overflow-hidden"
          variant="outline"
          transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
        >
          <DisclosureTrigger>
            <div className="flex w-full items-center gap-3 px-4 py-2">{row}</div>
          </DisclosureTrigger>
          <DisclosureContent className="overflow-hidden">
            <DisclosureBody className="bg-secondary space-y-2 rounded-t-lg px-4 py-3">
              {build.error_category ? (
                <Label className="text-foreground">{CATEGORY_LABEL[build.error_category]}</Label>
              ) : null}
              <pre className="bg-muted/50 text-muted-foreground max-h-28 overflow-auto rounded-sm text-xs wrap-break-word whitespace-pre-wrap">
                {build.error}
              </pre>
            </DisclosureBody>
          </DisclosureContent>
        </Disclosure>
      </li>
    );
  }

  return (
    <li className="group bg-popover rounded-md border transition-colors">
      <div className="flex items-center gap-3 px-4 py-2">{row}</div>
    </li>
  );
}

function InlinePanelEmpty({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
      <p className="text-muted-foreground text-sm text-balance">{message}</p>
    </div>
  );
}

/**
 * Shown only when a failure still bites — i.e. the API's derived state is
 * `blocked` (nothing bootable anywhere this project routes) or `degraded` (some
 * routable providers are fine, others aren't).
 *
 * It deliberately never renders the newest failed row on its own. A build row is
 * a record of one past attempt against one image identity; presenting it as the
 * present tense is what showed "Latest build failed" for eleven days while a
 * ready image was serving every session.
 */
function SandboxStatusBanner({
  status,
  canManage,
  isFixPending,
  isRetryPending,
  onFix,
  onRetry,
}: {
  status: SandboxRuntimeStatus;
  canManage: boolean;
  isFixPending: boolean;
  isRetryPending: boolean;
  onFix: () => void;
  onRetry: () => void;
}) {
  const failure = status.current_failure;
  const blocked = status.state === 'blocked';
  const showFixAction = canManage && status.fix_with_agent_available;
  const failedAt = failure ? formatRelative(failure.finished_at ?? failure.started_at) : null;

  return (
    <div className="border-border bg-popover rounded-md border">
      <div className="flex items-start gap-3 px-4 py-3">
        <span
          className={cn(
            'border-border inline-flex size-10 shrink-0 items-center justify-center self-start rounded-sm border',
            blocked ? 'bg-kortix-red/10 text-kortix-red' : 'bg-kortix-orange/10 text-kortix-orange',
          )}
        >
          {blocked ? (
            <XCircleSolid weight="fill" className="size-6 shrink-0" />
          ) : (
            <DangerTriangleSolid weight="fill" className="size-6 shrink-0" />
          )}
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-1">
              <p className="text-foreground text-sm font-medium text-balance">
                {blocked ? 'Sessions can’t start' : 'Some sessions won’t start'}
              </p>
              <p className="text-muted-foreground text-sm text-balance">
                {blocked
                  ? 'The image this project boots from failed to build, and no working copy is available. Every new session retries it and hits the same error.'
                  : `The image is ready on ${formatSandboxProviders(status.ready_providers)} but failing on ${formatSandboxProviders(status.failed_providers)}. Sessions routed there won’t start.`}
              </p>
              {failure ? (
                <InlineMeta>
                  <code className="bg-muted rounded-sm px-1.5 py-0.5 font-mono text-xs">
                    {failure.slug}
                  </code>
                  <span className="tabular-nums">{failedAt}</span>
                </InlineMeta>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {failure?.error_category ? (
                <Badge size="sm" variant={blocked ? 'destructive' : 'warning'}>
                  {CATEGORY_LABEL[failure.error_category] ?? failure.error_category}
                </Badge>
              ) : null}
              {showFixAction ? (
                <Button
                  size="sm"
                  className="gap-1.5 transition-transform active:scale-[0.96]"
                  disabled={isFixPending}
                  onClick={onFix}
                >
                  {isFixPending ? (
                    <Loading className="size-3.5 shrink-0" />
                  ) : (
                    <SparklesSolid className="size-3.5 shrink-0" />
                  )}
                  Fix with agent
                </Button>
              ) : null}
              {canManage ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  disabled={isRetryPending}
                  onClick={onRetry}
                >
                  {isRetryPending ? (
                    <Loading className="size-3.5 shrink-0" />
                  ) : (
                    <RefreshCw className="size-3.5 shrink-0" />
                  )}
                  Rebuild
                </Button>
              ) : null}
            </div>
          </div>
          {failure?.error ? (
            <pre className="bg-muted/50 text-muted-foreground max-h-36 overflow-auto rounded-sm p-2.5 text-xs wrap-break-word whitespace-pre-wrap">
              {failure.error}
            </pre>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export interface SnapshotsTabViewProps {
  isLoading?: boolean;
  isError?: boolean;
  errorMessage?: string;
  onRetry?: () => void;
  status?: SandboxRuntimeStatus | null;
  /** Byte-identical to `sandbox-tab.tsx`'s own `canManage` — see this
   *  file's header comment, "Gate — preserved exactly". Gates only the
   *  status banner's Rebuild button. */
  canManage?: boolean;
  isFixPending?: boolean;
  isRetryPending?: boolean;
  onFix?: () => void;
  /** Renamed from `sandbox-view.tsx`'s `onRetry` (the build-recovery retry)
   *  to avoid colliding with the query-level `onRetry` above. */
  onRetryBuild?: () => void;
  providerMode?: SandboxProviderMode;
  templateBuilds?: ProjectSnapshotBuild[];
  acceleratorBuilds?: ProjectSnapshotBuild[];
}

/** Presentational only — no hooks, no data fetching, no store or Supabase
 *  read. Kept separate from `SnapshotsTab` so this renders under
 *  `renderToStaticMarkup` with no `QueryClientProvider` — see
 *  `SandboxTabView` for the same split. Unlike that view, no slots are
 *  needed here — `BuildRow`/`SandboxStatusBanner` are already pure,
 *  props-only components (see this file's header comment). */
export function SnapshotsTabView({
  isLoading = false,
  isError = false,
  errorMessage = '',
  onRetry = () => {},
  status = null,
  canManage = false,
  isFixPending = false,
  isRetryPending = false,
  onFix = () => {},
  onRetryBuild = () => {},
  providerMode = 'automatic',
  templateBuilds = [],
  acceleratorBuilds = [],
}: SnapshotsTabViewProps) {
  // Only these two states mean a user is actually affected right now.
  // Everything else — including a failed build whose image the provider has
  // since brought up — belongs in the log below, not in a banner. Same
  // condition as `sandbox-view.tsx`'s own `showStatusBanner`.
  const showStatusBanner = status?.state === 'blocked' || status?.state === 'degraded';

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10">
      <div className="space-y-8">
        <SettingsSectionHeader
          title="Snapshots"
          description="Build log, image status, and failure recovery for this project's sandbox templates."
        />
        {isLoading ? (
          <div className="space-y-1">
            {['snapshot-skeleton-1', 'snapshot-skeleton-2', 'snapshot-skeleton-3'].map((row) => (
              <Skeleton key={row} className="h-16 rounded-md" />
            ))}
          </div>
        ) : isError ? (
          <ErrorState
            size="sm"
            title="Failed to load sandbox snapshots:"
            description={errorMessage}
            action={
              <Button variant="outline" size="sm" onClick={onRetry}>
                Retry
              </Button>
            }
          />
        ) : (
          <>
            {showStatusBanner && status ? (
              <SandboxStatusBanner
                status={status}
                canManage={canManage}
                isFixPending={isFixPending}
                isRetryPending={isRetryPending}
                onFix={onFix}
                onRetry={onRetryBuild}
              />
            ) : null}

            <section className="space-y-4">
              <SettingsSectionHeader title="Build log" />
              {templateBuilds.length === 0 ? (
                <div className="border-border rounded-md border">
                  <InlinePanelEmpty message="No builds recorded yet. The platform default builds once globally; custom templates build on first use." />
                </div>
              ) : (
                <ul className="space-y-2">
                  {templateBuilds.slice(0, 10).map((b) => (
                    <BuildRow
                      key={b.build_id}
                      build={b}
                      providerMode={providerMode}
                      relevance={describeFailedBuild(b, status)}
                    />
                  ))}
                </ul>
              )}
            </section>

            {acceleratorBuilds.length > 0 ? (
              <section className="space-y-4">
                <SettingsSectionHeader title="Project accelerator" />
                <InfoBanner
                  tone="neutral"
                  icon={SparklesSolid}
                  title="Optional repository acceleration"
                >
                  A project accelerator preloads this repository for a later session. A missing or
                  failed accelerator never blocks a session. Kortix uses the shared session runtime
                  and clones the repository into <code className="font-mono">/workspace</code>.
                </InfoBanner>
                <ul className="space-y-2">
                  {acceleratorBuilds.slice(0, 5).map((b) => (
                    <BuildRow key={b.build_id} build={b} providerMode={providerMode} />
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/** Container: owns every hook (project + snapshots queries, sandbox
 *  recovery mutations) and renders `SnapshotsTabView` with real data. Only
 *  ever mounted while this tab is active (`SettingsTabPane` in
 *  `settings-panel.tsx` returns `null` otherwise), so nothing here fetches
 *  on panel open. */
export function SnapshotsTab({ projectId }: { projectId: string }) {
  const projectQuery = useQuery({
    queryKey: qk.project.summary(projectId),
    queryFn: () => getProject(projectId),
    ...contract('config'),
  });
  // Byte-identical to `sandbox-tab.tsx`'s own gate — see this file's header
  // comment, "Gate — preserved exactly".
  const canManage = projectQuery.data?.effective_project_role === 'manager';

  const snapshotsQuery = useQuery({
    queryKey: qk.project.snapshots(projectId),
    queryFn: () => listProjectSnapshots(projectId),
    ...contract('config'),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const builds = Array.isArray(data.builds) ? data.builds : [];
      return builds.some((b) => b.status === 'building') ? 5_000 : false;
    },
  });
  const { fixWithAgent, retry } = useSandboxRecovery(projectId);

  const data = snapshotsQuery.data;
  const builds = Array.isArray(data?.builds) ? data.builds : [];
  const providerMode: SandboxProviderMode =
    data?.provider_mode === 'pinned' ? 'pinned' : 'automatic';
  const templateBuilds = builds.filter((build) => !isProjectAcceleratorBuild(build));
  const acceleratorBuilds = builds.filter(isProjectAcceleratorBuild);
  const status = data?.status ?? null;

  return (
    <SnapshotsTabView
      isLoading={snapshotsQuery.isLoading}
      isError={snapshotsQuery.isError}
      errorMessage={(snapshotsQuery.error as Error)?.message ?? ''}
      onRetry={() => snapshotsQuery.refetch()}
      status={status}
      canManage={canManage}
      isFixPending={fixWithAgent.isPending}
      isRetryPending={retry.isPending}
      onFix={() => fixWithAgent.mutate()}
      onRetryBuild={() => retry.mutate(status?.current_failure?.template_slug)}
      providerMode={providerMode}
      templateBuilds={templateBuilds}
      acceleratorBuilds={acceleratorBuilds}
    />
  );
}
