'use client';

/**
 * The merged settings overlay shell — ported from
 * `customize/customize-panel.tsx` onto one vertical `Tabs` root instead of a
 * hand-rolled rail-button/section switch. Every comment below that isn't
 * about the Tabs wiring itself is carried forward from that file because it
 * documents a real bug that was fixed there; this is a port, not a rewrite.
 *
 * `customize-panel.tsx` stays live and mounted — this component is mounted
 * nowhere yet (see the settings-panel plan, Task 5 / 5b). Deleting the old
 * panel and flipping the mount is a later task.
 *
 * Tab-pane CONTENT is intentionally NOT wired here. Every pane below renders
 * a bare `SettingsSectionHeader` as a placeholder; `features/workspace/
 * settings/tabs/*.tsx` (one file per tab, added tab-by-tab in later tasks)
 * replaces each placeholder as it's built. Reusing the existing
 * `customize/sections/**` views directly here was considered and rejected:
 * `gateway-view.tsx` (`LlmManagementView`), `secrets-view.tsx`, and
 * `members-view.tsx` all read `useCustomizeStore` directly for their own
 * deep-link sub-state (which Providers/Members sub-tab to land on). Mounting
 * them under THIS panel would make them read the wrong store — the legacy
 * one, which this panel never opens.
 */

import { Button } from '@/components/ui/button';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import { Label } from '@/components/ui/label';
import { Modal, ModalClose, ModalContent, ModalTitle } from '@/components/ui/modal';
import { SettingsSectionHeader } from '@/components/ui/settings-section-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Close } from '@/features/icon/icons/close';
import { useReviewSessionSummary } from '@/features/review-center/hooks/use-review-session-summary';
import { detectManifestVersion } from '@/features/workspace/customize/migrate-to-v2/manifest-version';
import { RelatedProjectsSwitcher } from '@/features/workspace/customize/related-projects-switcher';
import { useIsMobile } from '@/hooks/utils';
import type { CustomizeSection } from '@/lib/customize-sections';
import { isLlmGatewayAvailable } from '@/lib/llm-gateway';
import { CUSTOMIZE_SECTION_GATE_ACTIONS, isCustomizeSectionVisible } from '@/lib/project-actions';
import { useProjectCans } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import { hasOpenFloatingLayer, hasOpenNestedDialog } from '@/lib/z-stack';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';
import { getProjectDetail, type KortixProject } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { ArrowLeftIcon as ArrowLeft } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import { UPGRADE_ITEM, isRailItemActive, railGroups } from './rail';
import { DEFAULT_SETTINGS_TAB, type SettingsTab } from './settings-tabs';
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

export function SettingsPanel({ projectId }: { projectId?: string }) {
  const open = useSettingsPanelStore((s) => s.open);
  const tab = useSettingsPanelStore((s) => s.tab);
  const setTab = useSettingsPanelStore((s) => s.setTab);
  const close = useSettingsPanelStore((s) => s.close);
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
    <SettingsPanelView
      open={open}
      tab={tab}
      onTabChange={setTab}
      onOpenChange={(next) => (next ? undefined : close())}
      isMobile={isMobile}
      project={project}
      groups={groups}
      allItems={allItems}
      upgradeAllowed={upgradeAllowed}
      upgradeAttention={upgradeAttention}
      reviewNeedsYou={reviewNeedsYou}
    />
  );
}

export interface SettingsPanelViewProps {
  open: boolean;
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  onOpenChange: (open: boolean) => void;
  isMobile: boolean;
  project: KortixProject | undefined;
  groups: readonly RailGroup[];
  allItems: readonly RailItem[];
  upgradeAllowed: boolean;
  upgradeAttention: boolean;
  reviewNeedsYou: number;
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
  groups,
  allItems,
  upgradeAllowed,
  upgradeAttention,
  reviewNeedsYou,
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
          groups={groups}
          allItems={allItems}
          upgradeAllowed={upgradeAllowed}
          upgradeAttention={upgradeAttention}
          reviewNeedsYou={reviewNeedsYou}
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
  groups,
  allItems,
  upgradeAllowed,
  upgradeAttention,
  reviewNeedsYou,
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
              <div className="p-6">
                <SettingsSectionHeader title={item.label} />
              </div>
            </TabsContent>
          ))}
        </main>
      </Tabs>
    </>
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
