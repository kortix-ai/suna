'use client';

/**
 * /projects/[id]/admin — Project admin.
 *
 * Customize is agent-first: an agent's page configures what that agent draws
 * on. Project admin is the project-wide view, one full page with a rail in two
 * groups:
 *
 *  - **Project resources**: the GLOBAL variant of every library page
 *    (Connectors, Skills, Triggers, Loops, Models, Secrets, Apps), each the
 *    complete screen its Customize route renders, mounted with no props beyond
 *    `projectId`.
 *  - **Settings**: every section of the project Settings page
 *    (`project-settings-sections.ts`), plus the Members launcher.
 *
 * The section lives in `?section=<key>` (`projectAdminHref`); no query opens
 * the first resource the caller may open. Only the active section mounts, and
 * each one is a lazy chunk: opening Project admin loads one catalog, not all
 * twelve.
 *
 * Gated on `project.settings.write`, the Settings page's own leaf. Each row
 * then follows the rule its own surface already applies: a resource row
 * follows `capabilityAccess` (the Customize rule), a settings row follows
 * `isCustomizeSectionVisible` (the Settings page rule). Nothing renders until
 * those probes answer, so a row never appears and then leaves.
 *
 * Loops and Apps are pages of the host app, not of this package. The host
 * passes them in `hostSections`; a row without a page is not listed.
 */

import { lazy, Suspense, useCallback, useMemo, type ComponentType } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRightIcon, UsersIcon, type Icon } from '@phosphor-icons/react';

import { getProjectDetail } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';

import { useTranslations as useI18nTranslations } from '../../i18n';
import { Button } from '../../primitives/button';
import { EmptyState } from '../../primitives/empty-state';
import { ErrorState } from '../../primitives/error-state';
import { FadedScrollArea } from '../../primitives/faded-scroll-area';
import { SettingsSectionHeader } from '../../primitives/settings-section-header';
import { Skeleton } from '../../primitives/skeleton';
import { Tabs, TabsList, TabsTrigger } from '../../primitives/tabs';
import { UiLink as Link, useUiRouter, useUiSearchParams } from '../../providers/ui-provider';
import { CapabilitiesSkeleton } from '../../customize/shared/capability-skeleton';
import { buildStandaloneCapabilityNav } from '../../customize/shared/standalone-settings-nav';
import {
  projectSettingsSections,
  type ProjectSettingsSectionKey,
} from '../../customize/project-settings/project-settings-sections';
import { HubLink } from '../../internal/account-hub/account-hub-location';
import { SETTINGS_SIDEBAR_WIDTH_PX } from '../../internal/account-hub/account-settings-shell';
import { useIsMobile } from '../../internal/hooks';
import { capabilityAccess } from '../../internal/layout/project-settings-nav';
import { SettingsNavProvider, type SettingsNav } from '../../internal/layout/settings-nav-context';
import { withStaleChunkRecovery } from '../../internal/lib/chunk-reload';
import { detectManifestVersion } from '../../internal/lib/manifest-version';
import {
  CUSTOMIZE_SECTION_GATE_ACTIONS,
  isCustomizeSectionVisible,
  PROJECT_ACTIONS,
} from '../../internal/lib/project-actions';
import { useProjectCans, useProjectPageCans, type CanResult } from '../../internal/lib/use-project-can';
import { cn } from '../../internal/lib/utils';
import { hubTarget } from '../../internal/stores/account-panel-store';
import { useSettingsPanelStore, type MembersTab } from '../../internal/stores/settings-panel-store';

import {
  DEFAULT_PROJECT_ADMIN_SECTION,
  isProjectAdminResource,
  parseProjectAdminSection,
  PROJECT_ADMIN_RESOURCES,
  projectAdminHref,
  projectAdminNavTarget,
  type ProjectAdminResourceKey,
  type ProjectAdminSectionKey,
} from './project-admin-sections';

export {
  DEFAULT_PROJECT_ADMIN_SECTION,
  parseProjectAdminSection,
  projectAdminHref,
  type ProjectAdminSectionKey,
} from './project-admin-sections';

type SectionPage = ComponentType<{ projectId: string }>;

/** Pages that live in the host app (`apps/web`), passed in by its route. */
export type ProjectAdminHostSections = Partial<Record<'loops' | 'apps', SectionPage>>;

function lazyPage<M>(load: () => Promise<M>, pick: (mod: M) => SectionPage) {
  return lazy(withStaleChunkRecovery(() => load().then((mod) => ({ default: pick(mod) }))));
}

/* The package's own pages, one lazy chunk each, mounted exactly as their
   Customize routes mount them. */
const RESOURCE_PAGES: Partial<Record<ProjectAdminResourceKey, SectionPage>> = {
  connectors: lazyPage(() => import('../../customize/connectors/connectors-page'), (m) => m.ConnectorsPage),
  skills: lazyPage(() => import('../../customize/skills/skills-page'), (m) => m.SkillsPage),
  triggers: lazyPage(() => import('../../customize/triggers/triggers-page'), (m) => m.TriggersPage),
  models: lazyPage(() => import('../../customize/models/models-page'), (m) => m.ModelsPage),
  secrets: lazyPage(() => import('../../customize/secrets/secrets-page'), (m) => m.SecretsPage),
};

/* The Settings page's panes, mounted with the same props and in the same
   order `ProjectSettingsSectionPane` mounts them. */
const SETTINGS_PAGES: Record<ProjectSettingsSectionKey, SectionPage> = {
  general: lazyPage(() => import('../../customize/settings/tabs/general-tab'), (m) => m.GeneralTab),
  git: lazyPage(() => import('../../customize/sections/view/git-view'), (m) => {
    const { GitView } = m;
    return function GitSection({ projectId }) {
      const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
      return (
        <div className="mx-auto w-full max-w-2xl space-y-8">
          <SettingsSectionHeader
            title={tI18nComplete.raw('text95ddc9c4dfd3')}
            description={tI18nComplete.raw('texte0d7209f4c07')}
            className="pb-1"
          />
          <GitView projectId={projectId} />
        </div>
      );
    };
  }),
  sandbox: lazyPage(
    () =>
      Promise.all([
        import('../../customize/settings/tabs/sandbox-tab'),
        import('../../customize/settings/tabs/snapshots-tab'),
      ]),
    ([sandbox, snapshots]) => {
      const { SandboxTab } = sandbox;
      const { SnapshotsTab } = snapshots;
      return function SandboxSection({ projectId }) {
        return (
          <div className="space-y-8">
            <SandboxTab projectId={projectId} />
            <SnapshotsTab projectId={projectId} />
          </div>
        );
      };
    },
  ),
  review: lazyPage(() => import('../../customize/sections/view/review-view'), (m) => m.ReviewView),
  'feature-flags': lazyPage(
    () => import('../../customize/settings/tabs/experimental-tab'),
    (m) => m.ExperimentalTab,
  ),
  upgrades: lazyPage(() => import('../../customize/migrate-to-v2/upgrade-view'), (m) => m.UpgradesView),
};

interface RailRow {
  key: ProjectAdminSectionKey;
  label: string;
  icon: Icon;
  /** The orange dot: Upgrades on a v1 manifest. */
  attention?: boolean;
}

/** A verdict the engine returned: not a probe in flight, not a failed probe. */
function receivedDenial(result: CanResult | undefined): boolean {
  return !!result && !result.isLoading && !result.isError && !result.allowed;
}

function answered(caps: Record<string, CanResult>, actions: readonly string[]): boolean {
  return actions.every((action) => caps[action] && !caps[action].isLoading);
}

const NO_HOST_SECTIONS: ProjectAdminHostSections = {};

export function ProjectAdminDashboard({
  projectId,
  hostSections = NO_HOST_SECTIONS,
}: {
  projectId: string;
  hostSections?: ProjectAdminHostSections;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const isMobile = useIsMobile();
  const searchParams = useUiSearchParams();
  const router = useUiRouter();

  const detail = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
    ...contract('config'),
  });
  const accountId = detail.data?.project?.account_id;

  // One batch for the page gate, the resource rows and Members: the same
  // `PROJECT_PAGE_ACTIONS` batch the sidebar has usually cached already.
  const pageCans = useProjectPageCans(projectId);
  const settingsCans = useProjectCans(projectId, CUSTOMIZE_SECTION_GATE_ACTIONS, { accountId });
  const canAdmin = pageCans[PROJECT_ACTIONS.PROJECT_SETTINGS_WRITE];

  // The Customize rule for each library, without its flag clauses: a flag-off
  // Loops page explains its own gate (`FeatureGateScreen`) instead of
  // disappearing from the rail.
  const resources = capabilityAccess(pageCans, { drives: true, reminders: true });
  const settingsAnswered = answered(settingsCans, CUSTOMIZE_SECTION_GATE_ACTIONS);
  const settingsProbeFailed = CUSTOMIZE_SECTION_GATE_ACTIONS.some((action) => settingsCans[action]?.isError);
  const settled = !!canAdmin && !canAdmin.isLoading && resources.settled && settingsAnswered;

  const upgradeAttention = detail.data
    ? detectManifestVersion(detail.data.config.manifest_raw) === 1
    : false;

  // `resources.tabs` is a fresh array each render; its contents are the key.
  const allowedTabs = resources.tabs.join(',');
  const resourceRows = useMemo<RailRow[]>(() => {
    const allowed = new Set(allowedTabs.split(','));
    return PROJECT_ADMIN_RESOURCES.filter((r) => (r.host ? !!hostSections[r.key as 'loops' | 'apps'] : true))
      .filter((r) => !r.capability || allowed.has(r.capability))
      .map((r) => ({ key: r.key, label: r.label, icon: r.icon }));
  }, [hostSections, allowedTabs]);

  const settingsRows = useMemo<RailRow[]>(
    () =>
      projectSettingsSections(tI18nComplete)
        // The Settings page's rule: a failed probe hides nothing. The pane
        // itself reports a 403 if the server refuses it.
        .filter(
          (s) =>
            settingsProbeFailed ||
            isCustomizeSectionVisible(s.gate, (action) => settingsCans[action]?.allowed === true),
        )
        .map((s) => ({
          key: s.key,
          label: s.label,
          icon: s.icon,
          attention: s.key === 'upgrades' && upgradeAttention,
        })),
    [settingsCans, settingsProbeFailed, tI18nComplete, upgradeAttention],
  );

  const showMembers = !receivedDenial(pageCans[PROJECT_ACTIONS.PROJECT_MEMBERS_READ]);
  const rows = [...resourceRows, ...settingsRows];

  // A section named in the URL but not listed for this caller falls back to
  // the first listed row, so a stale link lands on a real pane.
  const requested = parseProjectAdminSection(searchParams.get('section'));
  const active: ProjectAdminSectionKey | undefined =
    (requested && rows.some((r) => r.key === requested) ? requested : undefined) ??
    (rows.some((r) => r.key === DEFAULT_PROJECT_ADMIN_SECTION) ? DEFAULT_PROJECT_ADMIN_SECTION : rows[0]?.key);

  const membersTab = useSettingsPanelStore((s) => s.membersTab);
  const navigateTo = useCallback((href: string) => router.push(href), [router]);
  const settingsNav = useMemo(
    () =>
      buildProjectAdminNav({
        projectId,
        section: active ?? DEFAULT_PROJECT_ADMIN_SECTION,
        membersTab,
        accountId,
        navigateTo,
      }),
    [projectId, active, membersTab, accountId, navigateTo],
  );

  // The gate probe failed: say so once, instead of guessing either way.
  if (canAdmin?.isError) {
    return <AdminAccessCheckFailed />;
  }

  if (settled && (receivedDenial(canAdmin) || rows.length === 0)) {
    return <AdminAccessDenied projectId={projectId} />;
  }

  const ActivePage = !active
    ? null
    : isProjectAdminResource(active)
      ? (RESOURCE_PAGES[active] ?? hostSections[active as 'loops' | 'apps'] ?? null)
      : SETTINGS_PAGES[active];

  const members = showMembers ? (
    <MembersRow projectId={projectId} accountId={accountId} horizontal={isMobile} />
  ) : null;

  return (
    <SettingsNavProvider value={settingsNav}>
      <div
        className={cn('min-h-0 flex-1 overflow-hidden', isMobile ? 'flex flex-col' : 'grid')}
        // The Settings page's rail width, so the two settings surfaces are one shape.
        style={isMobile ? undefined : { gridTemplateColumns: `${SETTINGS_SIDEBAR_WIDTH_PX}px 1fr` }}
      >
        {isMobile ? (
          <nav aria-label="Project admin" className="border-border/60 bg-background flex shrink-0 flex-col border-b">
            <h1 className="text-foreground px-4 pt-3 text-sm font-medium">Project admin</h1>
            <FadedScrollArea orientation="horizontal" fadeColor="from-background" className="min-w-0 flex-1 py-2">
              {settled ? (
                <Tabs value={active} className="w-fit">
                  <TabsList orientation="horizontal" className="w-fit">
                    {rows.map((row) => (
                      <RailTrigger key={row.key} projectId={projectId} row={row} horizontal />
                    ))}
                    {members}
                  </TabsList>
                </Tabs>
              ) : (
                <Skeleton className="mx-3 h-7 w-64 rounded-md" />
              )}
            </FadedScrollArea>
          </nav>
        ) : (
          <aside className="flex min-h-0 flex-col border-r bg-inherit">
            <nav
              aria-label="Project admin"
              className="flex min-h-0 flex-1 [scrollbar-width:none] flex-col gap-4 overflow-y-auto px-2 pt-4 pb-2 [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
            >
              <header className="space-y-1 px-2.5">
                <h1 className="text-foreground text-base font-medium">Project admin</h1>
                <p className="text-muted-foreground text-xs text-balance">
                  The libraries every agent draws from, and how this project runs.
                </p>
              </header>
              {settled ? (
                <Tabs value={active} orientation="vertical" className="gap-4">
                  {resourceRows.length > 0 ? (
                    <RailGroup label="Project resources">
                      {resourceRows.map((row) => (
                        <RailTrigger key={row.key} projectId={projectId} row={row} />
                      ))}
                    </RailGroup>
                  ) : null}
                  {settingsRows.length > 0 || members ? (
                    <RailGroup label="Settings">
                      {settingsRows.map((row) => (
                        <RailTrigger key={row.key} projectId={projectId} row={row} />
                      ))}
                      {members}
                    </RailGroup>
                  ) : null}
                </Tabs>
              ) : (
                <RailSkeleton />
              )}
            </nav>
          </aside>
        )}

        <main className="bg-background flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {settled && ActivePage && active ? (
            <Suspense key={active} fallback={<CapabilitiesSkeleton />}>
              {isProjectAdminResource(active) ? (
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  <ActivePage projectId={projectId} />
                </div>
              ) : (
                <div className="mx-auto flex min-h-0 w-full flex-1 flex-col space-y-6 overflow-y-auto px-4 py-10 pb-20 lg:py-14">
                  <ActivePage projectId={projectId} />
                </div>
              )}
            </Suspense>
          ) : (
            <CapabilitiesSkeleton />
          )}
        </main>
      </div>
    </SettingsNavProvider>
  );
}

/* ------------------------------------------------------------------ rail */

/** The account hub's group label dialect (`account-settings-sidebar.tsx`). */
function RailGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-muted-foreground flex h-8 items-center px-2.5 text-xs font-medium">{label}</p>
      <TabsList orientation="vertical" aria-label={label} className="w-full">
        {children}
      </TabsList>
    </div>
  );
}

/** The Settings page's rail-row dialect (`project-settings-page.tsx`). */
const ROW_CLASS = cn(
  'gap-2 px-2.5 py-1 font-normal transition-none has-[>svg]:px-2.5',
  'text-foreground data-[state=inactive]:text-foreground hover:bg-hover hover:text-foreground',
  'data-[state=active]:bg-active data-[state=active]:font-medium',
  '[&_svg]:text-muted-foreground data-[state=active]:[&_svg]:text-foreground',
);
const HORIZONTAL_ROW_CLASS = 'w-auto shrink-0 gap-2.5 px-3 py-0.75 whitespace-nowrap';

/** One row: a real link inside the trigger, since the section is URL state. */
function RailTrigger({
  projectId,
  row,
  horizontal = false,
}: {
  projectId: string;
  row: RailRow;
  horizontal?: boolean;
}) {
  const Glyph = row.icon;
  return (
    <TabsTrigger
      value={row.key}
      asChild
      size={horizontal ? undefined : 'md'}
      className={horizontal ? HORIZONTAL_ROW_CLASS : ROW_CLASS}
    >
      <Link href={projectAdminHref(projectId, row.key)} prefetch>
        <Glyph className="size-4 shrink-0" />
        <span className={cn(!horizontal && 'truncate')}>{row.label}</span>
        {row.attention ? (
          <span
            aria-hidden
            className={cn('bg-kortix-orange size-1.5 shrink-0 rounded-full', !horizontal && 'ml-auto')}
          />
        ) : null}
      </Link>
    </TabsTrigger>
  );
}

/**
 * Members is the account hub's project panel, not a pane of this page. It is
 * a trigger with a value no section uses, so it never lights up, and it opens
 * the hub the way the Customize bar's Members link does.
 */
function MembersRow({
  projectId,
  accountId,
  horizontal,
}: {
  projectId: string;
  accountId: string | undefined;
  horizontal: boolean;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  if (!accountId) return null;
  return (
    <TabsTrigger
      value="members"
      asChild
      size={horizontal ? undefined : 'md'}
      className={horizontal ? HORIZONTAL_ROW_CLASS : ROW_CLASS}
    >
      <HubLink to={hubTarget(accountId, { tab: 'access-projects', project: projectId })}>
        <UsersIcon className="size-4 shrink-0" />
        <span className={cn(!horizontal && 'truncate')}>{tI18nComplete.raw('text1044a4c056d0')}</span>
        <ArrowUpRightIcon aria-hidden className={cn('size-3 shrink-0', !horizontal && 'ml-auto')} />
      </HubLink>
    </TabsTrigger>
  );
}

/** The loaded rail's shape: two labelled groups of icon + label rows. */
const RAIL_SKELETON_GROUPS = [
  ['w-20', 'w-12', 'w-16', 'w-12', 'w-14', 'w-14', 'w-10'],
  ['w-14', 'w-16', 'w-28', 'w-20', 'w-16', 'w-16'],
];

function RailSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      {RAIL_SKELETON_GROUPS.map((group, g) => (
        <div key={g} className="space-y-1">
          <Skeleton className="mx-2.5 my-2 h-3 w-20 rounded-sm" />
          {group.map((width, i) => (
            <div key={i} className="flex h-8 items-center gap-2 px-2.5">
              <Skeleton className="size-4 shrink-0 rounded-sm" />
              <Skeleton className={cn('h-3.5 rounded-sm', width)} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------- states */

function AdminAccessDenied({ projectId }: { projectId: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-8">
      <EmptyState
        size="sm"
        title="Project admin needs the settings grant"
        description={
          <>
            It needs <code className="font-mono">project.settings.write</code>. Anyone who manages
            this project can grant it.
          </>
        }
        action={
          <Button asChild variant="outline" size="sm">
            <Link href={`/projects/${projectId}`}>Back to project</Link>
          </Button>
        }
      />
    </div>
  );
}

function AdminAccessCheckFailed() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-8">
      <ErrorState
        size="sm"
        title="Project admin could not check your access"
        action={
          <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
            Try again
          </Button>
        }
      />
    </div>
  );
}

/* ------------------------------------------------------------- settings nav */

/**
 * The `SettingsNav` for panes mounted here. Panes still speak the overlay's
 * vocabulary (`navigate('llm-providers')`, `navigate('experimental')`): an id
 * that names a section of this page stays on this page. Everything else
 * (`members`, `review`, account sections, personal overlay tabs) resolves the
 * way it does on every standalone capability page.
 */
export function buildProjectAdminNav(state: {
  projectId: string;
  section: ProjectAdminSectionKey;
  membersTab: MembersTab;
  accountId?: string;
  navigateTo: (href: string) => void;
}): SettingsNav {
  const fallback = buildStandaloneCapabilityNav({
    projectId: state.projectId,
    activeTab: state.section,
    membersTab: state.membersTab,
    accountId: state.accountId,
    navigateTo: state.navigateTo,
  });
  return {
    ...fallback,
    navigate: (tab, opts) => {
      const target = projectAdminNavTarget(tab);
      if (!target) {
        fallback.navigate(tab, opts);
        return;
      }
      if (opts?.membersTab) {
        useSettingsPanelStore.setState({ membersTab: opts.membersTab as MembersTab });
      }
      if (tab === 'channels') {
        state.navigateTo(projectAdminHref(state.projectId, 'connectors', { scope: 'channels' }));
      } else if (target !== state.section) {
        state.navigateTo(projectAdminHref(state.projectId, target));
      }
    },
  };
}
