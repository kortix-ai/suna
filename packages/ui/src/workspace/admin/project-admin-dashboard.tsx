'use client';

/**
 * /workspaces/[id]/admin/<section> — Workspace settings, the one settings
 * surface per workspace (Workspaces ux.md section 4).
 *
 * One page, one rail in four groups (`WORKSPACE_SETTINGS_GROUPS`):
 *
 *  - **Workspace**: General, Branding, Git repo, Sandbox templates, Feature
 *    flags, API keys. General and Git repo are project panes that also carry
 *    the account's security policy and GitHub connections.
 *  - **Library**: the GLOBAL variant of every library page (Connectors,
 *    Secrets, Skills, Drives, Apps, Triggers, Models, Repo). A page below a
 *    section (a connector, `/admin/connectors/<app>`) renders in that
 *    section's pane through `content`.
 *  - **People** and **Billing**: the account hub's panes, which the host
 *    passes as `hostSections.account` (they live in `apps/web`). A workspace
 *    is one account and its project, so these are the workspace's people and
 *    billing.
 *
 * Who sees what does not change. A project row follows the rule its own
 * surface applied: the page gate `project.settings.write`, then
 * `capabilityAccess` (a library) or `isCustomizeSectionVisible` (a setting).
 * An account row follows the account hub's rule (`useAccountHubAccess`), for
 * a caller who is a member of the workspace's account. Nothing renders until
 * those probes, the `drives` flag and the project row answer, so a row never
 * appears and then leaves. A caller with no row at all sees "no access".
 *
 * The section is the path segment (`projectAdminHref`); `/admin` alone opens
 * General, else the first row the caller may open. Only the active section
 * mounts, each a lazy chunk. A section this caller cannot open, or a legacy
 * `?section=`, is rewritten to the section that opened.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, type ComponentType, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type Icon } from '@phosphor-icons/react';

import { getProject } from '@kortix/sdk';
import type { AccountSection } from '../../internal/account-hub/sections';
import { contract, invalidatePermissionProbes, qk, useCaptureWorkspace, useFeatureFlag } from '@kortix/sdk/react';
import { captureHref } from '../../internal/capture/use-capture-area';

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
import { EmbeddedAccountHubProvider } from '../../internal/account-hub/account-hub-location';
import { AccountHubSheetProvider } from '../../internal/account-hub/hub-sheet';
import { useAccountHubAccess } from '../../internal/account-hub/use-account-hub-access';
import { useAccountsList } from '../../internal/hooks/account/use-accounts-list';
import { useIsMobile } from '../../internal/hooks';
import {
  RAIL_HORIZONTAL_ROW_CLASS,
  RAIL_ROW_CLASS,
  RailGroup,
  SETTINGS_SIDEBAR_WIDTH_PX,
} from '../../internal/components/nav-rail';
import { capabilityAccess } from '../../internal/layout/project-settings-nav';
import { SettingsNavProvider } from '../../internal/layout/settings-nav-context';
import { withStaleChunkRecovery } from '../../internal/lib/chunk-reload';
import {
  CUSTOMIZE_SECTION_GATE_ACTIONS,
  isCustomizeSectionVisible,
  PROJECT_ACTIONS,
} from '../../internal/lib/project-actions';
import { useProjectCans, useProjectPageCans, type CanResult } from '../../internal/lib/use-project-can';
import { capabilityTabHref } from '../../internal/lib/capability-tab-routes';
import { cn } from '../../internal/lib/utils';
import { useSettingsPanelStore } from '../../internal/stores/settings-panel-store';

import { buildProjectAdminNav } from './project-admin-nav';
import {
  ACCOUNT_TAB_FOR_SECTION,
  DEFAULT_PROJECT_ADMIN_SECTION,
  isProjectAdminResource,
  isWorkspaceAccountSection,
  parseProjectAdminSection,
  PROJECT_ADMIN_RESOURCES,
  projectAdminHref,
  RETIRED_SECTIONS,
  sectionLabelKey,
  WORKSPACE_SETTINGS_GROUPS,
  type ProjectAdminResourceKey,
  type ProjectAdminSectionKey,
  type ProjectAdminSettingsKey,
  type WorkspaceAccountSectionKey,
  type WorkspaceSettingsGroupId,
} from '../../customize/project-settings/project-admin-sections';
import {
  PaintBrushIcon,
  KeyIcon,
  UsersIcon,
  NetworkIcon,
  ShieldIcon,
  FingerprintIcon,
  ScrollIcon,
  QuestionIcon,
  CreditCardIcon,
  CoinsIcon,
  MonitorPlayIcon,
  LockKeyIcon as SecurityIcon,
} from '@phosphor-icons/react';

export { buildProjectAdminNav } from './project-admin-nav';
export {
  DEFAULT_PROJECT_ADMIN_SECTION,
  parseProjectAdminSection,
  projectAdminHref,
  type ProjectAdminSectionKey,
} from '../../customize/project-settings/project-admin-sections';

/** `slot`: General renders it after the name and icon, before its Danger zone. */
type SectionPage = ComponentType<{ projectId: string; slot?: ReactNode }>;

/**
 * An account pane of the host (`apps/web` renders the account hub's panes).
 * `companion`: drawn under a project pane in the same section (General, Git
 * repo), so it carries no title of its own. `title`: the section label, for a
 * pane that stands alone in a section a project pane would lead.
 */
export type WorkspaceAccountPane = ComponentType<{
  projectId: string;
  accountId: string;
  tab: AccountSection;
  companion: boolean;
  title?: string;
}>;

/** Pages that live in the host app (`apps/web`), passed in by its route. */
export type ProjectAdminHostSections = Partial<Record<'apps', SectionPage>> & {
  /** The account hub's panes. Without it, no account row is listed. */
  account?: WorkspaceAccountPane;
  /** Drawn in General after the name and icon, before the Danger zone (Pause all triggers). */
  generalExtras?: ComponentType<{ projectId: string; accountId: string }>;
};

/** Rail glyphs for the account rows, the account hub's own (`sections.ts`). */
const ACCOUNT_SECTION_ICONS: Record<WorkspaceAccountSectionKey, Icon> = {
  security: SecurityIcon,
  branding: PaintBrushIcon,
  'api-keys': KeyIcon,
  members: UsersIcon,
  groups: NetworkIcon,
  roles: ShieldIcon,
  identity: FingerprintIcon,
  audit: ScrollIcon,
  help: QuestionIcon,
  plan: CreditCardIcon,
  usage: CoinsIcon,
};

function lazyPage<M>(load: () => Promise<M>, pick: (mod: M) => SectionPage) {
  return lazy(withStaleChunkRecovery(() => load().then((mod) => ({ default: pick(mod) }))));
}

/* The package's own pages, one lazy chunk each, mounted exactly as their
   Customize routes mount them. */
const RESOURCE_PAGES: Partial<Record<ProjectAdminResourceKey, SectionPage>> = {
  connectors: lazyPage(() => import('../../customize/connectors/connectors-page'), (m) => m.ConnectorsPage),
  skills: lazyPage(() => import('../../customize/skills/skills-page'), (m) => m.SkillsPage),
  drives: lazyPage(() => import('../../customize/agents/agent-drives-section'), (m) => m.AgentDrivesSection),
  triggers: lazyPage(() => import('../../customize/triggers/triggers-page'), (m) => m.TriggersPage),
  models: lazyPage(() => import('../../customize/models/models-page'), (m) => m.ModelsPage),
  secrets: lazyPage(() => import('../../customize/secrets/secrets-page'), (m) => m.SecretsPage),
  repo: lazyPage(() => import('../layout/project-files-view'), (m) => m.ProjectFilesView),
};


/** The rail group drawn in the rail's footer instead of the scrolling list. */
const RAIL_FOOTER_GROUP: WorkspaceSettingsGroupId = 'support';

/* A host page owns a full-viewport root (`AppsView` is `h-svh`). Inside this
   pane that box would overflow by the header's height and clip its last row,
   so the pane bounds its direct child to the pane's own height. */
const HOST_PANE_CLASS = '*:h-full';

/* The Settings page's panes, mounted with the same props and in the same
   order `ProjectSettingsSectionPane` mounts them. */
const SETTINGS_PAGES: Record<ProjectAdminSettingsKey, SectionPage> = {
  general: lazyPage(() => import('../../customize/settings/tabs/general-tab'), (m) => {
    const { GeneralTab } = m;
    return function GeneralSection(props) {
      return <GeneralTab {...props} part="settings" />;
    };
  }),
  'danger-zone': lazyPage(() => import('../../customize/settings/tabs/general-tab'), (m) => {
    const { GeneralTab } = m;
    return function DangerZoneSection({ projectId }) {
      return <GeneralTab projectId={projectId} part="danger" />;
    };
  }),
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
};

interface RailRow {
  key: ProjectAdminSectionKey;
  /** Where the row goes when it is not a section of this page. */
  href?: string;
  label: string;
  icon: Icon;
  /** The project pane of this section is open to the caller. */
  project: boolean;
  /** The account pane of this section is open to the caller. */
  account: boolean;
}

interface RailGroupRows {
  id: WorkspaceSettingsGroupId;
  rows: RailRow[];
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
  /** The `/admin/<section>` segment. Absent: General, else the first section the caller may open. */
  section?: string;
  /** A page below the section (`/admin/connectors/<app>`), shown in its pane. */
  content?: ReactNode;
  hostSections?: ProjectAdminHostSections;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const tSettings = useI18nTranslations('workspaces.settings');
  const isMobile = useIsMobile();
  const searchParams = useUiSearchParams();
  const router = useUiRouter();
  const queryClient = useQueryClient();

  // The project row (`GET /projects/:id`, one database read) for the account
  // id. Not the detail: it reads the repository, and every Customize tab
  // waited on it for this one field (2026-11-04).
  const project = useQuery({
    queryKey: qk.project.summary(projectId),
    queryFn: () => getProject(projectId),
    enabled: !!projectId,
    ...contract('config'),
  });
  const accountId = project.data?.account_id;

  // One batch for the page gate, the resource rows and Members: the same
  // `PROJECT_PAGE_ACTIONS` batch the sidebar has usually cached already.
  const pageCans = useProjectPageCans(projectId);
  const settingsCans = useProjectCans(projectId, CUSTOMIZE_SECTION_GATE_ACTIONS, { accountId });
  const canAdmin = pageCans[PROJECT_ACTIONS.PROJECT_SETTINGS_WRITE];
  const projectRowsOpen = canAdmin?.allowed === true;
  const drives = useFeatureFlag(projectId, 'drives');

  // The account rows: the account hub's own rule, for a member of the
  // workspace's account. A project shared into an account the caller does not
  // belong to has no account panes for them.
  const accountsQuery = useAccountsList();
  const isAccountMember =
    !!accountId && (accountsQuery.data ?? []).some((account) => account.account_id === accountId);
  const hub = useAccountHubAccess(isAccountMember ? accountId : undefined);
  const accountPane = hostSections.account;
  // Kortix Capture is per workspace (its tenant is the account). The row
  // follows the rule the switcher's Capture link follows: Capture is on for
  // this workspace, for a member of its account.
  const capture = useCaptureWorkspace(isAccountMember ? (accountId ?? null) : null);
  const captureOn = isAccountMember && capture.data?.enabled === true;

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
    // Members needs the account id: wait for the project so it never pops in.
    project.isFetched &&
    accountsQuery.isFetched &&
    (!isAccountMember || !accountPane || hub.settled);

  // `resources.tabs` is a fresh array each render; its contents are the key.
  const allowedTabs = resources.tabs.join(',');
  const drivesOn = drives.enabled;
  const visibleSections = hub.sectionVisible;
  const groups = useMemo<RailGroupRows[]>(() => {
    const allowed = new Set(allowedTabs.split(','));
    const hubOpen = (tab: AccountSection) => !!accountPane && isAccountMember && visibleSections[tab] === true;
    const settingsByKey = new Map(
      projectSettingsSections(tI18nComplete)
        .filter((s): s is typeof s & { key: ProjectAdminSettingsKey } => s.key !== 'review')
        .map((s) => [s.key, s] as const),
    );
    const label = (key: ProjectAdminSectionKey) => tSettings(`sections.${sectionLabelKey(key)}`);
    const rowFor = (key: ProjectAdminSectionKey): RailRow | null => {
      // Capture is a link out to the workspace's Kortix Capture area.
      if (key === 'capture') {
        if (!captureOn || !accountId) return null;
        return {
          key,
          href: captureHref(accountId, 'devices'),
          label: label(key),
          icon: MonitorPlayIcon,
          project: false,
          account: false,
        };
      }
      if (isProjectAdminResource(key)) {
        const resource = PROJECT_ADMIN_RESOURCES.find((r) => r.key === key);
        if (!resource || !projectRowsOpen) return null;
        if (resource.host && !hostSections[resource.key as 'apps']) return null;
        if (resource.capability && !allowed.has(resource.capability)) return null;
        if (resource.flag === 'drives' && !drivesOn) return null;
        return {
          key,
          label: label(key),
          icon: resource.icon,
          project: true,
          account: false,
        };
      }
      if (isWorkspaceAccountSection(key)) {
        const tab = ACCOUNT_TAB_FOR_SECTION[key];
        if (!tab || !hubOpen(tab)) return null;
        return {
          key,
          label: label(key),
          icon: ACCOUNT_SECTION_ICONS[key],
          project: false,
          account: true,
        };
      }
      const setting = settingsByKey.get(key as ProjectAdminSettingsKey);
      if (!setting) return null;
      // The Settings page's rule: a failed probe hides nothing. The pane
      // itself reports a 403 if the server refuses it.
      const projectOpen =
        projectRowsOpen &&
        (settingsProbeFailed ||
          isCustomizeSectionVisible(setting.gate, (action) => settingsCans[action]?.allowed === true));
      const tab = ACCOUNT_TAB_FOR_SECTION[key];
      const account = !!tab && hubOpen(tab);
      if (!projectOpen && !account) return null;
      return { key, label: label(key), icon: setting.icon, project: projectOpen, account };
    };
    return WORKSPACE_SETTINGS_GROUPS.map((group) => ({
      id: group.id,
      rows: group.sections.map(rowFor).filter((row): row is RailRow => row !== null),
    })).filter((group) => group.rows.length > 0);
  }, [
    allowedTabs,
    accountPane,
    isAccountMember,
    visibleSections,
    projectRowsOpen,
    hostSections,
    drivesOn,
    settingsCans,
    settingsProbeFailed,
    tI18nComplete,
    tSettings,
    captureOn,
    accountId,
  ]);

  // The rail's footer: the Support group (Help), drawn under the groups.
  const footerRows = groups.find((group) => group.id === RAIL_FOOTER_GROUP)?.rows ?? [];

  // The sections of this page; a link-out row (Capture) is never active.
  const rows = groups.flatMap((group) => group.rows).filter((row) => !row.href);
  const linkOut = groups.flatMap((group) => group.rows).find((row) => row.href && row.key === section);

  // A section named in the URL but not listed for this caller falls back to
  // General, else the first listed row, so a stale link lands on a real pane.
  // A legacy `?section=` still names one.
  const named = section ?? searchParams.get('section');
  const requested = parseProjectAdminSection(named);
  const active: ProjectAdminSectionKey | undefined =
    (requested && rows.some((r) => r.key === requested) ? requested : undefined) ??
    (rows.some((r) => r.key === DEFAULT_PROJECT_ADMIN_SECTION) ? DEFAULT_PROJECT_ADMIN_SECTION : rows[0]?.key);
  const activeRow = rows.find((row) => row.key === active);

  // The rail is final once `settled`: move a legacy `?section=` or a fallen-
  // back segment onto `/admin/<section>`, so a copied link names the pane on
  // screen. A page below a section (`content`) keeps its own URL. The query
  // (a drill-down such as `?accountMember=`) survives the move.
  const legacyQuery = searchParams.get('section') !== null;
  const retired = named !== null && named !== undefined && RETIRED_SECTIONS.includes(named);
  useEffect(() => {
    // A retired section (Tools, Extensions) is switched per agent: open the Agents list.
    if (retired) {
      router.replace(capabilityTabHref(projectId, 'agent'));
      return;
    }
    // `/admin/capture` opens the Capture area the row links to.
    if (linkOut?.href) {
      router.replace(linkOut.href);
      return;
    }
    if (!settled || !active || content) return;
    if (!legacyQuery && named === active) return;
    const query = new URLSearchParams(searchParams.toString());
    query.delete('section');
    router.replace(projectAdminHref(projectId, active, Object.fromEntries(query.entries())));
  }, [retired, linkOut, settled, active, named, legacyQuery, content, projectId, router, searchParams]);

  // A narrow window shows the rail as one horizontal strip. Scroll the
  // selected row into it, so a section opened from a link, the palette or a
  // click on a partly hidden row is visible. Only the strip scrolls, never the page.
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = stripRef.current;
    if (!isMobile || !settled || !strip) return;
    const tab = strip.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!tab) return;
    const stripBox = strip.getBoundingClientRect();
    const tabBox = tab.getBoundingClientRect();
    if (tabBox.left >= stripBox.left && tabBox.right <= stripBox.right) return;
    strip.scrollLeft += tabBox.left - stripBox.left - (stripBox.width - tabBox.width) / 2;
  }, [isMobile, settled, active]);

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
          void queryClient.invalidateQueries({ queryKey: qk.project.summary(projectId) });
        }}
      />
    );
  }

  if (settled && rows.length === 0) {
    return <AdminAccessDenied projectId={projectId} />;
  }

  const ProjectPage =
    !active || isWorkspaceAccountSection(active)
      ? null
      : isProjectAdminResource(active)
        ? (RESOURCE_PAGES[active] ?? hostSections[active as 'apps'] ?? null)
        : active === 'capture'
          ? null
          : SETTINGS_PAGES[active];
  const accountTab = active ? ACCOUNT_TAB_FOR_SECTION[active] : undefined;
  const AccountPage = activeRow?.account && accountTab && accountId ? accountPane : undefined;
  const title = tSettings('title');
  // The account half of a project section (General, Git repo).
  const GeneralExtras = hostSections.generalExtras;
  const companionPane =
    active === 'general' && GeneralExtras && accountId && isAccountMember ? (
      <GeneralExtras projectId={projectId} accountId={accountId} />
    ) : AccountPage && accountTab && accountId ? (
      <EmbeddedAccountHubProvider value={{ accountId, tab: accountTab }}>
        <AccountPage projectId={projectId} accountId={accountId} tab={accountTab} companion />
      </EmbeddedAccountHubProvider>
    ) : null;

  return (
    <SettingsNavProvider value={settingsNav}>
      <div
        className={cn('min-h-0 flex-1 overflow-hidden', isMobile ? 'flex flex-col' : 'grid')}
        // The Settings page's rail width, so the two settings surfaces are one shape.
        style={isMobile ? undefined : { gridTemplateColumns: `${SETTINGS_SIDEBAR_WIDTH_PX}px 1fr` }}
      >
        {isMobile ? (
          // The frame's title bar names the panel; this row is the rail only.
          <nav aria-label={title} className="border-border/60 bg-background flex shrink-0 flex-col border-b">
            <FadedScrollArea ref={stripRef} orientation="horizontal" fadeColor="from-background" className="min-w-0 flex-1 py-2">
              {settled ? (
                <div className="flex w-fit items-center gap-2">
                  <Tabs value={active} className="w-fit">
                    <TabsList orientation="horizontal" className="w-fit">
                      {groups.flatMap((group) => group.rows).map((row) => (
                        <RailTrigger key={row.key} projectId={projectId} row={row} horizontal />
                      ))}
                    </TabsList>
                  </Tabs>
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
              {settled ? (
                <Tabs value={active} orientation="vertical" className="gap-4">
                  {groups
                    .filter((group) => group.id !== RAIL_FOOTER_GROUP)
                    .map((group) => (
                      <RailGroup key={group.id} label={tSettings(`groups.${group.id}`)}>
                        {group.rows.map((row) => (
                          <RailTrigger key={row.key} projectId={projectId} row={row} />
                        ))}
                      </RailGroup>
                    ))}
                </Tabs>
              ) : (
                <RailSkeleton />
              )}
            </nav>
            {/* Help sits under the groups, outside the scrolling list: it is
                where a person goes when the rest of the rail did not help. */}
            {settled && footerRows.length > 0 ? (
              <div className="border-border/60 shrink-0 border-t px-2 py-2">
                <Tabs value={active} orientation="vertical">
                  <RailGroup>
                    {footerRows.map((row) => (
                      <RailTrigger key={row.key} projectId={projectId} row={row} />
                    ))}
                  </RailGroup>
                </Tabs>
              </div>
            ) : null}
          </aside>
        )}

        <main className="bg-background flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {settled && active && activeRow && (ProjectPage || AccountPage) ? (
            <Suspense key={active} fallback={<CapabilitiesSkeleton />}>
              {isProjectAdminResource(active) && ProjectPage ? (
                <div
                  className={cn(
                    'flex min-h-0 flex-1 flex-col overflow-hidden',
                    active === 'apps' && HOST_PANE_CLASS,
                  )}
                >
                  {content ?? <ProjectPage projectId={projectId} />}
                </div>
              ) : (
                // Bounded, not scrolling: the account panes' split sheet
                // (Invite, New key) splits this column, and the page and the
                // sheet each scroll inside their own half.
                <div className="min-h-0 flex-1">
                  <AccountHubSheetProvider>
                    {activeRow.project && ProjectPage ? (
                      <div className="mx-auto flex min-h-0 w-full flex-1 flex-col space-y-6 px-4 py-10 pb-20 lg:py-14">
                        {/* General places the account half before its
                            Danger zone; every other section appends it. */}
                        {active === 'general' ? (
                          <ProjectPage projectId={projectId} slot={companionPane} />
                        ) : (
                          <>
                            <ProjectPage projectId={projectId} />
                            {companionPane}
                          </>
                        )}
                      </div>
                    ) : AccountPage && accountTab && accountId ? (
                      <EmbeddedAccountHubProvider value={{ accountId, tab: accountTab }}>
                        <AccountPage
                          projectId={projectId}
                          accountId={accountId}
                          tab={accountTab}
                          companion={false}
                          title={isWorkspaceAccountSection(active) ? undefined : activeRow.label}
                        />
                      </EmbeddedAccountHubProvider>
                    ) : null}
                  </AccountHubSheetProvider>
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
      className={horizontal ? RAIL_HORIZONTAL_ROW_CLASS : RAIL_ROW_CLASS}
    >
      <Link href={row.href ?? projectAdminHref(projectId, row.key)} prefetch>
        <Glyph className="size-4 shrink-0" />
        <span className={cn(!horizontal && 'truncate')}>{row.label}</span>
      </Link>
    </TabsTrigger>
  );
}

/** The loaded rail's shape: five labelled groups of icon + label rows. */
const RAIL_SKELETON_GROUPS = [
  ['w-16', 'w-16', 'w-20', 'w-10', 'w-16', 'w-20', 'w-16'],
  ['w-20', 'w-14', 'w-12', 'w-12', 'w-16', 'w-14', 'w-20'],
  ['w-16', 'w-14', 'w-12', 'w-16', 'w-16'],
  ['w-10', 'w-12'],
  ['w-10'],
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
            <Link href={`/workspaces/${projectId}`}>{tI18nComplete.raw('text37737d817d12')}</Link>
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
