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
 * **Ported from `main` at the settings-panel merge.** `main` shipped the same
 * split independently as a `feature-flags-view.tsx` section (#6279, commit
 * `287910d880`) in the legacy Customize vocabulary. That file is deleted with
 * the rest of that vocabulary; what it added over this tab was carried across
 * here rather than dropped: the three-arm `STABILITY_BADGE` (a `stable` flag
 * used to render as "Experimental"), the per-row origin line
 * (`originLabel`), the shared `EmptyState`, the canonical
 * `updateFeatureFlag` route, and the `project.customize.write` gate — see
 * `ExperimentalTab` for why that gate replaced manager-OR-project.write.
 * NOT carried across: `main`'s copy of `SandboxProviderRow` (this branch had
 * already moved that to `general-tab.tsx`), and its read off
 * `qk.project.detail` (every tab in this panel reads
 * `qk.project.summary`; switching one would be an inconsistency, and the
 * mutation below already writes BOTH cache entries so the flag-gated rail,
 * palette and sidebar update together either way).
 *
 * `ExperimentalTabView` is the pure, props-only half — no hooks, no data
 * fetching — so it renders under `renderToStaticMarkup` (see
 * `experimental-tab.test.tsx`). `ExperimentalTab` is the container: every
 * hook only runs once this tab is actually mounted, which `SettingsTabPane`
 * in `settings-panel.tsx` guarantees happens only while this tab is active.
 */

import { useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { errorToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import {
  getProject,
  updateFeatureFlag,
  type FeatureFlagKey,
  type FeatureFlagStability,
  type FeatureFlagView,
  type ProjectDetail,
} from '@kortix/sdk';
import { contract, invalidateProject, qk, refreshProjectProviderState } from '@kortix/sdk/react';
import { FlagIcon, MagnifyingGlassIcon as Search } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SettingsTabHeader } from '../settings-tab-header';

/**
 * Every stability the API can serve, each with its own badge. Ported verbatim
 * from `main`'s `feature-flags-view.tsx` (#6279), which added the third arm:
 * `FeatureFlagStability` is `experimental | beta | stable`, and the old
 * two-way ternary rendered a `stable` flag as "Experimental" — a wrong label,
 * not a compile error.
 *
 * `beta` and `highlight` are the same token pair today; they are kept distinct
 * so the two stabilities can diverge without touching call sites.
 */
const STABILITY_BADGE: Record<
  FeatureFlagStability,
  { label: string; variant: 'beta' | 'highlight' | 'outline' }
> = {
  experimental: { label: 'Experimental', variant: 'highlight' },
  beta: { label: 'Beta', variant: 'beta' },
  stable: { label: 'Stable', variant: 'outline' },
};

/**
 * The origin line under a flag: inherited platform default, or this project's
 * own choice. Ported from `main`'s `feature-flags-view.tsx`. `FeatureFlagView`
 * reports WHETHER the project overrode the flag, not what the default was — so
 * an overridden flag says only that, rather than guessing a default it cannot
 * see.
 */
function originLabel(feature: FeatureFlagView): string {
  if (feature.overridden) return 'Overridden for this project';
  return feature.enabled ? 'Default on' : 'Default off';
}

/**
 * Filter the flag list by a search term.
 *
 * Exported and pure so it can be tested directly: it lives in the container
 * (the view is deliberately hook-free), and the container needs a
 * `QueryClientProvider` to render, so this is the only way its branching gets
 * covered without a DOM.
 *
 * Matches `key` as well as `name` and `description`, and the key is the one
 * that earns its place: flags get turned on from docs, changelogs and support
 * threads that name the raw key (`llm_gateway`), not the display name ("LLM
 * gateway"). A search reading only `name` would miss the exact term the reader
 * was handed.
 *
 * A blank or whitespace-only query returns the input unchanged — same array,
 * so React Query's result keeps its identity and the list does not re-render
 * for a stray space.
 */
export function filterFeatures<T extends FeatureFlagView>(features: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return features;
  return features.filter(
    (f) =>
      f.name.toLowerCase().includes(q) ||
      f.key.toLowerCase().includes(q) ||
      (f.description ?? '').toLowerCase().includes(q),
  );
}

function ExperimentalFeatureRow({
  feature,
  pending,
  canManage,
  onToggle,
}: {
  feature: FeatureFlagView;
  pending: boolean;
  canManage: boolean;
  onToggle: (key: string, next: boolean) => void;
}) {
  const badge = STABILITY_BADGE[feature.stability] ?? STABILITY_BADGE.experimental;
  // The switch's accessible name, pointed at the row's VISIBLE name rather
  // than repeating the string in an `aria-label`. `main`'s
  // `feature-flags-view.tsx` used `aria-label={flag.name}`; the port dropped
  // it, leaving every toggle on this tab an unnamed `switch`. `aria-labelledby`
  // restores the name and keeps the spoken label identical to the printed one
  // — a rename cannot drift the two apart, and the visible text stays the
  // click target for "toggle Voice" style voice control.
  //
  // `feature.key` is the catalog's own unique identifier, so no `useId` is
  // needed and the row stays hook-free, which is what lets the view render
  // under `renderToStaticMarkup`.
  const nameId = `feature-flag-${feature.key}`;
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p id={nameId} className="text-foreground text-sm font-medium">
            {feature.name}
          </p>
          <Badge variant={badge.variant} size="sm">
            {badge.label}
          </Badge>
          <span className="text-muted-foreground/70 text-xs">{originLabel(feature)}</span>
        </div>
        <p className="text-muted-foreground mt-0.5 text-xs text-pretty">{feature.description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {pending ? <Loading className="text-muted-foreground size-3.5" /> : null}
        <Switch
          aria-labelledby={nameId}
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
  features?: FeatureFlagView[];
  /** Feature keys with a mutation in flight — disables that row's switch
   *  and shows `Loading` beside it. */
  pendingKeys?: readonly string[];
  canManage?: boolean;
  onToggle?: (key: string, next: boolean) => void;
  /**
   * Search text, CONTROLLED — the container owns it and hands down an already
   * filtered `features`.
   *
   * It is a prop rather than a `useState` here because this view is
   * deliberately hook-free so `renderToStaticMarkup` can render it with no
   * providers (see the header comment). The view still needs the text itself,
   * not just the filtered result: an empty list means "no matches for X" when
   * a query is active and "no feature flags at all" when it is not, and those
   * are different messages.
   */
  query?: string;
  onQueryChange?: (next: string) => void;
  /** Renders the "you need customize-write" line. Separate from `canManage`
   *  because the two differ while the IAM probe is still in flight: the
   *  switches are already disabled (fail-closed) but the reason is not yet
   *  known, and asserting a denial there would be a guess. Ported from
   *  `main`'s `feature-flags-view.tsx`. */
  showPermissionNotice?: boolean;
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
  showPermissionNotice = false,
  query = '',
  onQueryChange = () => {},
}: ExperimentalTabViewProps) {
  const searching = query.trim().length > 0;
  // Shown once there is something to search, or while a query is active so the
  // field does not vanish under the cursor the moment it matches nothing.
  const showSearch = features.length > 0 || searching;
  const pendingKeySet = new Set(pendingKeys);

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <SettingsTabHeader tab="experimental" />

      <div className="space-y-4">
        {!isLoading && !isError && showSearch ? (
          <InputGroupSearch>
            <InputGroupSearchIcon>
              <Search />
            </InputGroupSearchIcon>
            <InputGroupSearchInput
              placeholder="Search features"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              variant="popover"
            />
            <InputGroupSearchClear onClick={() => onQueryChange('')} />
          </InputGroupSearch>
        ) : null}

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
          // Two different nothings. A search that matches nothing is a dead end
          // you can back out of by clearing the field; a deployment with no flags
          // at all is a fact about the deployment. Showing the second in place of
          // the first reads as "this feature does not exist here" and sends the
          // reader looking for a problem that is one backspace away — the same
          // split `secrets-view.tsx` makes.
          searching ? (
            <p className="text-muted-foreground px-3 py-6 text-center text-xs">
              No matches for <span className="text-foreground font-mono">{query}</span>.
            </p>
          ) : (
            // The shared primitive, not a bare sentence — ported from `main`'s
            // `feature-flags-view.tsx`, which is what every other empty pane in
            // this panel renders.
            <EmptyState
              size="sm"
              icon={FlagIcon}
              title="No experimental features"
              description="This deployment exposes no per-project feature flags."
            />
          )
        ) : (
          <>
            <div className="bg-popover divide-border divide-y rounded-md border">
              {features.map((feature) => (
                <ExperimentalFeatureRow
                  key={feature.key}
                  feature={feature}
                  pending={pendingKeySet.has(feature.key)}
                  canManage={canManage}
                  onToggle={onToggle}
                />
              ))}
            </div>
            {showPermissionNotice ? (
              <p className="text-muted-foreground text-xs">
                You need the project&apos;s customize-write permission to change a feature flag.
              </p>
            ) : null}
          </>
        )}
      </div>
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
  // `project.customize.write`, NOT the old manager-OR-project.write gate this
  // tab inherited from `settings-view.tsx`'s `ExperimentalCard`. Ported from
  // `main`'s `feature-flags-view.tsx` (#6279), and verified against the route
  // rather than taken on trust: `PATCH /projects/:id/features` and its
  // deprecated `/experimental` alias run the SAME handler
  // (`apps/api/src/projects/routes/r6.ts:1203-1262`), which asserts
  // `PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE`. The old gate was wrong in both
  // directions — a manager without customize.write saw a switch the server
  // rejects, and a custom role holding customize.write but not project.write
  // saw it disabled.
  //
  // FAIL-CLOSED while the probe is in flight: `isLoading` is checked
  // explicitly, so a slow probe renders read-only rather than briefly offering
  // a toggle the server would reject.
  const writeCap = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE);
  const canEdit = !writeCap.isLoading && writeCap.allowed === true;

  // Show the intended position while a toggle's request is in flight — same
  // reason the old per-row `pendingValue` state existed, now lifted to the
  // container since there's no per-row hook anymore (see this file's header
  // comment).
  const [pendingValues, setPendingValues] = useState<Record<string, boolean>>({});

  const toggleMutation = useMutation({
    // The CANONICAL route (`PATCH /projects/:id/features`).
    // `updateExperimentalFeature` still exists as a deprecated alias on the
    // legacy `/experimental` path — same handler server-side, but new UI must
    // not call it (`main`, #6279).
    mutationFn: ({ key, next }: { key: FeatureFlagKey; next: boolean }) =>
      updateFeatureFlag(projectId, key, next),
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
      queryClient.setQueryData<ProjectDetail | undefined>(
        qk.project.detail(projectId),
        (current) => (current ? { ...current, project: updated } : current),
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

  const [query, setQuery] = useState('');

  const rawFeatures = (project?.experimental_features ?? []).filter((f) => f.available);
  const withPending = rawFeatures.map((f) => ({
    ...f,
    enabled: pendingValues[f.key] ?? f.enabled,
  }));

  const features = useMemo(() => filterFeatures(withPending, query), [withPending, query]);

  const handleToggle = (key: string, next: boolean) => {
    setPendingValues((prev) => ({ ...prev, [key]: next }));
    toggleMutation.mutate({ key: key as FeatureFlagKey, next });
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
      showPermissionNotice={!canEdit && !writeCap.isLoading}
      query={query}
      onQueryChange={setQuery}
    />
  );
}
