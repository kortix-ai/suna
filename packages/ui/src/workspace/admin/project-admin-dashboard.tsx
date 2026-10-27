'use client';

/**
 * /projects/[id]/admin/<section> — Project admin.
 *
 * Customize is agent-first: an agent's page configures what that agent draws
 * on. Project admin is the project-wide view, one full page with a rail in two
 * groups:
 *
 *  - **Project resources**: the GLOBAL variant of every library page
 *    (Connectors, Skills, Triggers, Loops, Models, Secrets, Apps, and Repo
 *    with `drives` on), mounted with no props beyond `projectId`. This is
 *    their only home: Customize keeps Agents and Review (Marko, 2026-10-27).
 *    A page below a section (a connector, `/admin/connectors/<app>`) renders
 *    in that section's pane through `content`.
 *  - **Settings**: every section of the project Settings page
 *    (`project-settings-sections.ts`), plus the Members link.
 *
 * The section is the path segment (`projectAdminHref`); `/admin` alone opens
 * the first resource the caller may open. Only the active section mounts, and
 * each one is a lazy chunk: opening Project admin loads one catalog, not all
 * of them. A section this caller cannot open, or a legacy `?section=`, is
 * rewritten to the section that opened, so the URL always names the pane.
 *
 * Gated on `project.settings.write`, the Settings page's own leaf. Each row
 * then follows the rule its own surface already applies: a resource row
 * follows `capabilityAccess` (the Customize rule), a settings row follows
 * `isCustomizeSectionVisible` (the Settings page rule). Nothing renders until
 * those probes, the `drives` flag and the project detail (Members needs its
 * account) answer, so a row never appears and then leaves.
 *
 * The page's `SettingsNav` catches `navigate(tab)` calls from a pane. A pane
 * that pushes its own route (ConnectorsPage opening a connector) still leaves
 * for that route: the resource pages take no base-path prop yet.
 *
 * Loops and Apps are pages of the host app, not of this package. The host
 * passes them in `hostSections`; a row without a page is not listed.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, type ComponentType, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRightIcon, UsersIcon, type Icon } from '@phosphor-icons/react';

import { getProjectDetail } from '@kortix/sdk';
import { contract, invalidatePermissionProbes, qk, useFeatureFlag } from '@kortix/sdk/react';

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
import { projectSettingsSections } from '../../customize/project-settings/project-settings-sections';
import { HubLink } from '../../internal/account-hub/account-hub-location';
import { SETTINGS_SIDEBAR_WIDTH_PX } from '../../internal/account-hub/account-settings-shell';
import { useIsMobile } from '../../internal/hooks';
import { capabilityAccess } from '../../internal/layout/project-settings-nav';
import { SettingsNavProvider } from '../../internal/layout/settings-nav-context';
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
import { useSettingsPanelStore } from '../../internal/stores/settings-panel-store';

import { buildProjectAdminNav } from './project-admin-nav';
import {
  DEFAULT_PROJECT_ADMIN_SECTION,
  isProjectAdminResource,
  parseProjectAdminSection,
  PROJECT_ADMIN_RESOURCES,
  projectAdminHref,
  type ProjectAdminResourceKey,
  type ProjectAdminSectionKey,
  type ProjectAdminSettingsKey,
} from './project-admin-sections';

export { buildProjectAdminNav } from './project-admin-nav';
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
  tools: lazyPage(() => import('../../customize/skills/skills-page'), (m) => m.ToolsPage),
  extensions: lazyPage(() => import('../../customize/skills/skills-page'), (m) => m.ExtensionsPage),
  drives: lazyPage(() => import('../../customize/agents/agent-drives-section'), (m) => m.AgentDrivesSection),
  triggers: lazyPage(() => import('../../customize/triggers/triggers-page'), (m) => m.TriggersPage),
  models: lazyPage(() => import('../../customize/models/models-page'), (m) => m.ModelsPage),
  secrets: lazyPage(() => import('../../customize/secrets/secrets-page'), (m) => m.SecretsPage),
  repo: lazyPage(() => import('../layout/project-files-view'), (m) => m.ProjectFilesView),
};

/* Rail labels, keyed by section: the `hardcodedUi.i18nComplete` strings the
   Customize bar and the sidebar already show for these libraries. */
const RESOURCE_LABEL_KEYS: Partial<Record<ProjectAdminResourceKey, string>> = {
  connectors: 'textc3d2e79ebdd0',
  skills: 'text66d0f523a379',
  triggers: 'texte62f2148a64d',
  loops: 'textc08f99e3947d',
  models: 'textd17d2d78d76e',
  secrets: 'textd8707d411d99',
  apps: 'text89dd748442c1',
  repo: 'text91dba14806eb',
};

/* A host page owns a full-viewport root (`AppsView` is `h-svh`). Inside this
   pane that box would overflow by the header's height and clip its last row,
   so the pane bounds its direct child to the pane's own height. */
const HOST_PANE_CLASS = '*:h-full';

/* The Settings page's panes, mounted with the same props and in the same
   order `ProjectSettingsSectionPane` mounts them. */
const SETTINGS_PAGES: Record<ProjectAdminSettingsKey, SectionPage> = {
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
  section,
  content,
  hostSections = NO_HOST_SECTIONS,
}: {
  projectId: string;
  /** The `/admin/<section>` segment. Absent: the first section the caller may open. */
  section?: string;
  /** A page below the section (`/admin/connectors/<app>`), shown in its pane. */
  content?: ReactNode;
  hostSections?: ProjectAdminHostSections;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const tAdmin = useI18nTranslations('projectAdmin');
  const isMobile = useIsMobile();
  const searchParams = useUiSearchParams();
  const router = useUiRouter();
  const queryClient = useQueryClient();

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
  const drives = useFeatureFlag(projectId, 'drives');

  // The Customize rule for each library, without its flag clauses: a flag-off
  // Loops page explains its own gate (`FeatureGateScreen`) instead of
  // disappearing from the rail. Repo applies `drives` itself, below.
  const resources = capabilityAccess(pageCans, { drives: true, reminders: true });
  const settingsAnswered = answered(settingsCans, CUSTOMIZE_SECTION_GATE_ACTIONS);
  const settingsProbeFailed = CUSTOMIZE_SECTION_GATE_ACTIONS.some((action) => settingsCans[action]?.isError);
  const settled =
    !!canAdmin &&
    !canAdmin.isLoading &&
    resources.settled &&
    settingsAnswered &&
    !drives.isLoading &&
    // Members needs the account id: wait for the detail so it never pops in.
    detail.isFetched;

  const upgradeAttention = detail.data
    ? detectManifestVersion(detail.data.config.manifest_raw) === 1
    : false;

  // `resources.tabs` is a fresh array each render; its contents are the key.
  const allowedTabs = resources.tabs.join(',');
  const drivesOn = drives.enabled;
  const resourceRows = useMemo<RailRow[]>(() => {
    const allowed = new Set(allowedTabs.split(','));
    return PROJECT_ADMIN_RESOURCES.filter((r) => (r.host ? !!hostSections[r.key as 'loops' | 'apps'] : true))
      .filter((r) => !r.capability || allowed.has(r.capability))
      .filter((r) => r.flag !== 'drives' || drivesOn)
      .map((r) => {
        const legacy = RESOURCE_LABEL_KEYS[r.key];
        return { key: r.key, label: legacy ? tI18nComplete.raw(legacy) : tAdmin(r.key), icon: r.icon };
      });
  }, [hostSections, allowedTabs, drivesOn, tI18nComplete, tAdmin]);

  const settingsRows = useMemo<RailRow[]>(
    () =>
      projectSettingsSections(tI18nComplete)
        .filter((s): s is typeof s & { key: ProjectAdminSettingsKey } => s.key !== 'review')
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
  // the first listed row, so a stale link lands on a real pane. A legacy
  // `?section=` still names one.
  const named = section ?? searchParams.get('section');
  const requested = parseProjectAdminSection(named);
  const active: ProjectAdminSectionKey | undefined =
    (requested && rows.some((r) => r.key === requested) ? requested : undefined) ??
    (rows.some((r) => r.key === DEFAULT_PROJECT_ADMIN_SECTION) ? DEFAULT_PROJECT_ADMIN_SECTION : rows[0]?.key);

  // The rail is final once `settled`: move a legacy `?section=` or a fallen-
  // back segment onto `/admin/<section>`, so a copied link names the pane on
  // screen. A page below a section (`content`) keeps its own URL.
  const legacyQuery = searchParams.get('section') !== null;
  useEffect(() => {
    if (!settled || !active || content) return;
    if (!legacyQuery && named === active) return;
    if (!legacyQuery && named === null && section === undefined) return;
    router.replace(projectAdminHref(projectId, active));
  }, [settled, active, named, legacyQuery, section, content, projectId, router]);

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
    return (
      <AdminAccessCheckFailed
        onRetry={() => {
          void invalidatePermissionProbes(queryClient, { accountId });
          void queryClient.invalidateQueries({ queryKey: qk.project.detail(projectId) });
        }}
      />
    );
  }

  if (settled && (receivedDenial(canAdmin) || rows.length === 0)) {
    return <AdminAccessDenied projectId={projectId} />;
  }

  const ActivePage = !active
    ? null
    : isProjectAdminResource(active)
      ? (RESOURCE_PAGES[active] ?? hostSections[active as 'loops' | 'apps'] ?? null)
      : SETTINGS_PAGES[active];

  const members =
    showMembers && accountId ? (
      <MembersLink projectId={projectId} accountId={accountId} horizontal={isMobile} />
    ) : null;
  const title = tI18nComplete.raw('text73738b374f4b');

  return (
    <SettingsNavProvider value={settingsNav}>
      <div
        className={cn('min-h-0 flex-1 overflow-hidden', isMobile ? 'flex flex-col' : 'grid')}
        // The Settings page's rail width, so the two settings surfaces are one shape.
        style={isMobile ? undefined : { gridTemplateColumns: `${SETTINGS_SIDEBAR_WIDTH_PX}px 1fr` }}
      >
        {isMobile ? (
          <nav aria-label={title} className="border-border/60 bg-background flex shrink-0 flex-col border-b">
            <h1 className="text-foreground px-4 pt-3 text-sm font-medium">{title}</h1>
            <FadedScrollArea orientation="horizontal" fadeColor="from-background" className="min-w-0 flex-1 py-2">
              {settled ? (
                <div className="flex w-fit items-center gap-2">
                  <Tabs value={active} className="w-fit">
                    <TabsList orientation="horizontal" className="w-fit">
                      {rows.map((row) => (
                        <RailTrigger key={row.key} projectId={projectId} row={row} horizontal />
                      ))}
                    </TabsList>
                  </Tabs>
                  {members}
                </div>
              ) : (
                <Skeleton className="mx-3 h-7 w-64 rounded-md" />
              )}
            </FadedScrollArea>
          </nav>
        ) : (
          <aside className="flex min-h-0 flex-col border-r bg-inherit">
            <nav
              aria-label={title}
              className="flex min-h-0 flex-1 [scrollbar-width:none] flex-col gap-4 overflow-y-auto px-2 pt-4 pb-2 [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
            >
              <header className="space-y-1 px-2.5">
                <h1 className="text-foreground text-base font-medium">{title}</h1>
                <p className="text-muted-foreground text-xs text-balance">
                  {tI18nComplete.raw('text2b8a7a0458b5')}
                </p>
              </header>
              {settled ? (
                <Tabs value={active} orientation="vertical" className="gap-4">
                  {resourceRows.length > 0 ? (
                    <RailGroup label={tI18nComplete.raw('text4da7c2d25273')}>
                      {resourceRows.map((row) => (
                        <RailTrigger key={row.key} projectId={projectId} row={row} />
                      ))}
                    </RailGroup>
                  ) : null}
                  {settingsRows.length > 0 || members ? (
                    <RailGroup label={tI18nComplete.raw('text74a883a037bc')} after={members}>
                      {settingsRows.map((row) => (
                        <RailTrigger key={row.key} projectId={projectId} row={row} />
                      ))}
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
                <div
                  className={cn(
                    'flex min-h-0 flex-1 flex-col overflow-hidden',
                    (active === 'loops' || active === 'apps') && HOST_PANE_CLASS,
                  )}
                >
                  {content ?? <ActivePage projectId={projectId} />}
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

/**
 * The account hub's group label dialect (`account-settings-sidebar.tsx`).
 * Each group is its own labelled tablist: arrow keys move inside a group, Tab
 * moves to the next one. `after` sits below the list, outside it: a link that
 * is not a tab (Members).
 */
function RailGroup({ label, children, after }: { label: string; children: ReactNode; after?: ReactNode }) {
  return (
    <div>
      <p className="text-muted-foreground flex h-8 items-center px-2.5 text-xs font-medium">{label}</p>
      <TabsList orientation="vertical" aria-label={label} className="w-full">
        {children}
      </TabsList>
      {after}
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
 * Members is the account hub's project panel, not a pane of this page, so it
 * is a plain link, not a tab. It opens the hub the way the Customize bar's
 * Members link does. Its classes copy a rail row's resting state.
 */
const MEMBERS_LINK_CLASS = cn(
  'text-foreground hover:bg-hover flex items-center gap-2 rounded-md px-2.5 text-sm',
  'focus-visible:ring-kortix-blue focus-visible:ring-1 focus-visible:outline-none',
  '[&_svg]:text-muted-foreground',
);

function MembersLink({
  projectId,
  accountId,
  horizontal,
}: {
  projectId: string;
  accountId: string;
  horizontal: boolean;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  return (
    <HubLink
      to={hubTarget(accountId, { tab: 'access-projects', project: projectId })}
      className={cn(MEMBERS_LINK_CLASS, horizontal ? 'h-8 shrink-0 whitespace-nowrap' : 'h-10 w-full')}
    >
      <UsersIcon aria-hidden className="size-4 shrink-0" />
      <span className={cn(!horizontal && 'truncate')}>{tI18nComplete.raw('text1044a4c056d0')}</span>
      <ArrowUpRightIcon aria-hidden className={cn('size-3 shrink-0', !horizontal && 'ml-auto')} />
    </HubLink>
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
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  // The voice rule for a refused action (voice-and-tone.md section 4): name
  // the grant in mono once, then say who can grant it.
  const [beforeGrant, afterGrant] = tI18nComplete.raw('textb24d48611918').split('{grant}');
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-8">
      <EmptyState
        size="sm"
        title={tI18nComplete.raw('text078931e34187')}
        description={
          <>
            {beforeGrant}
            <code className="font-mono">{PROJECT_ACTIONS.PROJECT_SETTINGS_WRITE}</code>
            {afterGrant}
          </>
        }
        action={
          <Button asChild variant="outline" size="sm">
            <Link href={`/projects/${projectId}`}>{tI18nComplete.raw('text37737d817d12')}</Link>
          </Button>
        }
      />
    </div>
  );
}

function AdminAccessCheckFailed({ onRetry }: { onRetry: () => void }) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-8">
      <ErrorState
        size="sm"
        title={tI18nComplete.raw('text9eebeabf6094')}
        description={tI18nComplete.raw('texta0c2cc1374d9')}
        action={
          <Button variant="outline" size="sm" onClick={onRetry}>
            {tI18nComplete.raw('textd8b8392e2c54')}
          </Button>
        }
      />
    </div>
  );
}
