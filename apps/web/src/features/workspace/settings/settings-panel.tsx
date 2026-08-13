'use client';

import { ScheduleView } from '@/components/projects/schedule-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import { Modal, ModalClose, ModalContent, ModalTitle } from '@/components/ui/modal';
import { SettingsSectionHeader } from '@/components/ui/settings-section-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Close } from '@/features/icon/icons/close';
import { MarketplaceView } from '@/features/marketplace/marketplace-view';
import { useReviewSessionSummary } from '@/features/review-center/hooks/use-review-session-summary';
import { detectManifestVersion } from '@/features/workspace/customize/migrate-to-v2/manifest-version';
import { UpgradesView } from '@/features/workspace/customize/migrate-to-v2/upgrade-view';
import { RelatedProjectsSwitcher } from '@/features/workspace/customize/related-projects-switcher';
import { ChannelsView } from '@/features/workspace/customize/sections/view/channels-view';
import { GitView } from '@/features/workspace/customize/sections/view/git-view';
import { ReviewView } from '@/features/workspace/customize/sections/view/review-view';
import { SecretsView } from '@/features/workspace/customize/sections/view/secrets-view';
import { VoiceView } from '@/features/workspace/customize/sections/view/voice-view';
import {
  SettingsNavProvider,
  type SettingsNav,
} from '@/features/workspace/shared/settings-nav-context';
import { useIsMobile } from '@/hooks/utils';
import { isBillingEnabled } from '@/lib/config';
import { isLlmGatewayAvailable, isLlmGatewayEnabled } from '@/lib/llm-gateway';
import {
  CUSTOMIZE_SECTION_GATE_ACTIONS,
  isCustomizeSectionVisible,
  type CustomizeSection,
  type ProjectAction,
} from '@/lib/project-actions';
import { usePermissions } from '@/lib/use-permission';
import { useProjectCans } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import { hasOpenFloatingLayer, hasOpenNestedDialog } from '@/lib/z-stack';
import { useSettingsPanelStore, type MembersTab } from '@/stores/settings-panel-store';
import { getProjectDetail, type KortixProject } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { ArrowLeftIcon as ArrowLeft, MagnifyingGlassIcon as Search } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  UPGRADE_ITEM,
  filterRailGroups,
  isRailItemActive,
  railGroups,
  railItemMatches,
} from './rail';
import { DEFAULT_SETTINGS_TAB, type SettingsTab } from './settings-tabs';
import { ApiKeysTab } from './tabs/api-keys-tab';
import { AuditTab } from './tabs/audit-tab';
import { BillingTab } from './tabs/billing-tab';
import { ConnectedAccountsTab } from './tabs/connected-tab';
import { ExperimentalTab } from './tabs/experimental-tab';
import { GeneralTab } from './tabs/general-tab';
import { GroupsTab } from './tabs/groups-tab';
import { IdentityTab } from './tabs/identity-tab';
import { ModelsTab } from './tabs/models-tab';
// Aliased: `@/stores/settings-panel-store` already exports a TYPE named
// `MembersTab` ('people' | 'invite', the deep-link intent — imported below
// as `type MembersTab`), which collides with this file's own component
// name. Only this import site needs the alias; `tabs/members-tab.tsx` keeps
// the un-aliased `MembersTab` name, matching every sibling tab's naming
// convention (`GeneralTab`, `ApiKeysTab`, …).
import { MembersTab as MembersTabPane } from './tabs/members-tab';
import { OrganizationTab } from './tabs/organization-tab';
import { PreferencesTab } from './tabs/preferences-tab';
import { ProfileTab } from './tabs/profile-tab';
import { RolesTab } from './tabs/roles-tab';
import { SandboxTab } from './tabs/sandbox-tab';
import { SnapshotsTab } from './tabs/snapshots-tab';
import { UsageTab } from './tabs/usage-tab';
import type { RailGroup, RailItem } from './type';
import { useSettingsAccountId } from './use-settings-account-id';

const GATED_TAB_SECTION: Partial<Record<SettingsTab, CustomizeSection>> = {
  general: 'settings',
  members: 'members',
  secrets: 'secrets',
  channels: 'channels',
  repositories: 'git',
  schedules: 'schedules',
  webhooks: 'webhooks',
  models: 'llm-management',
  sandbox: 'sandbox',
  marketplace: 'marketplace',
  review: 'review',
  voice: 'voice',
  experimental: 'feature-flags',
  upgrades: 'upgrade',
};

export const ACCOUNT_TAB_PERMISSION: Partial<Record<SettingsTab, string>> = {
  billing: 'account.write',
  usage: 'account.write',
  roles: 'role.create',
  'api-keys': 'account.write',
  identity: 'account.write',
  audit: 'audit.read',
  organization: 'account.write',
};

const ACCOUNT_TAB_GATE_ACTIONS: readonly string[] = Array.from(
  new Set(Object.values(ACCOUNT_TAB_PERMISSION)),
);
const ACCOUNT_TAB_PROBES = ACCOUNT_TAB_GATE_ACTIONS.map((action) => ({ action }));

export const ACCOUNT_SCOPED_SETTINGS_TABS: readonly SettingsTab[] = [
  'profile',
  'preferences',
  'connected',
  'organization',
  'billing',
  'usage',
  'groups',
  'roles',
  'identity',
  'audit',
  'api-keys',
];

export interface SettingsTabAllowedParams {
  hasProject: boolean;
  projectCapsResolved: boolean;
  projectCan: (action: ProjectAction) => boolean;
  accountPermsResolved: boolean;
  accountCan: (action: string) => boolean;
  billingEnabled: boolean;
}

export function isSettingsTabAllowed(tab: SettingsTab, params: SettingsTabAllowedParams): boolean {
  if (!params.hasProject && !ACCOUNT_SCOPED_SETTINGS_TABS.includes(tab)) return false;

  if (tab === 'billing' && !params.billingEnabled) return false;

  const section = GATED_TAB_SECTION[tab];
  if (section) {
    if (!params.projectCapsResolved) return true;
    return isCustomizeSectionVisible(section, params.projectCan);
  }
  const accountAction = ACCOUNT_TAB_PERMISSION[tab];
  if (accountAction) {
    if (!params.accountPermsResolved) return true;
    return params.accountCan(accountAction);
  }
  return true;
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

export function SettingsPanel({ projectId }: { projectId?: string }) {
  const open = useSettingsPanelStore((s) => s.open);
  const tab = useSettingsPanelStore((s) => s.tab);
  const setTab = useSettingsPanelStore((s) => s.setTab);
  const close = useSettingsPanelStore((s) => s.close);
  // Reactive (not getState()) so it re-renders this provider — and every
  // useSettingsNav() consumer — when membersTab changes, e.g. a deep link
  // opening straight to Invite.
  const membersTab = useSettingsPanelStore((s) => s.membersTab);
  const settingsNav = useMemo(
    () => buildSettingsPanelSettingsNav({ open, tab, membersTab }),
    [open, tab, membersTab],
  );
  const isMobile = useIsMobile();

  const detail = useQuery({
    queryKey: qk.project.detail(projectId ?? ''),
    queryFn: () => getProjectDetail(projectId!),
    enabled: open && !!projectId,
    ...contract('config'),
  });
  const project = projectId ? detail.data?.project : undefined;

  const caps = useProjectCans(open ? projectId : undefined, CUSTOMIZE_SECTION_GATE_ACTIONS, {
    accountId: project?.account_id,
  });

  const capsResolved = useMemo(
    () =>
      CUSTOMIZE_SECTION_GATE_ACTIONS.every(
        (action) => caps[action] && !caps[action].isLoading && !caps[action].isError,
      ),
    [caps],
  );

  const resolvedAccountId = useSettingsAccountId(project?.account_id);
  const accountProbeReady = open && !!resolvedAccountId;
  const accountPerms = usePermissions(
    accountProbeReady ? resolvedAccountId : undefined,
    ACCOUNT_TAB_PROBES,
  );
  const accountPermsResolved = useMemo(
    () => accountProbeReady && accountPerms.every((p) => !p.isLoading && !p.isError),
    [accountProbeReady, accountPerms],
  );
  const accountCan = useCallback(
    (action: string) => {
      const idx = ACCOUNT_TAB_GATE_ACTIONS.indexOf(action);
      return idx >= 0 && accountPerms[idx]?.allowed === true;
    },
    [accountPerms],
  );

  const billingEnabled = isBillingEnabled();

  const isTabAllowed = useCallback(
    (t: SettingsTab) =>
      isSettingsTabAllowed(t, {
        hasProject: !!projectId,
        projectCapsResolved: capsResolved,
        projectCan: (action) => caps[action]?.allowed === true,
        accountPermsResolved,
        accountCan,
        billingEnabled,
      }),
    [projectId, caps, capsResolved, accountPermsResolved, accountCan, billingEnabled],
  );

  const marketplaceEnabled = project?.experimental?.marketplace ?? false;
  const llmGatewayAvailable = isLlmGatewayAvailable(project);
  // Distinct from `llmGatewayAvailable` above (which only affects rail
  // visibility, per `rail.ts`'s comment — the Models row always shows).
  // `llmGatewayEnabled` gates the Models tab's actual CONTENT, mirroring
  // the legacy panel's `if (section.startsWith('llm-') &&
  // !llmGatewayEnabled) return null;` exactly.
  const llmGatewayEnabled = isLlmGatewayEnabled(project);
  const voiceEnabled = project?.experimental?.voice ?? false;
  const reviewEnabled = project?.experimental?.review_center ?? false;
  // Pin Upgrades' attention dot only once the manifest read resolved to v1 —
  // while the detail query is in flight (or on v2 projects) the dot stays off.
  const upgradeAttention = detail.data
    ? detectManifestVersion(detail.data.config.manifest_raw) === 1
    : false;

  // "Needs you" count for the Review rail badge — the SAME shared inbox summary the
  // sidebar "Review" pill and the per-session row dots read (one query key, one
  // derivation), so the badge, the pill, and the dots can never drift apart.
  const reviewNeedsYou = useReviewSessionSummary(projectId ?? '', {
    enabled: open && reviewEnabled,
  }).totalNeedsYou;

  const groups = useMemo(
    () =>
      railGroups({
        marketplaceEnabled,
        llmGatewayAvailable,
        voiceEnabled,
        reviewEnabled,
      })
        .map((g) => ({ ...g, items: g.items.filter((item) => isTabAllowed(item.tab)) }))
        .filter((g) => g.items.length > 0),
    [marketplaceEnabled, llmGatewayAvailable, voiceEnabled, reviewEnabled, isTabAllowed],
  );
  const upgradeAllowed = isTabAllowed('upgrades');
  const allItems = useMemo(
    () => [...groups.flatMap((g) => g.items), ...(upgradeAllowed ? [UPGRADE_ITEM] : [])],
    [groups, upgradeAllowed],
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
        project={project}
        projectId={projectId}
        accountId={project?.account_id}
        groups={groups}
        allItems={allItems}
        upgradeAllowed={upgradeAllowed}
        upgradeAttention={upgradeAttention}
        reviewNeedsYou={reviewNeedsYou}
        llmGatewayEnabled={llmGatewayEnabled}
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
  project: KortixProject | undefined;
  projectId: string | undefined;
  accountId: string | undefined;
  groups: readonly RailGroup[];
  allItems: readonly RailItem[];
  upgradeAllowed: boolean;
  upgradeAttention: boolean;
  reviewNeedsYou: number;
  /** Gates the Models tab's CONTENT (not its rail visibility — see
   *  `SettingsPanel`'s comment next to where this is computed). */
  llmGatewayEnabled: boolean;
}

export function SettingsPanelView({
  open,
  tab,
  onTabChange,
  onOpenChange,
  isMobile,
  project,
  projectId,
  accountId,
  groups,
  allItems,
  upgradeAllowed,
  upgradeAttention,
  reviewNeedsYou,
  llmGatewayEnabled,
}: SettingsPanelViewProps) {
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent
        animation="none"
        showCloseButton={false}
        closeOnOutsideClick={false}
        variant="base"
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => {
          if (hasOpenFloatingLayer() || hasOpenNestedDialog()) {
            event.preventDefault();
          }
        }}
        className={cn(
          'flex flex-col gap-0 overflow-hidden p-0',
          'inset-0 top-0 left-0 h-dvh min-h-dvh w-screen max-w-none translate-x-0 translate-y-0 space-y-0 rounded-none border-0 shadow-none sm:max-w-none sm:rounded-none md:rounded-none lg:top-0 lg:left-0 lg:h-dvh lg:min-h-dvh lg:max-w-none lg:translate-x-0 lg:translate-y-0 lg:rounded-none',
        )}
      >
        <ModalTitle className="sr-only">
          {project ? `Settings — ${project.name}` : 'Settings'}
        </ModalTitle>

        <SettingsPanelShell
          tab={tab}
          onTabChange={onTabChange}
          isMobile={isMobile}
          project={project}
          projectId={projectId}
          accountId={accountId}
          groups={groups}
          allItems={allItems}
          upgradeAllowed={upgradeAllowed}
          upgradeAttention={upgradeAttention}
          reviewNeedsYou={reviewNeedsYou}
          llmGatewayEnabled={llmGatewayEnabled}
        />
      </ModalContent>
    </Modal>
  );
}

export type SettingsPanelShellProps = Omit<SettingsPanelViewProps, 'open' | 'onOpenChange'>;

export function SettingsPanelShell({
  tab,
  onTabChange,
  isMobile,
  project,
  projectId,
  accountId,
  groups,
  allItems,
  upgradeAllowed,
  upgradeAttention,
  reviewNeedsYou,
  llmGatewayEnabled,
}: SettingsPanelShellProps) {
  const [query, setQuery] = useState('');

  // Only the DESKTOP RAIL is filtered. `allItems` still drives every
  // `TabsContent` below and the mobile scroller, so typing never unmounts the
  // pane you are reading, and `SettingsPanel`'s "is the active tab still
  // visible" effect — which reads `allItems`, not this — cannot fire mid-query
  // and move you off the tab you were on.
  const visibleGroups = useMemo(() => filterRailGroups(groups, query), [groups, query]);
  const upgradeVisible = railItemMatches(UPGRADE_ITEM, query);

  return (
    <>
      <div className="kx-titlebar-spacer shrink-0" />

      {/* `activationMode="manual"`: Radix defaults to "automatic", which SELECTS
          each tab as arrow keys pass over it. With 28 rail entries and a pane
          per tab that fetches on mount, arrowing from Profile to the bottom of
          the rail would mount every pane in between and fire each one's
          queries — a cost only keyboard users pay, and one neither tsc nor the
          suite can see. WAI-ARIA's own guidance is manual activation whenever
          selecting a tab has a side effect. Arrow moves focus; Enter/Space
          selects. Pinned by `settings-panel-a11y.test.ts`. */}
      <Tabs
        value={tab}
        onValueChange={(next) => onTabChange(next as SettingsTab)}
        orientation="vertical"
        activationMode="manual"
        className={cn(
          'min-h-0 flex-1 gap-0',
          isMobile ? 'flex flex-col' : 'grid grid-cols-[250px_1fr]',
        )}
      >
        {isMobile ? (
          <nav
            aria-label="Settings"
            className="border-border/60 bg-background flex h-auto shrink-0 items-center border-b"
          >
            <FadedScrollArea
              orientation="horizontal"
              fadeColor="from-background"
              className="min-w-0 flex-1 py-2"
            >
              <TabsList orientation="horizontal" className="w-fit gap-1 px-2">
                {allItems.map((item) => (
                  <TabsTrigger
                    key={item.tab}
                    value={item.tab}
                    className="w-auto shrink-0 gap-2.5 px-3 whitespace-nowrap"
                  >
                    <RailTriggerBody
                      item={item}
                      count={item.tab === 'review' ? reviewNeedsYou : undefined}
                      attention={item.tab === 'upgrades' && upgradeAttention}
                      horizontal
                    />
                  </TabsTrigger>
                ))}
              </TabsList>
            </FadedScrollArea>
            <div className="flex shrink-0 items-center px-4">
              <ModalClose asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground hit-area-2 shrink-0"
                  aria-label="Close"
                >
                  <Close className="text-foreground size-4 stroke-1" />
                </Button>
              </ModalClose>
            </div>
          </nav>
        ) : (
          <section className="bg-accent/50 flex min-h-0 flex-col border-r py-2">
            <div className="w-full shrink-0 px-2.5">
              <ModalClose asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground flex w-full items-center justify-start gap-2 px-4 py-0.75 text-left text-sm font-medium"
                >
                  <ArrowLeft />
                  Back to workspace
                </Button>
              </ModalClose>
            </div>

            {/* Directly under Back to workspace, above everything it filters,
                and outside the scrolling <nav> — the field stays put while the
                results move under it. */}
            <div className="mt-2 w-full shrink-0 px-2.5">
              <InputGroupSearch>
                <InputGroupSearchIcon>
                  <Search />
                </InputGroupSearchIcon>
                <InputGroupSearchInput
                  placeholder="Search settings"
                  aria-label="Search settings"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  variant="popover"
                  className="h-8"
                />
                <InputGroupSearchClear onClick={() => setQuery('')} />
              </InputGroupSearch>
            </div>

            {project ? <RelatedProjectsSwitcher project={project} /> : null}

            <nav
              aria-label="Settings"
              className="mt-4 min-h-0 flex-1 [scrollbar-width:none] overflow-y-auto px-2.5 py-3 [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
            >
              {visibleGroups.map((group, idx) => (
                <div key={group.label} className={cn('space-y-1.5', idx > 0 ? 'mt-4' : undefined)}>
                  <Label className="text-muted-foreground px-3 text-xs">{group.label}</Label>
                  <TabsList orientation="vertical" className="w-full">
                    {group.items.map((item) => (
                      <TabsTrigger
                        key={item.tab}
                        value={item.tab}
                        className="hover:data-[state=inactive]:bg-secondary data-[state=active]:bg-secondary w-full justify-start gap-2.5 py-0.75"
                      >
                        <RailTriggerBody
                          item={item}
                          count={item.tab === 'review' ? reviewNeedsYou : undefined}
                        />
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </div>
              ))}

              {/* The documented no-match shape (design system, "Search +
                  loading + empty flow"), not an EmptyState — a 250px rail has
                  no room for an icon and a call to action. */}
              {visibleGroups.length === 0 && !upgradeVisible ? (
                <p className="text-muted-foreground px-3 py-6 text-center text-xs text-balance">
                  No settings match “{query.trim()}”.
                </p>
              ) : null}
            </nav>

            {/* Upgrades is pinned outside the scrolling groups, so it has to be
                filtered on its own or it would sit there contradicting a search
                that matched nothing. */}
            {upgradeAllowed && upgradeVisible && (
              <div className="mt-2 shrink-0 px-2.5 pt-3">
                <TabsList orientation="vertical">
                  <TabsTrigger value={UPGRADE_ITEM.tab} className="gap-2.5">
                    <RailTriggerBody item={UPGRADE_ITEM} attention={upgradeAttention} />
                  </TabsTrigger>
                </TabsList>
              </div>
            )}
          </section>
        )}

        <main className="bg-background flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {allItems.map((item) => (
            <TabsContent
              key={item.tab}
              value={item.tab}
              className={cn(
                'mx-auto flex min-h-0 w-full flex-1 flex-col space-y-6 overflow-y-auto',
                item.tab !== 'marketplace' && item.tab !== 'models' && 'px-4 py-10 pb-20 lg:py-20',
              )}
            >
              <SettingsTabPane
                item={item}
                active={item.tab === tab}
                projectId={projectId}
                accountId={accountId}
                llmGatewayEnabled={llmGatewayEnabled}
              />
            </TabsContent>
          ))}
        </main>
      </Tabs>
    </>
  );
}

function SettingsTabPane({
  item,
  active,
  projectId,
  accountId,
  llmGatewayEnabled,
}: {
  item: RailItem;
  active: boolean;
  projectId: string | undefined;
  accountId: string | undefined;
  llmGatewayEnabled: boolean;
}) {
  if (!active) return null;

  if (item.tab === 'profile') {
    return <ProfileTab />;
  }
  if (item.tab === 'preferences') {
    return <PreferencesTab />;
  }
  if (item.tab === 'connected') {
    return <ConnectedAccountsTab projectId={projectId} accountId={accountId} />;
  }
  if (item.tab === 'billing') {
    return <BillingTab accountId={accountId} />;
  }
  if (item.tab === 'usage') {
    return <UsageTab accountId={accountId} />;
  }
  if (item.tab === 'groups') {
    return <GroupsTab accountId={accountId} />;
  }
  if (item.tab === 'roles') {
    return <RolesTab accountId={accountId} />;
  }
  if (item.tab === 'identity') {
    return <IdentityTab accountId={accountId} />;
  }
  if (item.tab === 'audit') {
    return <AuditTab accountId={accountId} />;
  }
  if (item.tab === 'api-keys') {
    return <ApiKeysTab accountId={accountId} />;
  }
  if (item.tab === 'organization') {
    return <OrganizationTab accountId={accountId} />;
  }

  if (projectId) {
    switch (item.tab) {
      case 'general':
        return <GeneralTab projectId={projectId} />;
      case 'experimental':
        return <ExperimentalTab projectId={projectId} />;
      case 'members':
        return <MembersTabPane projectId={projectId} accountId={accountId} />;
      case 'secrets':
        return <SecretsView projectId={projectId} />;
      case 'channels':
        return <ChannelsView projectId={projectId} />;
      case 'repositories':
        return <GitView projectId={projectId} />;
      case 'schedules':
        return <ScheduleView projectId={projectId} type="cron" />;
      case 'webhooks':
        return <ScheduleView projectId={projectId} type="webhook" />;
      case 'models':
        return <ModelsTab projectId={projectId} llmGatewayEnabled={llmGatewayEnabled} />;
      case 'marketplace':
        return <MarketplaceView projectId={projectId} />;
      case 'review':
        return <ReviewView projectId={projectId} />;
      case 'voice':
        return <VoiceView projectId={projectId} />;
      case 'sandbox':
        return <SandboxTab projectId={projectId} />;
      case 'snapshots':
        return <SnapshotsTab projectId={projectId} />;
      case 'upgrades':
        return <UpgradesView projectId={projectId} />;
      default:
        break;
    }
  }

  return (
    <div className="p-6">
      <SettingsSectionHeader title={item.label} />
    </div>
  );
}

function RailTriggerBody({
  item,
  count,
  attention,
  horizontal = false,
}: {
  item: RailItem;
  count?: number;
  attention?: boolean;
  horizontal?: boolean;
}) {
  const Icon = item.icon;
  const showCount = count != null && count > 0;
  return (
    <>
      {Icon && <Icon className="size-4 shrink-0" />}
      <span className={cn(!horizontal && 'truncate')}>{item.label}</span>
      {showCount ? (
        <Badge variant="kortix" size="xs" className={cn('tabular-nums', !horizontal && 'ml-auto')}>
          {count}
        </Badge>
      ) : attention ? (
        <span
          aria-hidden
          className={cn(
            'bg-kortix-orange size-1.5 shrink-0 rounded-full',
            !horizontal && 'ml-auto',
          )}
        />
      ) : null}
    </>
  );
}
