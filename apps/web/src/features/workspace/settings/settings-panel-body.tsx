'use client';

import { BackPillBody, backPillClass } from '@/components/ui/back-pill';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Modal, ModalClose, ModalContent, ModalTitle } from '@/components/ui/modal';
import { SettingsSectionHeader } from '@/components/ui/settings-section-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { HubLink } from '@/features/accounts/hub/account-hub-location';
import { SETTINGS_SIDEBAR_WIDTH_PX } from '@/features/accounts/hub/account-settings-shell';
import { Close } from '@/features/icon/icons/close';
import { UpgradesView } from '@/features/workspace/customize/migrate-to-v2/upgrade-view';
import {
  SettingsNavProvider,
  type SettingsNav,
} from '@/features/workspace/shared/settings-nav-context';
import { useIsMobile } from '@/hooks/utils';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { hasOpenFloatingLayer, hasOpenNestedDialog } from '@/lib/z-stack';
import { hubTarget } from '@/stores/account-panel-store';
import { useSettingsPanelStore, type MembersTab } from '@/stores/settings-panel-store';
import { getProjectDetail } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { isRailItemActive, railGroups } from './rail';
import { SettingsRailCopyProvider, type SettingsRailChromeCopy } from './rail-copy-context';
import { DEFAULT_SETTINGS_TAB, type SettingsTab } from './settings-tabs';
import {
  accountRoleLabel,
  DEFAULT_ACCOUNT_MEMBERSHIPS_COPY,
  useAccountMemberships,
  type AccountMembership,
  type AccountMembershipsCopy,
} from './tabs/account-memberships';
import { AppearanceTab } from './tabs/appearance-tab';
import { ComputerTab } from './tabs/computer-tab';
import { ConnectedAccountsTab } from './tabs/connected-tab';
import { CreditsTab } from './tabs/credits-tab';
import { ExperimentalTab } from './tabs/experimental-tab';
import { GeneralTab } from './tabs/general-tab';
import { McpTab } from './tabs/mcp-tab';
import { PlanTab } from './tabs/plan-tab';
import { PreferencesTab } from './tabs/preferences-tab';
import { ProfileTab } from './tabs/profile-tab';
import { SandboxTab } from './tabs/sandbox-tab';
import { SecurityTab } from './tabs/security-tab';
import { SessionsTab } from './tabs/sessions-tab';
import { SnapshotsTab } from './tabs/snapshots-tab';
import { TokensTab } from './tabs/tokens-tab';
import type { RailGroup, RailItem } from './type';
import { useSettingsAccountId } from './use-settings-account-id';

/**
 * The tabs that still render with no project open.
 *
 * `ACCOUNT_TAB_PERMISSION` — the IAM leaf each account-scoped tab gated on
 * (`account.write`, `role.create`, `audit.read`) — is gone with the tabs it
 * gated. Organization, Billing, Usage, Groups, Roles, Identity, Audit log and
 * API keys left the overlay for `/accounts/[id]`, which runs those same probes
 * itself (`ACCOUNT_PERMISSION_PROBES` in that page). The batched probe this
 * panel used to fire on every open went with them: nothing left in the rail
 * reads an account-level permission.
 *
 * The three survivors are user-scoped, not account-scoped — a profile, a
 * preference, and a list of linked identities all belong to the signed-in
 * person, so none of them needs a project OR an account permission.
 */
export const ACCOUNT_SCOPED_SETTINGS_TABS: readonly SettingsTab[] = [
  'profile',
  'security',
  'appearance',
  'sessions',
  'preferences',
  'connected',
  // Your own API keys are yours in ONE account (the read is account-scoped —
  // see `tabs/tokens-tab.tsx`), but never in one project, so this renders with
  // or without a project open like the three above it.
  'tokens',
  // Same scope as `plan` below — one wallet per account, read through the same
  // resolved id — so it renders wherever `plan` does. Listed before it, in the
  // rail's own order, because `command-palette.test.tsx` asserts this array
  // equals `PALETTE_ACCOUNT_SCOPED_TABS` element for element.
  'credits',
  // The plan is the ACCOUNT's, and the account is resolved the same way the
  // Tokens pane resolves it (`useSettingsAccountId`), so it renders with or
  // without a project too.
  'plan',
  // The MCP URL is one per person and reaches every project they can open.
  // `computer` is NOT here: pairing names the project it starts from.
  'mcp',
  // `workspace`, `sandbox`, `feature-flags` and `upgrades` are deliberately ABSENT. They
  // are the project-scoped tabs in this overlay (`settings-tabs.ts` explains
  // why each came back), so leaving them out of this list is exactly what
  // makes `isSettingsTabAllowed` hide them — and with them the whole
  // `Workspace` rail group — on `/settings` and under `/accounts/[id]`, where
  // there is no project to name.
];

export interface SettingsTabAllowedParams {
  hasProject: boolean;
}

/**
 * Whether the overlay may show a tab at all.
 *
 * One rule: Profile, Preferences and the other personal tabs render with or
 * without a project; every other tab needs one. The per-tab IAM gate that
 * used to sit here (`PROJECT_GATED_TABS`) went with Sandbox templates,
 * Feature flags and Upgrades, which left the rail for the Customize Settings
 * tab (`RETIRED_RAIL_ITEMS`), where the capability rule gates them.
 *
 * The function stays because the CONCEPT stays: a tab added here must declare
 * whether it needs a project, and the command palette mirrors this decision
 * (`isSettingsTabOfferable` in `settings-palette-items.ts`).
 */
export function isSettingsTabAllowed(tab: SettingsTab, params: SettingsTabAllowedParams): boolean {
  return params.hasProject || ACCOUNT_SCOPED_SETTINGS_TABS.includes(tab);
}

export function buildSettingsPanelSettingsNav(state: {
  open: boolean;
  tab: SettingsTab;
  membersTab: MembersTab;
}): SettingsNav {
  return {
    activeTab: state.tab,
    isOpen: state.open,
    membersTab: state.membersTab,
    llmProvidersTab: undefined,
    navigate: (tab, opts) => {
      useSettingsPanelStore.getState().setTab(tab as SettingsTab);
      if (opts?.membersTab) {
        useSettingsPanelStore.setState({ membersTab: opts.membersTab as MembersTab });
      }
    },
  };
}

/**
 * The panel itself, loaded on demand by `SettingsPanel` (settings-panel.tsx)
 * the first time Settings opens. Everything below — every tab, both icon
 * pickers, the rail — used to ship with every project page because the panel
 * is mounted by project-shell.tsx whether or not it is open.
 */
export function SettingsPanelBody({ projectId }: { projectId?: string }) {
  const tSettingsRail = useI18nTranslations('settings.rail');
  const tOrganizations = useI18nTranslations('settings.profile.organizations');
  const open = useSettingsPanelStore((s) => s.open);
  const tab = useSettingsPanelStore((s) => s.tab);
  const setTab = useSettingsPanelStore((s) => s.setTab);
  const close = useSettingsPanelStore((s) => s.close);
  // Reactive (not getState()) so it re-renders this provider — and every
  // useSettingsNav() consumer — when membersTab changes, e.g. a deep link
  // opening straight to Invite.
  const membersTab = useSettingsPanelStore((s) => s.membersTab);
  const paneRequested = useSettingsPanelStore((s) => s.paneRequested);
  const settingsNav = useMemo(
    () => buildSettingsPanelSettingsNav({ open, tab, membersTab }),
    [open, tab, membersTab],
  );
  const isMobile = useIsMobile();
  const memberships = useAccountMemberships();

  const detail = useQuery({
    queryKey: qk.project.detail(projectId ?? ''),
    queryFn: () => getProjectDetail(projectId!),
    enabled: open && !!projectId,
    ...contract('config'),
  });
  const project = projectId ? detail.data?.project : undefined;

  // Still resolved, still passed down: `ConnectedAccountsTab` takes an account
  // id. The batched IAM probe that used to sit here went with the
  // account-scoped tabs — see `ACCOUNT_SCOPED_SETTINGS_TABS` above.
  const resolvedAccountId = useSettingsAccountId(project?.account_id);

  const isTabAllowed = useCallback(
    (t: SettingsTab) => isSettingsTabAllowed(t, { hasProject: !!projectId }),
    [projectId],
  );

  const groups = useMemo(() => {
    const allowed: RailGroup[] = [];
    for (const g of railGroups((key) => tSettingsRail(key as never))) {
      const items = g.items.filter((item) => isTabAllowed(item.tab));
      if (items.length > 0) allowed.push({ ...g, items });
    }
    return allowed;
  }, [isTabAllowed, tSettingsRail]);
  const allItems = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const chrome = useMemo<SettingsRailChromeCopy>(
    () => ({
      settings: tSettingsRail('settings'),
      backToApp: tSettingsRail('backToApp'),
      close: tSettingsRail('close'),
      docs: tSettingsRail('docs'),
    }),
    [tSettingsRail],
  );
  const organizationCopy = useMemo<AccountMembershipsCopy>(
    () => ({
      title: tOrganizations('title'),
      description: tOrganizations('description'),
      fallbackAccountName: tOrganizations('fallbackAccountName'),
      owner: tOrganizations('owner'),
      admin: tOrganizations('admin'),
      member: tOrganizations('member'),
      manage: tOrganizations('manage'),
    }),
    [tOrganizations],
  );
  const tabVisible = allItems.some((item) => isRailItemActive(item, tab));

  useEffect(() => {
    if (open && !tabVisible) {
      setTab(DEFAULT_SETTINGS_TAB);
    }
  }, [open, tabVisible, setTab]);

  const activeAllowed = isTabAllowed(tab);
  useEffect(() => {
    if (!open || activeAllowed) return;
    const fallback = allItems[0]?.tab ?? DEFAULT_SETTINGS_TAB;
    if (fallback !== tab) setTab(fallback);
  }, [open, activeAllowed, allItems, tab, setTab]);

  return (
    <SettingsNavProvider value={settingsNav}>
      <SettingsPanelView
        open={open}
        tab={tab}
        onTabChange={setTab}
        onOpenChange={(next) => (next ? undefined : close())}
        isMobile={isMobile}
        projectId={projectId}
        accountId={resolvedAccountId}
        groups={groups}
        allItems={allItems}
        organizations={memberships.accounts}
        organizationCopy={organizationCopy}
        chrome={chrome}
        startOnPane={paneRequested}
        // The dialog is the personal settings shell wherever it opens from —
        // inside a project too, where only the `workspace` pane knows the
        // project exists (KRTX-1975): the accessible title stays "Settings",
        // never "Settings — <project>".
        modalTitle={chrome.settings}
      />
    </SettingsNavProvider>
  );
}

export interface SettingsPanelViewProps {
  open: boolean;
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  onOpenChange: (open: boolean) => void;
  isMobile: boolean;
  /** Required by the `workspace` pane, and by nothing else — see
   *  `SettingsPanelShellProps`. `undefined` outside a project, which is the
   *  same condition that filters that pane out. */
  projectId: string | undefined;
  accountId: string | undefined;
  groups: readonly RailGroup[];
  allItems: readonly RailItem[];
  /**
   * The organizations the person belongs to, drawn under the Personal group
   * as links to each one's own settings surface. Members,
   * billing, roles and audit live THERE, not in this overlay (Marko,
   * 2026-09-03) — the overlay is personal, and this list is the way over.
   *
   * Since 2026-09-08 "over" is a swap between two modals, not a page load —
   * there is no `/accounts` route any more. `ModalClose` closes this one and
   * `HubLink` opens the account hub over the same page, one frame later.
   * Optional so the shell stays renderable without a query client.
   */
  organizations?: readonly AccountMembership[];
  organizationCopy: AccountMembershipsCopy;
  chrome: SettingsRailChromeCopy;
  modalTitle: string;
  /** Mobile: open on the current tab's pane, not on the section list. */
  startOnPane?: boolean;
}

export function SettingsPanelView({
  open,
  tab,
  onTabChange,
  onOpenChange,
  isMobile,
  projectId,
  accountId,
  groups,
  allItems,
  organizations,
  organizationCopy,
  chrome,
  modalTitle,
  startOnPane,
}: SettingsPanelViewProps) {
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent
        showCloseButton={false}
        closeOnOutsideClick={false}
        variant="base"
        animation="none"
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => {
          if (hasOpenFloatingLayer() || hasOpenNestedDialog()) {
            event.preventDefault();
          }
        }}
        // Full screen — the account settings shell (`/accounts/[id]`) as an
        // overlay, edge to edge (Jay, 2026-09-02: "make it full screen").
        // Same recipe as the Apps modal (`apps/apps-view.tsx`) and the
        // onboarding wizard: `side="fullscreen"` pins `inset-0`, and the
        // important-marked classes beat the centred-dialog defaults
        // `ModalVariants` adds at `lg:` (`top-1/2`, `-translate-x-1/2`,
        // `max-w-lg`, `rounded-xl`) plus the rounding `ModalContent` appends
        // after `className`.
        side="fullscreen"
        className={cn(
          'flex! flex-col! gap-0! space-y-0! overflow-hidden! p-0',
          'bg-surface! inset-0! h-dvh! max-h-none! min-h-dvh! w-auto! max-w-none!',
          'translate-x-0! translate-y-0! rounded-none! border-0!',
        )}
      >
        <ModalTitle className="sr-only">{modalTitle}</ModalTitle>
        <SettingsPanelShell
          tab={tab}
          onTabChange={onTabChange}
          isMobile={isMobile}
          projectId={projectId}
          accountId={accountId}
          groups={groups}
          allItems={allItems}
          organizations={organizations}
          organizationCopy={organizationCopy}
          chrome={chrome}
          startOnPane={startOnPane}
        />
      </ModalContent>
    </Modal>
  );
}

/**
 * The shell takes no `project`, and neither does the view any more. The view
 * took one to name the dialog "Settings — <project>"; that title lied about
 * what the dialog holds (every pane left in it is personal or account-scoped
 * but the one workspace pane — KRTX-1975), so the accessible title is plain
 * "Settings" now. The rail carried a `RelatedProjectsSwitcher` while the
 * overlay held thirteen project-configuration tabs; switching project from a
 * dialog that holds Profile, Preferences, Connected accounts and one
 * workspace pane changes nothing you can see in it, and the project sidebar's
 * own switcher (`project-sidebar/workspace-switcher.tsx`) is where that job
 * lives.
 *
 * `projectId` was dropped on 2026-08-17, when the last pane that consumed it —
 * the Connected tab's project-scoped ChatGPT row — was removed. It is back on
 * 2026-09-01 for exactly ONE pane again: `workspace`, which renders
 * `tabs/general-tab.tsx` and needs the id to read and write the project.
 *
 * That pane cannot render without one, and it does not have to guard: the same
 * `hasProject` condition that leaves `projectId` undefined also filters the
 * `workspace` row out of the rail (`ACCOUNT_SCOPED_SETTINGS_TABS` above), so
 * `SettingsTabPane` is never asked for it. Every OTHER pane is still user- or
 * account-scoped, which is what keeps the dialog openable from Cmd+, anywhere
 * in the app.
 */
export type SettingsPanelShellProps = Omit<
  SettingsPanelViewProps,
  'open' | 'onOpenChange' | 'modalTitle' | 'organizationCopy'
> & {
  organizationCopy?: AccountMembershipsCopy;
};

export function SettingsPanelShell({
  tab,
  onTabChange,
  isMobile,
  projectId,
  accountId,
  groups,
  allItems,
  organizations = [],
  organizationCopy = DEFAULT_ACCOUNT_MEMBERSHIPS_COPY,
  chrome,
  startOnPane = false,
}: SettingsPanelShellProps) {
  // A heading over a lone group labels nothing — it is the only group, and the
  // dialog's own title already says Settings. It comes back the moment a
  // second group does — or the Organizations block, which is a second list
  // under the same rail — which is the only case where the label does work.
  // The footer group (Connect) is a block at the foot of the rail, not a
  // second list, so it does not count.
  const showGroupLabels =
    groups.filter((group) => !group.footer).length > 1 || organizations.length > 0;
  const activeItem = allItems.find((item) => isRailItemActive(item, tab));
  // Mobile only: the list screen, or the pane screen. A caller that opened
  // settings on a named tab lands on that pane.
  const [mobilePane, setMobilePane] = useState(startOnPane);
  const railProps = { groups, showGroupLabels, organizations, organizationCopy, chrome };
  const closeButton = (
    <ModalClose asChild>
      <Button
        variant="ghost"
        size="icon-sm"
        className="kx-settings-mobile-close text-muted-foreground hit-area-2 shrink-0"
        aria-label={chrome.close}
      >
        <Close className="text-foreground size-4 stroke-1" />
      </Button>
    </ModalClose>
  );

  return (
    /* `activationMode="manual"`: Radix defaults to "automatic", which SELECTS
       each tab as arrow keys pass over it. Every pane here fetches on mount,
       so under the default, arrowing down the rail mounts each pane it passes
       and fires that pane's queries — a cost only keyboard users pay, and one
       neither tsc nor the suite can see. WAI-ARIA's own guidance is manual
       activation whenever selecting a tab has a side effect. Arrow moves
       focus; Enter/Space selects. */
    <SettingsRailCopyProvider groups={groups} chrome={chrome}>
      <Tabs
        value={tab}
        onValueChange={(next) => onTabChange(next as SettingsTab)}
        orientation="vertical"
        activationMode="manual"
        className={cn('min-h-0 flex-1 gap-0', isMobile ? 'flex flex-col' : 'grid')}
        // The shell's own sidebar width, so the overlay and `/accounts/[id]`
        // measure the same column.
        style={isMobile ? undefined : { gridTemplateColumns: `${SETTINGS_SIDEBAR_WIDTH_PX}px 1fr` }}
      >
        {isMobile ? (
          /* Mobile is two screens, like a phone's Settings app: this list,
             then the picked pane with a back pill (in <main> below). The old
             tab strip clipped every label past the third at phone width. */
          mobilePane ? null : (
            <div className="flex min-h-0 flex-1 flex-col bg-inherit">
              <header
                className="kx-titlebar-row kx-titlebar-band-height kx-settings-mobile-titlebar flex h-11 shrink-0 items-center justify-between border-b px-2"
                data-sidebar-collapsed=""
              >
                <span className="px-2 text-sm font-medium">{chrome.settings}</span>
                {closeButton}
              </header>
              <RailNav {...railProps} className="pt-2" onPick={() => setMobilePane(true)} />
            </div>
          )
        ) : (
          /* The settings sidebar, as `/accounts/[id]` draws it
           (`accounts/hub/account-settings-sidebar.tsx`): one column — the
           `Back to app` row on top, then the rows. Same background as the
           content — the hairline is the only seam. */
          <aside className="flex min-h-0 flex-col border-r bg-inherit">
            <div className="kx-titlebar-row kx-titlebar-band-height kx-overlay-sidebar-titlebar flex h-11 shrink-0 items-center justify-start px-2">
              <ModalClose asChild>
                <Button variant="ghost" size="xs" className={backPillClass()}>
                  <BackPillBody label={chrome.backToApp} />
                </Button>
              </ModalClose>
            </div>
            <RailNav {...railProps} />
          </aside>
        )}

        <main
          className={cn(
            'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-inherit',
            isMobile && !mobilePane && 'hidden',
          )}
        >
          {isMobile ? (
            mobilePane && (
              <header
                className="kx-titlebar-row kx-titlebar-band-height kx-settings-mobile-titlebar flex h-11 shrink-0 items-center gap-1 border-b px-2"
                data-sidebar-collapsed=""
              >
                <Button
                  variant="ghost"
                  size="xs"
                  className={backPillClass()}
                  onClick={() => setMobilePane(false)}
                >
                  <BackPillBody label={chrome.settings} />
                </Button>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {activeItem?.label}
                </span>
                {closeButton}
              </header>
            )
          ) : (
            /* The 44px `Settings / <pane>` bar the account shell puts over its
             content (`account-settings-shell.tsx`). Neither crumb is a link:
             Settings is where you are, and the pane is picked in the rail. */
            <header className="kx-titlebar-row kx-titlebar-band-height flex h-11 shrink-0 items-center border-b px-2">
              <Breadcrumb className="min-w-0 flex-1">
                <BreadcrumbList className="text-foreground flex-nowrap gap-1 text-sm font-medium sm:gap-1">
                  <BreadcrumbItem className="min-w-0">
                    <span className="flex h-7 items-center px-2">{chrome.settings}</span>
                  </BreadcrumbItem>
                  {activeItem ? (
                    <>
                      <BreadcrumbSeparator>
                        <span aria-hidden className="bg-border block h-3.5 w-px rotate-12" />
                      </BreadcrumbSeparator>
                      <BreadcrumbItem className="min-w-0">
                        <BreadcrumbPage className="flex h-7 items-center truncate px-2 font-medium">
                          {activeItem.label}
                        </BreadcrumbPage>
                      </BreadcrumbItem>
                    </>
                  ) : null}
                </BreadcrumbList>
              </Breadcrumb>
            </header>
          )}
          {allItems.map((item) => (
            <TabsContent
              key={item.tab}
              value={item.tab}
              /* The account pane's gutters (`account-pane.tsx`: 48px around a
               centred column). The pane scrolls, the frame does not. */
              className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto px-4 py-10 sm:px-12 sm:py-12"
            >
              <SettingsTabPane
                item={item}
                active={item.tab === tab}
                projectId={projectId}
                accountId={accountId}
              />
            </TabsContent>
          ))}
        </main>
      </Tabs>
    </SettingsRailCopyProvider>
  );
}

function SettingsTabPane({
  item,
  active,
  projectId,
  accountId,
}: {
  item: RailItem;
  active: boolean;
  projectId: string | undefined;
  accountId: string | undefined;
}) {
  if (!active) return null;

  // Workspace name and icon have one implementation and one set of mutations,
  // and this is now its only mount: `/projects/<id>/config` and the
  // `capabilities/project-settings/` directory behind it were both retired on
  // 2026-09-02. This pane was the second door; it is the only door.
  //
  // The `projectId` guard is belt-and-braces: the row is filtered out of the
  // rail whenever there is no project, so this branch is unreachable without
  // one. It is here so the pane degrades to its own label rather than
  // rendering `GeneralTab` with an empty id if that gate is ever loosened.
  if (item.tab === 'workspace' && projectId) {
    return <GeneralTab projectId={projectId} />;
  }
  // The two other Workspace rows: mounted exactly as
  // `project-settings-page.tsx` mounts them — `sandbox` is BOTH components,
  // stacked, because a snapshot is the build history of a sandbox template.
  if (item.tab === 'sandbox' && projectId) {
    return (
      <div className="space-y-8">
        <SandboxTab projectId={projectId} />
        <SnapshotsTab projectId={projectId} />
      </div>
    );
  }
  if (item.tab === 'feature-flags' && projectId) {
    return <ExperimentalTab projectId={projectId} />;
  }
  if (item.tab === 'upgrades' && projectId) {
    return <UpgradesView projectId={projectId} />;
  }
  if (item.tab === 'profile') {
    return <ProfileTab />;
  }
  if (item.tab === 'security') {
    return <SecurityTab />;
  }
  if (item.tab === 'appearance') {
    return <AppearanceTab />;
  }
  if (item.tab === 'sessions') {
    return <SessionsTab projectId={projectId} />;
  }
  if (item.tab === 'preferences') {
    return <PreferencesTab />;
  }
  if (item.tab === 'connected') {
    return <ConnectedAccountsTab accountId={accountId} />;
  }
  if (item.tab === 'tokens') {
    return <TokensTab accountId={accountId} />;
  }
  if (item.tab === 'credits') {
    return <CreditsTab accountId={accountId} />;
  }
  if (item.tab === 'plan') {
    return <PlanTab accountId={accountId} />;
  }
  if (item.tab === 'mcp') {
    return <McpTab />;
  }
  if (item.tab === 'computer' && projectId) {
    return <ComputerTab projectId={projectId} />;
  }

  // Unreachable while every `SettingsTab` member has a branch above, and kept
  // for the next one: a tab added to the union with no branch renders its own
  // name rather than an empty pane.
  return (
    <div className="p-6">
      <SettingsSectionHeader title={item.label} />
    </div>
  );
}

/**
 * The rail's rows: the settings groups, then the organizations. The desktop
 * sidebar and the mobile home screen draw the same list.
 */
function RailNav({
  groups,
  showGroupLabels,
  organizations,
  organizationCopy,
  chrome,
  onPick,
  className,
}: {
  groups: readonly RailGroup[];
  showGroupLabels: boolean;
  organizations: readonly AccountMembership[];
  organizationCopy: AccountMembershipsCopy;
  chrome: SettingsRailChromeCopy;
  onPick?: () => void;
  className?: string;
}) {
  return (
    <nav
      aria-label={chrome.settings}
      className={cn(
        'flex min-h-0 flex-1 [scrollbar-width:none] flex-col gap-4 overflow-y-auto px-2 pb-2 [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
    >
      {groups.filter((group) => !group.footer).map((group) => (
        <div key={group.label}>
          {showGroupLabels ? (
            <div className="text-muted-foreground flex h-7 items-center px-2.5 text-xs font-medium">
              {group.label}
            </div>
          ) : null}
          <TabsList orientation="vertical" className="w-full">
            {group.items.map((item) => (
              <TabsTrigger
                key={item.tab}
                value={item.tab}
                size="md"
                // Runs on every tap, so mobile opens the pane even for the row
                // already selected (Radix fires no value change for it).
                onClick={onPick}
                className={cn(
                  // The project sidebar's nav-row type: medium label,
                  // icon in the label colour (bold from IconProvider).
                  // Rows rest at 75%; the active one is full ink.
                  'gap-2 px-2.5 py-1 font-medium transition-none has-[>svg]:px-2.5',
                  'data-[state=inactive]:text-sidebar-foreground/75 hover:bg-hover data-[state=inactive]:hover:text-sidebar-foreground',
                  'data-[state=active]:bg-active data-[state=active]:text-sidebar-foreground',
                )}
              >
                <RailTriggerBody item={item} />
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      ))}

      {organizations.length > 0 ? (
        /* The organizations the person belongs to. Each row LEAVES the
         overlay for that organization's own settings page — members,
         billing, roles, audit all live there — so it is a link that
         closes the dialog, not a tab. Same row footprint as the tabs
         above so the rail reads as one list with two kinds of row. */
        <div>
          <div className="text-muted-foreground flex h-7 items-center px-2.5 text-xs font-medium">
            {organizationCopy.title}
          </div>
          <ul className="flex flex-col gap-0.5">
            {organizations.map((account) => (
              <li key={account.account_id}>
                <ModalClose asChild>
                  <HubLink
                    to={hubTarget(account.account_id)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2.5 pt-1 pb-1.5 text-sm font-medium',
                      'text-sidebar-foreground/75 hover:bg-hover hover:text-sidebar-foreground transition-colors',
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">
                        {account.name?.trim() || organizationCopy.fallbackAccountName}
                      </span>
                      {accountRoleLabel(account.account_role, organizationCopy) ? (
                        <span className="text-muted-foreground block truncate text-xs font-normal">
                          {accountRoleLabel(account.account_role, organizationCopy)}
                        </span>
                      ) : null}
                    </span>
                  </HubLink>
                </ModalClose>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {groups
        .filter((group) => group.footer)
        .map((group) => (
          <RailFooterGroup key={group.label} group={group} onPick={onPick} />
        ))}
    </nav>
  );
}

/**
 * The Connect group at the foot of the rail (KRTX-1997): the same two rows the
 * project sidebar footer shows — one block, 1px seam, inner corners
 * `rounded-sm`, a "New" badge — but each is a tab here, so it opens its page
 * in this dialog, and none can be dismissed. `aria-label` names the list for
 * screen readers, which hear no group heading.
 */
function RailFooterGroup({ group, onPick }: { group: RailGroup; onPick?: () => void }) {
  const tSidebar = useI18nTranslations('sidebar');
  return (
    <TabsList
      orientation="vertical"
      aria-label={group.label}
      className="mt-auto w-full gap-px [&>button:not(:first-child)]:rounded-t-sm [&>button:not(:last-child)]:rounded-b-sm"
    >
      {group.items.map((item) => (
        <TabsTrigger
          key={item.tab}
          value={item.tab}
          size="md"
          onClick={onPick}
          className={cn(
            'bg-hover text-sidebar-foreground gap-2 px-2.5 py-1 font-medium transition-none has-[>svg]:px-2.5',
            'hover:bg-active data-[state=active]:bg-active data-[state=active]:text-sidebar-foreground',
          )}
        >
          <RailTriggerBody item={item} />
          <span className="bg-kortix-blue/15 text-kortix-blue ms-auto flex h-5 shrink-0 items-center rounded-sm px-1.5 text-xs font-medium">
            {tSidebar('new')}
          </span>
        </TabsTrigger>
      ))}
    </TabsList>
  );
}

function RailTriggerBody({ item, horizontal = false }: { item: RailItem; horizontal?: boolean }) {
  const Icon = item.icon;
  return (
    <>
      {Icon && <Icon className="size-4 shrink-0" />}
      <span className={cn(!horizontal && 'truncate')}>{item.label}</span>
    </>
  );
}
