'use client';

/**
 * The merged settings overlay shell — ported from the legacy Customize
 * overlay's panel onto one vertical `Tabs` root instead of a hand-rolled
 * rail-button/section switch. Every comment below that isn't about the Tabs
 * wiring itself is carried forward from that file because it documents a
 * real bug that was fixed there; this is a port, not a rewrite.
 *
 * **Task 5b — the cutover.** The legacy Customize panel is deleted;
 * `ProjectShell` now mounts THIS panel instead (see
 * `project-layout/project-shell.tsx`). Every literal `openCustomize(...)`
 * call site was repointed to `openSettings(...)` against
 * `stores/settings-panel-store.ts`, and every `/customize/*` route now
 * redirects to its `/settings/*` equivalent via `legacySectionRedirect` —
 * see that task's report for the full file list.
 *
 * Tab-pane CONTENT is intentionally NOT wired here. Every pane below renders
 * a bare `SettingsSectionHeader` as a placeholder; `features/workspace/
 * settings/tabs/*.tsx` (one file per tab, added tab-by-tab in later tasks)
 * replaces each placeholder as it's built. Reusing the existing
 * `customize/sections/**` views directly here was originally blocked:
 * `gateway-view.tsx` (`LlmManagementView`), `connectors-view.tsx`,
 * `members-view.tsx`, `secrets-view.tsx`, and `marketplace-section-
 * button.tsx` all read the legacy Customize store directly for panel
 * navigation (which tab is active, whether the panel is open, how to jump
 * elsewhere). Mounting them under THIS panel would have made them read the
 * wrong store — the legacy one, which this panel never opened.
 *
 * That blocker is gone: all five now read `useSettingsNav()` (see
 * `features/workspace/shared/settings-nav-context.tsx`) instead of a store
 * directly, and THIS panel already provides it below (`buildSettingsPanel-
 * SettingsNav` / `<SettingsNavProvider>`).
 *
 * **Task 5b2 update.** Fifteen of the legacy panel's `SectionContent`
 * cases (fourteen `case` labels plus the `llm-*` prefix branch) are now
 * wired onto their mapped tab via `SettingsTabPane` below: `commands`,
 * `marketplace`, `secrets`, `channels`, `voice`, `computers`, `schedules`,
 * `webhooks`, `git`, `review`, `sandbox`, `members`, `settings`, `upgrade`,
 * and `llm-*` become `instructions`, `marketplace`, `secrets`, `channels`,
 * `voice`, `computers`, `schedules`, `webhooks`, `repositories`, `review`,
 * `sandbox`, `members`, `general`, `upgrades`, and `models`. `sandbox` here
 * still renders the UNSPLIT `SandboxView` (templates + build log together);
 * splitting off `snapshots` (build log only) is a later task, so `snapshots`
 * stays a placeholder.
 *
 * **Task 7 update.** `profile` is wired to the real `ProfileTab` (see
 * `tabs/profile-tab.tsx`) — the first of the ten still-new, account-scoped
 * surfaces to get real content. It renders with no `projectId` dependency
 * (see `SettingsTabPane` below), unlike every project-scoped case above it.
 *
 * **Task 8 update.** `preferences` is wired to the real `PreferencesTab`
 * (see `tabs/preferences-tab.tsx`) — same account-scoped, no-`projectId`
 * shape as `profile`.
 *
 * **Task 9 update.** `connected` is wired to the real `ConnectedAccountsTab`
 * (see `tabs/connected-tab.tsx`) — same account-scoped, no-`projectId`-
 * required shape as `profile`/`preferences` above, but it ALSO reads
 * `project?.account_id` (threaded down as `accountId`, computed here from the
 * same project-detail query the IAM caps probe already uses) because one of
 * its three rows (GitHub) is account-scoped, not project- or user-scoped —
 * see that file's header comment.
 *
 * **Task 11 update.** `billing` is wired to the real `BillingTab` (see
 * `tabs/billing-tab.tsx`) — same account-scoped shape as `connected` (reads
 * `accountId`, no `projectId` required). It renders nothing at all without
 * `billing.write` on the resolved account AND `isBillingEnabled()` — see
 * that file's header comment.
 *
 * **Task 12 update.** `usage` is wired to the real `UsageTab` (see
 * `tabs/usage-tab.tsx`) — same account-scoped shape as `billing`/`connected`.
 * It renders nothing without `account.write` on the resolved account, but —
 * unlike `billing` — does NOT also require `isBillingEnabled()`: session
 * costs stay available with billing off, matching `sectionVisible.
 * transactions` on the source page.
 *
 * **Task 13 update.** `groups` is wired to the real `GroupsTab` (see
 * `tabs/groups-tab.tsx`) and `roles` to the real `RolesTab` (see
 * `tabs/roles-tab.tsx`) — same account-scoped shape as `billing`/`usage`.
 * The two gate differently, matching `app/(app)/accounts/[id]/page.tsx`
 * exactly (see each file's header comment): Groups has no permission gate
 * at all (every member reaches the pane; only its CONTENT is
 * entitlement-gated, showing `EnterpriseUpsell` in place of the real view
 * on a non-`rbac` account); Roles additionally requires `role.create` as a
 * whole-tab gate on top of that same entitlement content-gate. The
 * remaining four (`identity`, `audit`, `api-keys`, `experimental`, plus
 * `snapshots` from Task 5b2) stay placeholders — later phases build them.
 *
 * **Every pane must not fetch unless its tab is active** (see this file's
 * plan and `settings-panel.test.tsx`'s "real tab content gating" describe
 * block for the proof): `SettingsTabPane` renders `null` for every tab that
 * isn't the active one, so an inactive tab's real view is never even
 * instantiated as a React element — its hooks never run, so it can't fetch.
 * This is deliberate defense-in-depth: Radix's own `TabsContent` already
 * excludes an inactive pane's children from what it hands its wrapper div
 * (`present && children` in `@radix-ui/react-tabs`'s `TabsContent`, verified
 * directly against this repo's installed version — an inactive pane's
 * `<div role="tabpanel" hidden>` renders with NO children at all, not just
 * CSS-hidden ones), but gating explicitly in OUR OWN code means correctness
 * here never depends on a third-party internal staying the way it happens to
 * work today.
 */

import { ScheduleView } from '@/components/projects/schedule-view';
import { Button } from '@/components/ui/button';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
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
import { LlmManagementView } from '@/features/workspace/customize/sections/gateway-view';
import { ChannelsView } from '@/features/workspace/customize/sections/view/channels-view';
import { CommandsView } from '@/features/workspace/customize/sections/view/commands-view';
import { ComputersView } from '@/features/workspace/customize/sections/view/computers-view';
import { GitView } from '@/features/workspace/customize/sections/view/git-view';
import { MembersView } from '@/features/workspace/customize/sections/view/members-view';
import { ReviewView } from '@/features/workspace/customize/sections/view/review-view';
import { SandboxView } from '@/features/workspace/customize/sections/view/sandbox-view';
import { SecretsView } from '@/features/workspace/customize/sections/view/secrets-view';
import { SettingsView } from '@/features/workspace/customize/sections/view/settings-view';
import { VoiceView } from '@/features/workspace/customize/sections/view/voice-view';
import { SettingsNavProvider, type SettingsNav } from '@/features/workspace/shared/settings-nav-context';
import { useIsMobile } from '@/hooks/utils';
import { isLlmGatewayAvailable, isLlmGatewayEnabled } from '@/lib/llm-gateway';
import {
  CUSTOMIZE_SECTION_GATE_ACTIONS,
  isCustomizeSectionVisible,
  type CustomizeSection,
} from '@/lib/project-actions';
import { useProjectCans } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import { hasOpenFloatingLayer, hasOpenNestedDialog } from '@/lib/z-stack';
import { useSettingsPanelStore, type MembersTab } from '@/stores/settings-panel-store';
import { getProjectDetail, type KortixProject } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { ArrowLeftIcon as ArrowLeft } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import { UPGRADE_ITEM, isRailItemActive, railGroups } from './rail';
import { DEFAULT_SETTINGS_TAB, type SettingsTab } from './settings-tabs';
import { BillingTab } from './tabs/billing-tab';
import { ConnectedAccountsTab } from './tabs/connected-tab';
import { GroupsTab } from './tabs/groups-tab';
import { PreferencesTab } from './tabs/preferences-tab';
import { ProfileTab } from './tabs/profile-tab';
import { RolesTab } from './tabs/roles-tab';
import { UsageTab } from './tabs/usage-tab';
import type { RailGroup, RailItem } from './type';

/**
 * Maps a `SettingsTab` to the legacy `CustomizeSection` whose IAM read leaf
 * (`lib/project-actions.ts`) already gates it — reused as-is rather than
 * duplicated, since the leaves themselves didn't change, only the tab ids
 * that front them. Tabs with no entry here (profile, preferences, connected,
 * snapshots, billing, usage, groups, roles, identity, audit, api-keys,
 * experimental) are user- or account-scoped and get their own entitlement
 * gating in the tasks that build their content; until then `isTabAllowed`
 * falls through to "allowed" for them below, same as the fail-open default.
 * This is deliberate for `roles` too (Task 13): its `role.create` whole-tab
 * gate lives INSIDE `RolesTab`'s container (`tabs/roles-tab.tsx`), which
 * returns `null` rather than hiding the rail row — the same choice already
 * made for `billing`'s `billing.write` gate and `usage`'s `account.write`
 * gate, neither of which hide their rail row either. See `tabs/roles-tab.tsx`'s
 * header comment for the full reasoning.
 */
const GATED_TAB_SECTION: Partial<Record<SettingsTab, CustomizeSection>> = {
  general: 'settings',
  members: 'members',
  secrets: 'secrets',
  channels: 'channels',
  repositories: 'git',
  schedules: 'schedules',
  webhooks: 'webhooks',
  models: 'llm-management',
  instructions: 'commands',
  sandbox: 'sandbox',
  marketplace: 'marketplace',
  review: 'review',
  voice: 'voice',
  computers: 'computers',
  upgrades: 'upgrade',
};

/**
 * Adapts `useSettingsPanelStore`'s state into the panel-agnostic
 * `SettingsNav` shape the five `customize/sections/**` views will read once
 * they're mounted here (Task 5b/later) — see `settings-nav-context.tsx`'s
 * header. Nothing under this panel consumes it yet: no tab-pane content is
 * wired up (see this file's top comment), so `<SettingsNavProvider>` below
 * currently has no `useSettingsNav()` descendants. It's wired up now so a
 * later task that mounts real content doesn't also have to remember to add
 * the provider.
 *
 * `llmProvidersTab` has no equivalent field on this store (Task 4's finding,
 * documented on `settings-panel-store.ts`), so it's always `undefined` here.
 * Exported for a pure unit test; no rendering required.
 */
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

  // IAM visibility gating. One batched probe over every gated tab's read leaf
  // — a custom role that OMITS a leaf (e.g. project.gitops.read) makes that
  // tab disappear from the rail and blocks its content. NOT a security
  // boundary (the API re-checks every mutation); this only decides what to
  // show. Feed the accountId we ALREADY hold from the project-detail query so
  // the probe runs on first render rather than being disabled while a
  // separate getProject resolves.
  const caps = useProjectCans(open ? projectId : undefined, CUSTOMIZE_SECTION_GATE_ACTIONS, {
    accountId: project?.account_id,
  });
  // Treat BOTH "loading" and "errored" as not-yet-resolved — this is a VISIBILITY
  // layer, not a security boundary, so we fail OPEN (render the full rail) rather
  // than blank the UI on a transient probe failure or while it's in flight.
  const capsResolved = useMemo(
    () =>
      CUSTOMIZE_SECTION_GATE_ACTIONS.every(
        (action) => caps[action] && !caps[action].isLoading && !caps[action].isError,
      ),
    [caps],
  );
  // A tab is permitted when its READ leaf resolved to allowed:true — a role
  // that can read a tab SEES it (read-only unless it also holds the write
  // leaf; edit controls inside each pane gate on can_manage separately). A
  // role that omits a read leaf hides just that one tab. Until the probe
  // resolves (or if it errored) we permit everything (optimistic) —
  // visibility, not security. Tabs with no gated leaf yet (see
  // GATED_TAB_SECTION) are always permitted.
  const isTabAllowed = useCallback(
    (t: SettingsTab) => {
      if (!capsResolved) return true;
      const section = GATED_TAB_SECTION[t];
      if (!section) return true;
      return isCustomizeSectionVisible(section, (action) => caps[action]?.allowed === true);
    },
    [caps, capsResolved],
  );

  const tunnelEnabled = project?.experimental?.agent_tunnel ?? false;
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
    // Compose flag-gating with IAM visibility: an item shows only if it passes
    // BOTH its flag check (baked into railGroups) AND its read-leaf probe. Empty
    // groups drop out so no orphan header renders.
    () =>
      railGroups({
        tunnelEnabled,
        marketplaceEnabled,
        llmGatewayAvailable,
        voiceEnabled,
        reviewEnabled,
      })
        .map((g) => ({ ...g, items: g.items.filter((item) => isTabAllowed(item.tab)) }))
        .filter((g) => g.items.length > 0),
    [tunnelEnabled, marketplaceEnabled, llmGatewayAvailable, voiceEnabled, reviewEnabled, isTabAllowed],
  );
  // Upgrades lives in its own pinned footer, but stays in the item universe so
  // deep-links, the mobile tail, and the active-tab fallback all still see it.
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

  // If the active tab is denied once the probe resolves (e.g. a bookmarked
  // deep-link into a tab this role no longer grants), fall back to the first
  // permitted tab. Only after the probe RESOLVES — never during the
  // loading/optimistic window, or we'd clobber a valid deep-link.
  const activeAllowed = isTabAllowed(tab);
  useEffect(() => {
    if (!open || !capsResolved || activeAllowed) return;
    const fallback = allItems[0]?.tab ?? DEFAULT_SETTINGS_TAB;
    if (fallback !== tab) setTab(fallback);
  }, [open, capsResolved, activeAllowed, allItems, tab, setTab]);

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
  /** Threaded independently of `project` (the detail query's RESULT) so a
   *  tab's real view gets a stable id from the first render — it doesn't need
   *  to wait on `project` to resolve, since every real view does its own
   *  loading/skeleton handling once mounted. */
  projectId: string | undefined;
  /** The project's owning account — threaded the same way as `projectId`
   *  (independently of `project` resolving) for the one tab that needs it:
   *  `connected`'s GitHub row is account-scoped, not project-scoped (see
   *  `tabs/connected-tab.tsx`). */
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

/** Presentational only — no hooks, no data fetching, no store read. Kept
 *  separate from `SettingsPanel` so the shell renders under
 *  `renderToStaticMarkup` without a `QueryClientProvider`, router, or mounted
 *  Zustand store — see `MigrateToV2ButtonView` for the same split.
 *
 *  NOT itself renderable via `renderToStaticMarkup`: `ModalContent` renders
 *  through `DialogPrimitive.Portal`, which gates on a `mounted` state flipped
 *  by `useLayoutEffect` — that effect never runs during static rendering, so
 *  the portal (and everything inside it) always renders as nothing,
 *  independent of `open`. `SettingsPanelShell` below holds everything BELOW
 *  the portal boundary and is what the test file actually exercises. */
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
        <ModalTitle className="sr-only">{project ? `Settings — ${project.name}` : 'Settings'}</ModalTitle>

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

export type SettingsPanelShellProps = Omit<
  SettingsPanelViewProps,
  'open' | 'onOpenChange'
>;

/** Everything the modal shows once it's open, MINUS the modal chrome itself
 *  (`Modal` / `ModalContent` / the portal). Split out purely so this can
 *  render under `renderToStaticMarkup` — see the note on `SettingsPanelView`
 *  above for why the portal boundary has to sit above this component, not
 *  inside it. */
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
  return (
    <>
      {/* Desktop shell: this modal is `inset-0`, so its first row starts at
          the window's top-left — under the macOS traffic lights, and under
          the Win/Linux control cluster. The rail's "Back to workspace"
          button landed straight on the lights.

          A `.kx-titlebar-spacer` (display:none on the web, band-height and
          draggable on desktop) drops the WHOLE modal below the band, which
          covers the narrow-window variant too — the old guard was a
          left-only `.kx-customize-header` indent that only ever fixed the
          wide layout, and whose class stopped being rendered when this
          became a two-column grid. */}
      <div className="kx-titlebar-spacer shrink-0" />

      <Tabs
        value={tab}
        onValueChange={(next) => onTabChange(next as SettingsTab)}
        orientation="vertical"
        className={cn('min-h-0 flex-1 gap-0', isMobile ? 'flex flex-col' : 'grid grid-cols-[250px_1fr]')}
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
                  className="text-muted-foreground shrink-0"
                  aria-label="Close"
                >
                  <Close className="text-foreground size-4 stroke-1" />
                </Button>
              </ModalClose>
            </div>
          </nav>
        ) : (
          <section className="bg-sidebar flex min-h-0 flex-col border-r py-4">
            <div className="w-full shrink-0 px-2.5">
              <ModalClose asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground flex w-full items-center justify-start gap-2 px-4 py-2 text-left text-sm font-medium"
                >
                  <ArrowLeft />
                  Back to workspace
                </Button>
              </ModalClose>
            </div>

            {project ? <RelatedProjectsSwitcher project={project} /> : null}

            <nav
              aria-label="Settings"
              className="mt-4 min-h-0 flex-1 [scrollbar-width:none] overflow-y-auto px-2.5 py-3 [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
            >
              {groups.map((group, idx) => (
                <div key={group.label} className={cn('space-y-1', idx > 0 ? 'mt-4' : undefined)}>
                  <Label className="text-muted-foreground px-2 pb-1">{group.label}</Label>
                  {/* Radix's `TabsList` can only contain trigger children —
                      the group `Label` above can't live inside it, so each
                      group gets its OWN list rather than one list for the
                      whole rail. Trade-off: arrow-key roving moves within a
                      group, not across the whole rail (see the task report). */}
                  <TabsList orientation="vertical">
                    {group.items.map((item) => (
                      <TabsTrigger key={item.tab} value={item.tab} className="gap-2.5">
                        <RailTriggerBody
                          item={item}
                          count={item.tab === 'review' ? reviewNeedsYou : undefined}
                        />
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </div>
              ))}
            </nav>

            {/* Upgrades pinned to the extreme bottom of the rail, below the
                scrolling nav. Carries an attention dot on a v1 manifest. Its
                own single-item TabsList for the same Radix reason as above. */}
            {upgradeAllowed && (
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
              className="flex min-h-0 flex-1 flex-col overflow-y-auto"
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

/**
 * Real view for one tab, gated on `active` so its hooks (and any fetch they
 * start) only ever run for the tab currently selected — see this file's
 * header comment and `settings-panel.test.tsx`'s "real tab content gating"
 * describe block for why this is explicit rather than left to Radix's own
 * `TabsContent` behaviour.
 *
 * `profile`, `preferences`, `connected` (Task 9), `billing` (Task 11),
 * `usage` (Task 12), and `groups`/`roles` (Task 13) are handled above the
 * switch (account-scoped, no `projectId` needed). The switch below is the
 * Task 5b2 mapping of the legacy panel's `SectionContent` (14 `case` labels
 * + the `llm-*` prefix branch) onto the new tab ids. A tab NOT listed here
 * or above — `snapshots`, `identity`, `audit`, `api-keys`, `experimental` —
 * is a genuinely new surface with no legacy source to port; it keeps the
 * placeholder header until a later phase builds it. `snapshots` in
 * particular is HALF of the legacy `sandbox` case
 * (`SandboxView` renders templates and the build log together); splitting
 * them is a later task, so `sandbox` alone gets the full unsplit view for
 * now and `snapshots` stays a placeholder — do not fold `SandboxView` onto
 * both tabs, that would render the build log twice.
 */
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

  // Account-scoped — renders with no dependency on the current project, so
  // it works even while no project is selected (unlike every case below).
  if (item.tab === 'profile') {
    return <ProfileTab />;
  }
  if (item.tab === 'preferences') {
    return <PreferencesTab />;
  }
  // Same no-`projectId`-required shape as `profile`/`preferences`, but it
  // ALSO reads `accountId` — its GitHub row is account-scoped, not
  // project-scoped (see `tabs/connected-tab.tsx`'s header comment).
  if (item.tab === 'connected') {
    return <ConnectedAccountsTab projectId={projectId} accountId={accountId} />;
  }
  // Same no-`projectId`-required, `accountId`-reading shape as `connected`
  // above — see `tabs/billing-tab.tsx`'s header comment. Renders nothing at
  // all without `billing.write` on the resolved account and
  // `isBillingEnabled()`.
  if (item.tab === 'billing') {
    return <BillingTab accountId={accountId} />;
  }
  // Same no-`projectId`-required, `accountId`-reading shape as `billing`
  // above — see `tabs/usage-tab.tsx`'s header comment. Renders nothing at
  // all without `account.write` on the resolved account; unlike `billing`,
  // does NOT also require `isBillingEnabled()`.
  if (item.tab === 'usage') {
    return <UsageTab accountId={accountId} />;
  }
  // Same no-`projectId`-required, `accountId`-reading shape as `billing`/
  // `usage` above — see `tabs/groups-tab.tsx`'s header comment. Groups has
  // no whole-tab permission gate (every member reaches the pane); only its
  // CONTENT is entitlement-gated.
  if (item.tab === 'groups') {
    return <GroupsTab accountId={accountId} />;
  }
  // Same shape as `groups` above, but ALSO renders nothing at all without
  // `role.create` on the resolved account — see `tabs/roles-tab.tsx`'s
  // header comment for why that whole-tab gate lives in the container
  // rather than here.
  if (item.tab === 'roles') {
    return <RolesTab accountId={accountId} />;
  }

  if (projectId) {
    switch (item.tab) {
      case 'general':
        return <SettingsView projectId={projectId} />;
      case 'members':
        return <MembersView projectId={projectId} />;
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
      case 'computers':
        return <ComputersView projectId={projectId} />;
      case 'models':
        // Mirrors the legacy panel's
        // `if (section.startsWith('llm-') && !llmGatewayEnabled) return null;`
        // — renders nothing (not the placeholder) while disabled.
        return llmGatewayEnabled ? <LlmManagementView projectId={projectId} /> : null;
      case 'instructions':
        return <CommandsView projectId={projectId} />;
      case 'marketplace':
        return <MarketplaceView projectId={projectId} />;
      case 'review':
        return <ReviewView projectId={projectId} />;
      case 'voice':
        return <VoiceView projectId={projectId} />;
      case 'sandbox':
        return <SandboxView projectId={projectId} />;
      case 'upgrades':
        return <UpgradesView projectId={projectId} />;
      default:
        break;
    }
  }

  // No project id (an account-scoped open with no workspace selected yet) or
  // a tab with no real view wired up yet — same placeholder either way.
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
  /** Optional attention count shown as a pill (e.g. review items needing you). */
  count?: number;
  /** A quiet dot for a pending nudge with no count (e.g. an available upgrade). */
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
        <span
          className={cn(
            'bg-kortix-base/15 text-kortix-base shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums',
            !horizontal && 'ml-auto',
          )}
        >
          {count}
        </span>
      ) : attention ? (
        <span
          aria-hidden
          className={cn('bg-kortix-orange size-1.5 shrink-0 rounded-full', !horizontal && 'ml-auto')}
        />
      ) : null}
    </>
  );
}
