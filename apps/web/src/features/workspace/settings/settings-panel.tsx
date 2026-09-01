'use client';

import { Button } from '@/components/ui/button';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import { Label } from '@/components/ui/label';
import { Modal, ModalClose, ModalContent, ModalTitle } from '@/components/ui/modal';
import { SettingsSectionHeader } from '@/components/ui/settings-section-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Close } from '@/features/icon/icons/close';
import {
  SettingsNavProvider,
  type SettingsNav,
} from '@/features/workspace/shared/settings-nav-context';
import { useIsMobile } from '@/hooks/utils';
import { cn } from '@/lib/utils';
import { hasOpenFloatingLayer, hasOpenNestedDialog } from '@/lib/z-stack';
import { useSettingsPanelStore, type MembersTab } from '@/stores/settings-panel-store';
import { getProjectDetail, type KortixProject } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import { isRailItemActive, railGroups } from './rail';
import { DEFAULT_SETTINGS_TAB, type SettingsTab } from './settings-tabs';
import { ConnectedAccountsTab } from './tabs/connected-tab';
import { PreferencesTab } from './tabs/preferences-tab';
import { ProfileTab } from './tabs/profile-tab';
import { GeneralTab } from './tabs/general-tab';
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
  'preferences',
  'connected',
  // Your own API keys are yours in ONE account (the read is account-scoped —
  // see `tabs/tokens-tab.tsx`), but never in one project, so this renders with
  // or without a project open like the three above it.
  'tokens',
  // `workspace` is deliberately ABSENT. It is the one project-scoped tab in
  // this overlay (`settings-tabs.ts` explains why it came back), so leaving it
  // out of this list is exactly what makes `isSettingsTabAllowed` hide it — and
  // with it the whole `Workspace` rail group — on `/settings` and under
  // `/accounts/**`, where there is no project to name.
];

export interface SettingsTabAllowedParams {
  hasProject: boolean;
}

/**
 * Whether the overlay may show a tab at all.
 *
 * One rule left, and every surviving tab clears it: Profile, Preferences and
 * Connected accounts are user-scoped, so they render with or without a
 * project. The per-section IAM probe this used to run
 * (`GATED_TAB_SECTION` -> `isCustomizeSectionVisible`) went with the
 * project-configuration tabs it gated — those live at
 * `/projects/[id]/config` now, and that page runs the identical probe over
 * the identical leaves (`capabilities/project-settings/`).
 *
 * The function stays because the CONCEPT stays: a tab added here must declare
 * whether it needs a project, and the command palette mirrors this decision
 * (`isSettingsTabOfferable` in `settings-palette-items.ts`).
 */
export function isSettingsTabAllowed(tab: SettingsTab, params: SettingsTabAllowedParams): boolean {
  if (!params.hasProject && !ACCOUNT_SCOPED_SETTINGS_TABS.includes(tab)) return false;
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
    for (const g of railGroups()) {
      const items = g.items.filter((item) => isTabAllowed(item.tab));
      if (items.length > 0) allowed.push({ ...g, items });
    }
    return allowed;
  }, [isTabAllowed]);
  const allItems = useMemo(() => groups.flatMap((g) => g.items), [groups]);
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
        accountId={resolvedAccountId}
        groups={groups}
        allItems={allItems}
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
  /** Required by the `workspace` pane, and by nothing else — see
   *  `SettingsPanelShellProps`. `undefined` outside a project, which is the
   *  same condition that filters that pane out. */
  projectId: string | undefined;
  accountId: string | undefined;
  groups: readonly RailGroup[];
  allItems: readonly RailItem[];
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
}: SettingsPanelViewProps) {
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent
        showCloseButton={false}
        closeOnOutsideClick={false}
        variant="base"
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => {
          if (hasOpenFloatingLayer() || hasOpenNestedDialog()) {
            event.preventDefault();
          }
        }}
        // A compact, centred dialog — NOT the full-screen overlay this used to
        // be. The overlay shape was sized for a 28-row rail across four
        // groups; three user-scoped tabs in a `h-dvh w-screen` sheet read as a
        // whole app mode for what is a profile, a preference and a list of
        // linked identities. `lg:max-w-4xl` + a fixed height is the shape the
        // standalone user-settings modal had before the unification
        // (`089acb9eb5^:features/accounts/settings/side-panel-user-settings.tsx`,
        // `lg:max-w-4xl` over `h-[650px]`), restored around today's tabs.
        //
        // The height is FIXED, not content-driven: the three panes differ by
        // hundreds of pixels (Profile with 2FA enrolled vs. Connected with one
        // identity), and a dialog that resizes under you as you switch tabs is
        // the reason the old one pinned a height too. `min()` keeps it inside
        // short viewports instead of overflowing them.
        className={cn(
          'flex flex-col gap-0 space-y-0 overflow-hidden p-0',
          'h-[85dvh] max-h-[85dvh]',
          'lg:h-[min(660px,85dvh)] lg:w-full lg:max-w-4xl',
        )}
      >
        <ModalTitle className="sr-only">
          {project ? `Settings — ${project.name}` : 'Settings'}
        </ModalTitle>

        <SettingsPanelShell
          tab={tab}
          onTabChange={onTabChange}
          isMobile={isMobile}
          projectId={projectId}
          accountId={accountId}
          groups={groups}
          allItems={allItems}
        />
      </ModalContent>
    </Modal>
  );
}

/**
 * The shell takes no `project`, but it does take `projectId` again.
 *
 * `SettingsPanelView` takes `project` because it names the project in the
 * dialog's accessible title. Nothing inside the frame needs the whole entity.
 * The rail carried a `RelatedProjectsSwitcher` while the overlay held thirteen
 * project-configuration tabs; switching project from a dialog that holds
 * Profile, Preferences, Connected accounts and one workspace pane changes
 * nothing you can see in it, and the project sidebar's own switcher
 * (`project-sidebar/workspace-switcher.tsx`) is where that job lives.
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
  'open' | 'onOpenChange' | 'project'
>;

export function SettingsPanelShell({
  tab,
  onTabChange,
  isMobile,
  projectId,
  accountId,
  groups,
  allItems,
}: SettingsPanelShellProps) {
  // A heading over a lone group labels nothing — it is the only group, and the
  // dialog's own title already says Settings. It comes back the moment a
  // second group does, which is the only case where the label does work.
  const showGroupLabels = groups.length > 1;

  return (
    /* `activationMode="manual"`: Radix defaults to "automatic", which SELECTS
       each tab as arrow keys pass over it. Every pane here fetches on mount,
       so under the default, arrowing down the rail mounts each pane it passes
       and fires that pane's queries — a cost only keyboard users pay, and one
       neither tsc nor the suite can see. WAI-ARIA's own guidance is manual
       activation whenever selecting a tab has a side effect. Arrow moves
       focus; Enter/Space selects. Pinned by `settings-panel-a11y.test.ts`. */
    <Tabs
      value={tab}
      onValueChange={(next) => onTabChange(next as SettingsTab)}
      orientation="vertical"
      activationMode="manual"
      className={cn(
        'min-h-0 flex-1 gap-0',
        isMobile ? 'flex flex-col' : 'grid grid-cols-[13rem_1fr]',
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
                  <RailTriggerBody item={item} horizontal />
                </TabsTrigger>
              ))}
            </TabsList>
          </FadedScrollArea>
          <div className="flex shrink-0 items-center px-3">
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
        /* The old modal's left column: a close button at the top, the tab list
           under it, nothing else. That column was `col-span-3` of 12 at
           `max-w-4xl` — 224px; 13rem (208px) here, because the three labels fit
           it and the 16px goes to the content column, which then measures
           688px and carries every pane's `max-w-2xl` (672px) unclipped. */
        <section className="bg-accent/50 flex min-h-0 flex-col gap-2 border-r p-2.5">
          <div className="flex shrink-0 items-center">
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

          <nav
            aria-label="Settings"
            className="min-h-0 flex-1 [scrollbar-width:none] overflow-y-auto [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
          >
            {groups.map((group, idx) => (
              <div key={group.label} className={cn('space-y-1.5', idx > 0 ? 'mt-4' : undefined)}>
                {showGroupLabels ? (
                  <Label className="text-muted-foreground px-2 text-xs">{group.label}</Label>
                ) : null}
                <TabsList orientation="vertical" className="w-full">
                  {group.items.map((item) => (
                    <TabsTrigger
                      key={item.tab}
                      value={item.tab}
                      className="hover:data-[state=inactive]:bg-secondary data-[state=active]:bg-secondary w-full justify-start gap-2.5 px-2.5 py-0.75"
                    >
                      <RailTriggerBody item={item} />
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
            ))}
          </nav>
        </section>
      )}

      <main className="bg-background flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {allItems.map((item) => (
          <TabsContent
            key={item.tab}
            value={item.tab}
            /* The dialog is 660px tall, so the pane's own padding is what is
               left of the reading area: `py-10` here cost a fifth of it. The
               pane scrolls, the frame does not. */
            className="mx-auto flex min-h-0 w-full flex-1 flex-col space-y-6 overflow-y-auto px-6 py-6"
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

  // The SAME component `/projects/<id>/config?section=general` renders
  // (`capabilities/project-settings/project-settings-page.tsx`), not a copy.
  // Workspace name and icon have one implementation and one set of mutations;
  // this overlay is a second door onto it, not a second version of it.
  //
  // The `projectId` guard is belt-and-braces: the row is filtered out of the
  // rail whenever there is no project, so this branch is unreachable without
  // one. It is here so the pane degrades to its own label rather than
  // rendering `GeneralTab` with an empty id if that gate is ever loosened.
  if (item.tab === 'workspace' && projectId) {
    return <GeneralTab projectId={projectId} />;
  }
  if (item.tab === 'profile') {
    return <ProfileTab />;
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

  // Unreachable while every `SettingsTab` member has a branch above, and kept
  // for the next one: a tab added to the union with no branch renders its own
  // name rather than an empty pane.
  return (
    <div className="p-6">
      <SettingsSectionHeader title={item.label} />
    </div>
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
