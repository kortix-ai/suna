'use client';

import { LONG_AGO, relativeTime } from '@/lib/relative-time';
import { FactCell } from './fact-cell';

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
import {
  type FailedBuildRelevance,
  describeFailedBuild,
  formatSandboxProvider,
  formatSandboxProviders,
  isLegacySandboxProvider,
} from '@/features/workspace/project-sidebar/footer/sandbox-alert-state';
import { useSandboxRecovery } from '@/features/workspace/project-sidebar/footer/sandbox-health';
import { APP_REGISTRY_TRANSLATION_KEYS } from '@/i18n/app-registry-translation-keys.generated';
import { localizeUiCatalog } from '@/i18n/localize-ui-catalog';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
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
import { snapshotsQueryRetry } from './snapshots-query';

/** Build-status tile icons render solid/fill — a filled status glyph inside
 *  the colored tile, distinct from the app's default outline weight. */
const CheckCircleFilled = ({ className }: { className?: string }) => (
  <CheckCircleSolid className={className} weight="fill" />
);
const XCircleFilled = ({ className }: { className?: string }) => (
  <XCircleSolid className={className} weight="fill" />
);

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
  const t = useTranslations('settings.sandbox');
  if (!provider) return null;
  return (
    <Badge variant="muted" size="sm">
      {formatSandboxProvider(provider)}
      {isLegacySandboxProvider(provider) ? ` · ${t('provider.legacy')}` : null}
    </Badge>
  );
}

function formatBuildDuration(
  startedAt: string,
  finishedAt: string | null,
  copy: SnapshotMessages['duration'],
): string | null {
  if (!finishedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(finishedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const minutes = Math.round((end - start) / 60_000);
  if (minutes < 1) return copy.underMinute;
  if (minutes < 60) return copy.minutes(minutes);
  const hours = Math.round(minutes / 60);
  return copy.hours(hours);
}

/** The exact moment, for the detail grid — "how long ago" is already on the
 *  collapsed row, and a reader comparing a build against something that
 *  happened in their day needs the clock time, not an age. */
function formatStartedAt(input: string | null | undefined, locale = 'en'): string {
  if (!input) return '—';
  const t = new Date(input).getTime();
  if (!Number.isFinite(t)) return '—';
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(t);
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
  copy: Pick<SnapshotMessages, 'outcomes' | 'stale'> = {
    stale: STALE_FAILURE_SUMMARY,
    outcomes: {
      ready: 'Ready for new sessions',
      building: 'Being prepared now',
      blocked: 'New sessions can’t start on this',
      failed: 'Didn’t finish',
    },
  },
): BuildOutcome {
  const title = build.slug;
  const stale = relevance && relevance !== 'blocking' ? relevance : null;

  if (build.status === 'ready') {
    return { title, stale: null, summary: copy.outcomes.ready };
  }
  if (build.status === 'building') {
    return { title, stale: null, summary: copy.outcomes.building };
  }
  if (stale) {
    return { title, stale, summary: copy.stale[stale] };
  }
  return {
    title,
    stale: null,
    summary: relevance === 'blocking' ? copy.outcomes.blocked : copy.outcomes.failed,
  };
}

export function BuildDetails({
  build,
  providerMode = 'automatic',
  copy: copyOverride,
}: {
  build: ProjectSnapshotBuild;
  providerMode?: SandboxProviderMode;
  copy?: SnapshotMessages;
}) {
  const translatedCopy = useSnapshotMessages();
  const tSandbox = useTranslations('settings.sandbox');
  const copy = copyOverride ?? translatedCopy;
  const duration = formatBuildDuration(build.started_at, build.finished_at, copy.duration);
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
        <FactCell
          icon={LightningIcon}
          label={copy.facts.triggeredBy}
          value={build.source ? copy.sourceLabels[build.source] : copy.facts.unknown}
        />
        <FactCell
          icon={CalendarBlankIcon}
          label={copy.facts.started}
          value={formatStartedAt(build.started_at, copy.locale)}
        />
        <FactCell
          icon={TimerIcon}
          label={copy.facts.took}
          value={duration ?? (build.status === 'building' ? copy.facts.stillRunning : '—')}
        />
        {provider ? (
          <FactCell
            icon={HardDrivesIcon}
            label={copy.facts.runsOn}
            value={
              isLegacySandboxProvider(provider)
                ? `${formatSandboxProvider(provider)} · ${tSandbox('provider.legacy')}`
                : formatSandboxProvider(provider)
            }
          />
        ) : null}
      </dl>

      {/* The one string support will ask for, so it is copyable rather than
          something to transcribe out of a log by hand. */}
      <div className="bg-muted/40 flex items-center gap-2 rounded-sm py-1 pr-1 pl-2.5">
        <span className="text-muted-foreground shrink-0 text-xs">{copy.facts.imageId}</span>
        <code className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">
          {build.snapshot_name}
        </code>
        <CopyButton code={build.snapshot_name} size="sm" />
      </div>

      {build.status === 'failed' && build.error ? (
        <div className="space-y-2">
          <p className="text-foreground text-sm font-medium">{copy.categoryLabels[category]}</p>
          <p className="text-muted-foreground text-sm text-pretty">{copy.categoryHelp[category]}</p>
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
  copy: copyOverride,
}: {
  build: ProjectSnapshotBuild;
  /** Only reveal the resolved provider when the project has explicitly pinned one. */
  providerMode: SandboxProviderMode;
  /** How this build relates to the image the project boots today. */
  relevance?: FailedBuildRelevance | null;
  copy?: SnapshotMessages;
}) {
  const translatedCopy = useSnapshotMessages();
  const copy = copyOverride ?? translatedCopy;
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const status = localizeUiCatalog(BUILD_STATUS_TILE, tI18nComplete, APP_REGISTRY_TRANSLATION_KEYS)[
    build.status
  ];
  const { Icon } = status;
  const outcome = describeBuildOutcome(build, relevance, copy);
  const stale = outcome.stale;
  const timestamp = relativeTime(
    build.finished_at ?? build.started_at,
    copy.locale,
    Date.now(),
    LONG_AGO,
  );

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
                  {copy.statusLabels[build.status]}
                </Badge>
                {providerMode === 'pinned' ? <ProviderBadge provider={build.provider} /> : null}
              </div>
              {/* Where `kortix-tpl-…` used to be. The snapshot name identifies
                  nothing a reader recognises; the sentence does. */}
              <div className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs">
                <span className="truncate">{outcome.summary}</span>
                <span className="text-muted-foreground/40">
                  {tI18nComplete.raw('text3b9453dad42b')}
                </span>
                <span className="shrink-0 tabular-nums">{timestamp}</span>
              </div>
            </div>
            <ChevronDown className="text-muted-foreground duration-normal size-4 shrink-0 transition-transform ease-out group-data-[state=open]/build:rotate-180 motion-reduce:transition-none" />
          </div>
        </DisclosureTrigger>
        <DisclosureContent className="overflow-hidden" contentClassName="border-border border-t">
          <DisclosureBody className="px-4 py-4">
            <BuildDetails build={build} providerMode={providerMode} copy={copy} />
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

function EnvironmentSummary({
  status,
  copy,
}: {
  status: SandboxRuntimeStatus;
  copy: SnapshotMessages;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const summary = localizeUiCatalog(
    ENVIRONMENT_SUMMARY,
    tI18nComplete,
    APP_REGISTRY_TRANSLATION_KEYS,
  )[status.state];
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
        <p className="text-foreground text-sm font-medium text-balance">
          {copy.environment[status.state as 'ready' | 'building' | 'not_built'].title}
        </p>
        <p className="text-muted-foreground text-sm text-pretty">
          {copy.environment[status.state as 'ready' | 'building' | 'not_built'].body}
        </p>
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
      tileBg: string;
      iconColor: string;
      Icon: ComponentType<{ className?: string }>;
    }
  >
> = {
  ready: {
    tileBg: 'bg-kortix-green/15',
    iconColor: 'text-kortix-green',
    Icon: CheckCircleFilled,
  },
  building: {
    tileBg: 'bg-kortix-yellow/15',
    iconColor: 'text-kortix-yellow',
    Icon: Loading,
  },
  // Neutral, not tinted: nothing has happened yet, so the tile carries the
  // same outlined treatment a stale build row gets rather than borrowing a
  // status colour it has not earned.
  not_built: {
    tileBg: 'border-border border',
    iconColor: 'text-muted-foreground',
    Icon: StackIcon,
  },
};

function SandboxStatusBanner({
  status,
  canManage,
  isFixPending,
  isRetryPending,
  onFix,
  onRetry,
  copy: copyOverride,
}: {
  status: SandboxRuntimeStatus;
  canManage: boolean;
  isFixPending: boolean;
  isRetryPending: boolean;
  onFix: () => void;
  onRetry: () => void;
  copy?: SnapshotMessages;
}) {
  const translatedCopy = useSnapshotMessages();
  const copy = copyOverride ?? translatedCopy;
  const failure = status.current_failure;
  const blocked = status.state === 'blocked';
  const showFixAction = canManage && status.fix_with_agent_available;
  const failedAt = failure
    ? relativeTime(failure.finished_at ?? failure.started_at, copy.locale, Date.now(), LONG_AGO)
    : null;

  return (
    <div className="border-border bg-popover rounded-md border">
      <div className="flex items-start gap-3 px-4 py-3">
        <span
          className={cn(
            'inline-flex size-10 shrink-0 items-center justify-center self-start rounded-sm',
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
                {blocked ? copy.banner.blockedTitle : copy.banner.degradedTitle}
              </p>
              <p className="text-muted-foreground text-sm text-balance">
                {blocked
                  ? copy.banner.blockedBody
                  : copy.banner.degradedBody(
                      formatSandboxProviders(status.ready_providers),
                      formatSandboxProviders(status.failed_providers),
                    )}
              </p>
              {/* The category names the failure; without this line it names it
                  to a reader who cannot act on the name. */}
              {failure?.error_category ? (
                <p className="text-muted-foreground text-sm text-pretty">
                  {copy.categoryHelp[failure.error_category]}
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
                  {copy.categoryLabels[failure.error_category] ?? failure.error_category}
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
                  {copy.actions.fix}
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
                  {copy.actions.rebuild}
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

function HowItWorks({ copy }: { copy: SnapshotMessages }) {
  return (
    <section className="space-y-4">
      <SettingsSubsectionHeader title={copy.faq.title} />
      <ul className="space-y-2">
        {copy.faq.items.map(({ question, answer }) => (
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
                  <ChevronDown className="text-muted-foreground duration-normal size-4 shrink-0 transition-transform ease-out group-data-[state=open]/faq:rotate-180 motion-reduce:transition-none" />
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
  copy?: SnapshotMessages;
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
  copy: copyOverride,
}: SnapshotsTabViewProps) {
  const translatedCopy = useSnapshotMessages();
  const copy = copyOverride ?? translatedCopy;
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
            title={copy.view.loadFailed}
            description={errorMessage}
            action={
              <Button variant="outline" size="sm" onClick={onRetry}>
                {copy.view.retry}
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
              <EnvironmentSummary status={status} copy={copy} />
            ) : null}

            <section className="space-y-4">
              <SettingsSubsectionHeader
                title={copy.view.logTitle}
                description={copy.view.logDescription}
              />
              {templateBuilds.length === 0 ? (
                <div className="border-border rounded-md border">
                  <InlinePanelEmpty message={copy.view.empty} />
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

            <HowItWorks copy={copy} />
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
  const t = useTranslations('settings.snapshots');
  const locale = useLocale();
  const projectQuery = useQuery({
    queryKey: qk.project.summary(projectId),
    queryFn: () => getProject(projectId),
    ...contract('config'),
  });
  const canManage =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_SANDBOX_WRITE).allowed === true;

  const snapshotsQuery = useQuery({
    queryKey: qk.project.snapshots(projectId),
    queryFn: () => listProjectSnapshots(projectId),
    ...contract('config'),
    retry: snapshotsQueryRetry,
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
  const templateBuilds = builds;
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
    />
  );
}

type SnapshotMessages = ReturnType<typeof useSnapshotMessages>;
function useSnapshotMessages() {
  const t = useTranslations('settings.snapshots');
  const locale = useLocale();
  const categories = [
    'quota',
    'dockerfile',
    'layer',
    'git',
    'tunnel',
    'provider',
    'timeout',
    'runtime',
    'unknown',
  ] as const;
  const sources = [
    'session-start',
    'project-create',
    'cr-merge',
    'manual',
    'background',
    'startup',
  ] as const;
  const categoryLabels = Object.fromEntries(
    categories.map((key) => [key, t(`categories.${key}.label`)]),
  ) as Record<SnapshotErrorCategory, string>;
  const categoryHelp = Object.fromEntries(
    categories.map((key) => [key, t(`categories.${key}.help`)]),
  ) as Record<SnapshotErrorCategory, string>;
  const sourceLabels = Object.fromEntries(
    sources.map((key) => [key, t(`sources.${key}`)]),
  ) as Record<NonNullable<ProjectSnapshotBuild['source']>, string>;
  const copy = {
    locale,
    categoryLabels,
    categoryHelp,
    sourceLabels,
    statusLabels: {
      ready: t('statuses.ready'),
      building: t('statuses.building'),
      failed: t('statuses.failed'),
    },
    stale: {
      superseded: t('stale.superseded'),
      recovered: t('stale.recovered'),
      retrying: t('stale.retrying'),
    },
    outcomes: {
      ready: t('outcomes.ready'),
      building: t('outcomes.building'),
      blocked: t('outcomes.blocked'),
      failed: t('outcomes.failed'),
    },
    facts: {
      triggeredBy: t('facts.triggeredBy'),
      started: t('facts.started'),
      took: t('facts.took'),
      stillRunning: t('facts.stillRunning'),
      runsOn: t('facts.runsOn'),
      imageId: t('facts.imageId'),
      unknown: t('facts.unknown'),
    },
    duration: {
      underMinute: t('duration.underMinute'),
      minutes: (count: number) => t('duration.minutes', { count }),
      hours: (count: number) => t('duration.hours', { count }),
    },
    environment: {
      ready: { title: t('environment.ready.title'), body: t('environment.ready.body') },
      building: { title: t('environment.building.title'), body: t('environment.building.body') },
      not_built: { title: t('environment.notBuilt.title'), body: t('environment.notBuilt.body') },
    },
    banner: {
      blockedTitle: t('banner.blockedTitle'),
      degradedTitle: t('banner.degradedTitle'),
      blockedBody: t('banner.blockedBody'),
      degradedBody: (ready: string, failed: string) => t('banner.degradedBody', { ready, failed }),
    },
    actions: { fix: t('actions.fix'), rebuild: t('actions.rebuild') },
    faq: {
      title: t('faq.title'),
      items: [1, 2, 3].map((item) => ({
        question: t(`faq.items.${item}.question`),
        answer: t(`faq.items.${item}.answer`),
      })),
    },
    view: {
      loadFailed: t('view.loadFailed'),
      retry: t('view.retry'),
      logTitle: t('view.logTitle'),
      logDescription: t('view.logDescription'),
      empty: t('view.empty'),
    },
  };

  return copy;
}
