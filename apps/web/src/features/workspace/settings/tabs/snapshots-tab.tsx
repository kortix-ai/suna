'use client';

/**
 * The Snapshots tab — what Kortix prepared for this project, and when.
 *
 * **The problem this layout solves.** The pane used to open on a bare "Build
 * log" of `kortix-tpl-…` strings, provider names and raw stderr, with a
 * second "Project accelerator" section below it carrying an `InfoBanner` that
 * mentioned "the shared session runtime" and `/workspace`. Nothing on screen
 * said what a snapshot was, whether the project was currently fine, or how the
 * two sections related — so a reader who is not a platform engineer had no way
 * in. Every fact below is still here; the difference is that the plain-language
 * answer is on the surface and the jargon is one click down.
 *
 * The shape, top to bottom:
 *
 *  1. **The heading answers "what is this page".** The description lives in
 *     `rail.ts` beside the label (see `type.ts`), as does `docsHref` — which is
 *     why the Docs button in the heading is not built here.
 *  2. **One status surface, always.** `SandboxStatusBanner` when a failure
 *     still bites (`blocked` / `degraded`), `EnvironmentSummary` otherwise.
 *     A healthy project used to get nothing at all, so "is my project OK?"
 *     could only be answered by reading a log. `unknown` state and an absent
 *     `status` still render nothing — the API could not observe the providers,
 *     and inventing an answer is worse than none (see `SandboxRuntimeState`).
 *  3. **Every build row is a disclosure**, not only failed ones. Collapsed: the
 *     template name, a status badge, and one plain sentence saying what the row
 *     means. Expanded: the facts — trigger, start, duration, provider, image id
 *     (copyable), and for a failure the category, what it means in plain words,
 *     and the raw log.
 *  4. **"How this works"** — three questions that the pane provoked and never
 *     answered, including the one that matters most: a red row is not
 *     automatically a live outage.
 *
 * **Why the row body is `BuildDetails`, exported.** `DisclosureContent`
 * unmounts its children while closed (`disclosure.tsx` — `AnimatePresence`
 * with `{open && …}`), so a collapsed `BuildRow` renders none of them. A test
 * asserting "the provider is never named on Automatic" against a collapsed row
 * therefore passes no matter what the body does — it is structurally unable to
 * fail. `BuildDetails` is a separate exported component so that contract has
 * something real to assert against.
 *
 * **`describeBuildOutcome` is pure and exported** for the same reason
 * `resolveDisclosureToggle` is: it is the whole vocabulary decision — which
 * words a row uses for its state — and it should be testable without a DOM.
 *
 * **What the stale-failure badges became.** `superseded` / `resolved` /
 * `retrying` were `Badge`s whose meaning sat behind a `Hint`, i.e. a jargon
 * word with its explanation hidden on hover. They are now the row's summary
 * sentence ("Didn't finish, but a newer setup replaced it"). The tile logic is
 * unchanged and still load-bearing: a failure that no longer blocks anything
 * does not get a red tile, which is how an 11-day-old error once passed for a
 * live outage.
 *
 * **Provenance.** Split from `sandbox-view.tsx` per JAY-508; the template list,
 * create, edit and delete live in `sandbox-tab.tsx`. `snapshots` stays
 * deliberately absent from `ACCOUNT_SCOPED_SETTINGS_TABS` in
 * `settings-panel.tsx` — this tab is project-scoped only, same as `sandbox`,
 * and takes no `ACCOUNT_TAB_PERMISSION` entry.
 *
 * **Gate.** `canManage` probes `project.customize.write` — the leaf the rebuild
 * route asserts, and the same leaf `sandbox-tab.tsx` gates template CRUD on. It
 * gates only the status banner's Rebuild button; "Fix with agent" gates
 * separately on `status.fix_with_agent_available`, unchanged.
 *
 * **`listProjectSnapshots` — shared endpoint, split rendering.** Both tabs call
 * the identical `useQuery({ queryKey: qk.project.snapshots(projectId) })`
 * against one backend endpoint; this tab reads only the builds/status-shaped
 * fields, and its `refetchInterval` polls only while a BUILD is `building`.
 *
 * `SnapshotsTabView` is the pure, props-only half — no slots are needed, since
 * every component below takes plain props. `SnapshotsTab` is the container:
 * every hook only runs once this tab is mounted, which `SettingsTabPane` in
 * `settings-panel.tsx` guarantees.
 */

import type { ComponentType } from 'react';

import { CopyButton } from '@/components/markdown/copy-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Disclosure,
  DisclosureBody,
  DisclosureContent,
  DisclosureTrigger,
} from '@/components/ui/disclosure';
import { InlineMeta } from '@/components/ui/inline-meta';
import Loading from '@/components/ui/loading';
import { SettingsSubsectionHeader } from '@/components/ui/settings-subsection-header';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/features/layout/section/error-state';
import { useSandboxRecovery } from '@/features/workspace/project-sidebar/footer/project-sandbox-alert';
import {
  type FailedBuildRelevance,
  describeFailedBuild,
  formatSandboxProvider,
  formatSandboxProviders,
} from '@/features/workspace/project-sidebar/footer/sandbox-alert-state';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { relativeTime } from '@/lib/relative-time';
import { useProjectCan } from '@/lib/use-project-can';
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
  CalendarBlankIcon,
  CheckCircleIcon as CheckCircleSolid,
  CaretDownIcon as ChevronDown,
  WarningIcon as DangerTriangleSolid,
  HardDrivesIcon,
  LightningIcon,
  ArrowClockwiseIcon as RefreshCw,
  SparkleIcon as SparklesSolid,
  StackIcon,
  TimerIcon,
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

/**
 * What the category means, and what to do about it — one sentence each, no
 * jargon, addressed to whoever is reading the pane rather than to the engineer
 * who wrote the category.
 *
 * `CATEGORY_LABEL` alone names the failure without explaining it: "Kortix
 * runtime layer failed" tells a reader nothing they can act on. Every place
 * that shows a category now shows this line under it.
 */
export const CATEGORY_HELP: Record<SnapshotErrorCategory, string> = {
  quota:
    'This workspace has stored as many prepared machines as its plan allows. Delete a sandbox template you no longer use, or raise the limit, then build again.',
  dockerfile:
    'A command in this project’s Dockerfile returned an error. The log below ends on the command that failed.',
  layer:
    'The image built, but Kortix could not install its own tools on top of it. This is usually temporary — try building again.',
  git: 'Kortix could not read this project’s repository. Check that the repository connection is still authorised, then build again.',
  tunnel:
    'The new machine could not call back to Kortix while it was being set up. This is usually temporary — try building again.',
  provider:
    'The company that runs the machine returned an error. Nothing is wrong with your project — try building again.',
  timeout:
    'Preparing the machine took longer than the time limit allows. Move slow steps out of the Dockerfile, or try again when the provider is less busy.',
  runtime:
    'The machine was prepared, but a file Kortix needs at start-up was missing from it. Build again; if it repeats, the template’s base image is the place to look.',
  unknown: 'The build stopped on an error Kortix could not classify. The full log is below.',
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
      {formatSandboxProvider(provider)}
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

/** The exact moment, for the detail grid — "how long ago" is already on the
 *  collapsed row, and a reader comparing a build against something that
 *  happened in their day needs the clock time, not an age. */
const startedAtFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function formatStartedAt(input: string | null | undefined): string {
  if (!input) return '—';
  const t = new Date(input).getTime();
  if (!Number.isFinite(t)) return '—';
  return startedAtFormat.format(t);
}

export function isProjectAcceleratorBuild(build: ProjectSnapshotBuild): boolean {
  return build.snapshot_name.startsWith('kortix-ppwarm-');
}

/**
 * A failed build that no longer describes anything bootable is history, and must
 * not keep shouting in red — that is exactly how an 11-day-old error passed for
 * a live outage. Only a failure that still blocks a session keeps the red tile.
 */
const STALE_FAILURE_SUMMARY: Record<Exclude<FailedBuildRelevance, 'blocking'>, string> = {
  superseded: 'Didn’t finish, and a newer setup has replaced it',
  recovered: 'Didn’t finish, but the environment is ready now',
  retrying: 'Didn’t finish — a new attempt is running',
};

export interface BuildOutcome {
  /** Row title: what the reader named this thing, not what the platform calls it. */
  title: string;
  /** One sentence saying what this row means for the reader. No jargon. */
  summary: string;
  /** `null` unless this is a failure that no longer blocks anything. */
  stale: Exclude<FailedBuildRelevance, 'blocking'> | null;
}

/**
 * The whole vocabulary decision for one row, as data.
 *
 * Pure and exported so the wording — the part most likely to regress into
 * jargon — can be asserted directly, the same reasoning `disclosure.tsx` gives
 * for extracting `resolveDisclosureToggle`.
 */
export function describeBuildOutcome(
  build: ProjectSnapshotBuild,
  relevance?: FailedBuildRelevance | null,
): BuildOutcome {
  const accelerator = isProjectAcceleratorBuild(build);
  const title = accelerator ? 'Repository accelerator' : build.slug;
  const stale = relevance && relevance !== 'blocking' ? relevance : null;

  if (build.status === 'ready') {
    return {
      title,
      stale: null,
      summary: accelerator ? 'Head start ready for the next session' : 'Ready for new sessions',
    };
  }
  if (build.status === 'building') {
    return { title, stale: null, summary: 'Being prepared now' };
  }
  if (stale) {
    return { title, stale, summary: STALE_FAILURE_SUMMARY[stale] };
  }
  // An accelerator is a head start, never a dependency: its failure costs a few
  // seconds at session start and nothing else. Saying so on the row stops it
  // reading like an outage.
  if (accelerator) {
    return { title, stale: null, summary: 'Didn’t finish — sessions still start normally' };
  }
  return {
    title,
    stale: null,
    summary: relevance === 'blocking' ? 'New sessions can’t start on this' : 'Didn’t finish',
  };
}

/** One label/value cell in a build's detail grid. Shape-matched to
 *  `TemplateFact` in `sandbox-tab.tsx` so the two halves of the split read as
 *  one system; duplicated rather than imported, exactly like `formatRelative`,
 *  to keep this tab's chunk free of that file's mutations and modals. */
function BuildFact({
  icon: Icon,
  label,
  value,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5">
        <Icon className="text-muted-foreground size-4 shrink-0" />
        <span className="truncate text-sm" title={value}>
          {value}
        </span>
      </dd>
    </div>
  );
}

/**
 * Everything technical about one build — the half that used to be on the row
 * itself, now one click down.
 *
 * Exported because `DisclosureContent` unmounts while closed, so this is the
 * only way to assert its contract (see this file's header comment). The
 * provider rule is the reason that matters: a project on Automatic must never
 * be told which provider a build resolved to, and testing that through a
 * collapsed row would assert nothing.
 */
export function BuildDetails({
  build,
  providerMode = 'automatic',
}: {
  build: ProjectSnapshotBuild;
  providerMode?: SandboxProviderMode;
}) {
  const duration = formatBuildDuration(build.started_at, build.finished_at);
  const category = build.error_category ?? 'unknown';
  // Only a project that has explicitly pinned a provider gets told which one a
  // build resolved to — on Automatic the answer is an implementation detail
  // that changes under the reader.
  const provider = providerMode === 'pinned' ? build.provider : null;

  return (
    <div className="space-y-4">
      {/* `tabular-nums` on the grid: durations and clock times are the same
          digits repeated down every open row, and proportional figures make
          them wander. Matches `sandbox-tab.tsx`'s spec grid. */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-4 tabular-nums sm:grid-cols-3">
        <BuildFact
          icon={LightningIcon}
          label="Triggered by"
          value={build.source ? BUILD_SOURCE_LABEL[build.source] : 'Unknown'}
        />
        <BuildFact
          icon={CalendarBlankIcon}
          label="Started"
          value={formatStartedAt(build.started_at)}
        />
        <BuildFact
          icon={TimerIcon}
          label="Took"
          value={duration ?? (build.status === 'building' ? 'Still running' : '—')}
        />
        {provider ? (
          <BuildFact
            icon={HardDrivesIcon}
            label="Runs on"
            value={formatSandboxProvider(provider)}
          />
        ) : null}
      </dl>

      {/* The one string support will ask for, so it is copyable rather than
          something to transcribe out of a log by hand. */}
      <div className="bg-muted/40 flex items-center gap-2 rounded-sm py-1 pr-1 pl-2.5">
        <span className="text-muted-foreground shrink-0 text-xs">Image ID</span>
        <code className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">
          {build.snapshot_name}
        </code>
        <CopyButton code={build.snapshot_name} size="sm" />
      </div>

      {build.status === 'failed' && build.error ? (
        <div className="space-y-2">
          <p className="text-foreground text-sm font-medium">{CATEGORY_LABEL[category]}</p>
          <p className="text-muted-foreground text-sm text-pretty">{CATEGORY_HELP[category]}</p>
          <pre className="bg-muted/50 text-muted-foreground max-h-40 overflow-auto rounded-sm p-2.5 text-xs wrap-break-word whitespace-pre-wrap">
            {build.error}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

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
  const outcome = describeBuildOutcome(build, relevance);
  const stale = outcome.stale;
  const timestamp = formatRelative(build.finished_at ?? build.started_at);

  return (
    <li>
      {/* Every row opens, not only failed ones. A row that looked identical to
          its neighbour but silently refused to expand taught readers that the
          chevron meant nothing, so they stopped trying the rows that did hold
          an answer. */}
      <Disclosure
        className="group/build bg-popover overflow-hidden"
        variant="outline"
        transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
      >
        <DisclosureTrigger>
          <div className="focus-visible:ring-kortix-base hover:bg-foreground/[0.03] flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors outline-none focus-visible:ring-[0.6px]">
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
                  {outcome.title}
                </span>
                <Badge variant={stale ? 'muted' : status.badgeVariant} size="xs">
                  {status.label}
                </Badge>
                {providerMode === 'pinned' ? <ProviderBadge provider={build.provider} /> : null}
              </div>
              {/* Where `kortix-tpl-…` used to be. The snapshot name identifies
                  nothing a reader recognises; the sentence does. */}
              <div className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs">
                <span className="truncate">{outcome.summary}</span>
                <span className="text-muted-foreground/40">&bull;</span>
                <span className="shrink-0 tabular-nums">{timestamp}</span>
              </div>
            </div>
            <ChevronDown className="text-muted-foreground size-4 shrink-0 transition-transform duration-150 ease-out group-data-[state=open]/build:rotate-180" />
          </div>
        </DisclosureTrigger>
        <DisclosureContent className="overflow-hidden" contentClassName="border-border border-t">
          <DisclosureBody className="px-4 py-4">
            <BuildDetails build={build} providerMode={providerMode} />
          </DisclosureBody>
        </DisclosureContent>
      </Disclosure>
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
 * The calm half of the status pair: what a reader sees when nothing is wrong.
 *
 * The pane used to show a banner ONLY when a failure still bit, which meant a
 * healthy project opened onto a log with no verdict anywhere on it — the one
 * question a non-technical reader has ("is my project OK?") was answerable only
 * by interpreting rows. `blocked` and `degraded` still belong to
 * `SandboxStatusBanner`; `unknown` and an absent status render nothing, because
 * the API is telling us it could not observe the providers and a confident
 * "everything's fine" would be a fabrication.
 */
function EnvironmentSummary({ status }: { status: SandboxRuntimeStatus }) {
  const summary = ENVIRONMENT_SUMMARY[status.state];
  if (!summary) return null;
  const { Icon } = summary;

  return (
    <div className="border-border bg-popover flex items-start gap-3 rounded-md border px-4 py-3">
      <span
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-sm',
          summary.tileBg,
        )}
      >
        <Icon className={cn('size-5 shrink-0', summary.iconColor)} />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-foreground text-sm font-medium text-balance">{summary.title}</p>
        <p className="text-muted-foreground text-sm text-pretty">{summary.body}</p>
      </div>
    </div>
  );
}

/**
 * Keyed by `SandboxRuntimeStatus['state']` and deliberately PARTIAL: `blocked`
 * and `degraded` belong to `SandboxStatusBanner`, and `unknown` gets no entry
 * because the API is saying it could not observe the providers. A missing key
 * renders nothing, which is the honest answer in all three cases.
 */
const ENVIRONMENT_SUMMARY: Partial<
  Record<
    SandboxRuntimeStatus['state'],
    {
      title: string;
      body: string;
      tileBg: string;
      iconColor: string;
      Icon: ComponentType<{ className?: string }>;
    }
  >
> = {
  ready: {
    title: 'This project’s environment is ready',
    body: 'New sessions start on the prepared machine right away. There is nothing to do on this page.',
    tileBg: 'bg-kortix-green/15',
    iconColor: 'text-kortix-green',
    Icon: CheckCircleFilled,
  },
  building: {
    title: 'Preparing this project’s environment',
    body: 'A new machine is being prepared. Sessions started now wait for it to finish — they don’t fail.',
    tileBg: 'bg-kortix-yellow/15',
    iconColor: 'text-kortix-yellow',
    Icon: Loading,
  },
  // Neutral, not tinted: nothing has happened yet, so the tile carries the
  // same outlined treatment a stale build row gets rather than borrowing a
  // status colour it has not earned.
  not_built: {
    title: 'Nothing prepared yet',
    body: 'Kortix prepares a machine the first time you start a session here. Nothing needs to be set up in advance.',
    tileBg: 'border-border border',
    iconColor: 'text-muted-foreground',
    Icon: StackIcon,
  },
};

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
                  ? 'The machine this project boots from failed to build, and no working copy is available. Every new session retries it and hits the same error.'
                  : `The machine is ready on ${formatSandboxProviders(status.ready_providers)} but failing on ${formatSandboxProviders(status.failed_providers)}. Sessions routed there won’t start.`}
              </p>
              {/* The category names the failure; without this line it names it
                  to a reader who cannot act on the name. */}
              {failure?.error_category ? (
                <p className="text-muted-foreground text-sm text-pretty">
                  {CATEGORY_HELP[failure.error_category]}
                </p>
              ) : null}
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
                  className="gap-1.5 transition-transform active:scale-[0.96]"
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

/**
 * The three questions this pane provokes and never answered.
 *
 * Same disclosure shape as a build row, deliberately: a reader who has just
 * learned that rows open finds these open the same way. Last on the page —
 * a returning reader wants the log, and a first-time reader has the heading's
 * one-liner and the status panel before they get here.
 */
const HOW_IT_WORKS: readonly { question: string; answer: string }[] = [
  {
    question: 'What is a snapshot?',
    answer:
      'A snapshot is a machine that has already been set up: this project’s repository, its dependencies, and the Kortix tools, all installed ahead of time. Starting a session copies that prepared machine instead of installing everything from scratch, which is why a session is ready in seconds rather than minutes.',
  },
  {
    question: 'Why do new rows keep appearing?',
    answer:
      'Kortix prepares a new machine whenever the recipe changes — a new sandbox template, an edited Dockerfile, or a merged change — and each attempt gets its own row. Older rows are kept as a record. They are history, not a list of things to deal with.',
  },
  {
    question: 'One of them failed. Is that a problem?',
    answer:
      'Usually not. A failed attempt only matters while no working machine is left, and when that happens a banner appears at the top of this page with a Rebuild button. A failed row with no banner above it has already been replaced by one that worked.',
  },
];

function HowItWorks() {
  return (
    <section className="space-y-4">
      <SettingsSubsectionHeader title="How this works" />
      <ul className="space-y-2">
        {HOW_IT_WORKS.map(({ question, answer }) => (
          <li key={question}>
            <Disclosure
              className="group/faq bg-popover overflow-hidden"
              variant="outline"
              transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
            >
              <DisclosureTrigger>
                <div className="focus-visible:ring-kortix-base hover:bg-foreground/[0.03] flex w-full cursor-pointer items-center gap-3 px-4 py-3 transition-colors outline-none focus-visible:ring-[0.6px]">
                  <span className="text-foreground min-w-0 flex-1 text-sm font-medium text-pretty">
                    {question}
                  </span>
                  <ChevronDown className="text-muted-foreground size-4 shrink-0 transition-transform duration-150 ease-out group-data-[state=open]/faq:rotate-180" />
                </div>
              </DisclosureTrigger>
              <DisclosureContent
                className="overflow-hidden"
                contentClassName="border-border border-t"
              >
                <DisclosureBody className="px-4 py-3">
                  <p className="text-muted-foreground text-sm text-pretty">{answer}</p>
                </DisclosureBody>
              </DisclosureContent>
            </Disclosure>
          </li>
        ))}
      </ul>
    </section>
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
 *  needed here: every component below takes plain props. */
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
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <div className="space-y-8">
        {/* No `SettingsTabHeader` here any more. Snapshots merged INTO the
            Sandbox templates section — a snapshot is the build history of a
            sandbox template, not a separate pane — and `SandboxTabView`,
            mounted directly above this one on `/projects/[id]/config`, already
            renders the shared pane heading (title, description, and its own
            `docsHref` to the same `/docs/work/runtime` page). A second
            top-level heading here would be a duplicate, not a fix for the
            'snapshots' id no longer existing in either heading registry. */}
        {isLoading ? (
          <div className="space-y-2">
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
            ) : status ? (
              <EnvironmentSummary status={status} />
            ) : null}

            <section className="space-y-4">
              <SettingsSubsectionHeader
                title="Build log"
                description="One row for every time Kortix prepared a machine for this project. Open a row for the details."
              />
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
                {/* The `InfoBanner` that used to sit here said the same thing in
                    three sentences, two of which named the shared session
                    runtime and `/workspace`. One line, in the header the
                    section already has, says it to the reader who needs it. */}
                <SettingsSubsectionHeader
                  title="Project accelerator"
                  description="An optional head start: Kortix clones this repository in advance so a later session opens faster. A missing or failed accelerator never stops a session."
                />
                <ul className="space-y-2">
                  {acceleratorBuilds.slice(0, 5).map((b) => (
                    <BuildRow key={b.build_id} build={b} providerMode={providerMode} />
                  ))}
                </ul>
              </section>
            ) : null}

            <HowItWorks />
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
  const canManage =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE).allowed === true;

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
