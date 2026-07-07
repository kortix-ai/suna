'use client';

import { ScheduleView } from '@/components/projects/schedule-view';
import { Button } from '@/components/ui/button';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import { Label } from '@/components/ui/label';
import { Modal, ModalClose, ModalContent, ModalTitle } from '@/components/ui/modal';
import { Icon } from '@/features/icon/icon';
import { MarketplaceView } from '@/features/marketplace/marketplace-view';
import { ConnectorsView } from '@/features/workspace/customize/sections/connectors-view';
import { AgentsView } from '@/features/workspace/customize/sections/view/agents-view';
import { ChannelsView } from '@/features/workspace/customize/sections/view/channels-view';
import { CommandsView } from '@/features/workspace/customize/sections/view/commands-view';
import { ComputersView } from '@/features/workspace/customize/sections/view/computers-view';
import { MeetView } from '@/features/workspace/customize/sections/view/meet-view';
import { MembersView } from '@/features/workspace/customize/sections/view/members-view';
import { SandboxView } from '@/features/workspace/customize/sections/view/sandbox-view';
import { SecretsView } from '@/features/workspace/customize/sections/view/secrets-view';
import { SettingsView } from '@/features/workspace/customize/sections/view/settings-view';
import { SkillsView } from '@/features/workspace/customize/sections/view/skills-view';
import { useIsMobile } from '@/hooks/utils';
import { type CustomizeSection, DEFAULT_CUSTOMIZE_SECTION } from '@/lib/customize-sections';
import { isLlmGatewayAvailable, isLlmGatewayEnabled } from '@/lib/llm-gateway';
import { CUSTOMIZE_SECTION_GATE_ACTIONS, isCustomizeSectionVisible } from '@/lib/project-actions';
import { useProjectCans } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import { hasOpenFloatingLayer, hasOpenNestedDialog } from '@/lib/z-stack';
import { useCustomizeStore } from '@/stores/customize-store';
import { getProjectDetail, listReviewItems } from '@kortix/sdk/projects-client';
import { AlarmClock, ArrowLeft, ChatMessages, Command, Sparkles } from '@mynaui/icons-react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowUpCircle,
  AudioLines,
  Bot,
  Boxes,
  Container,
  History,
  Inbox,
  KeyRound,
  Monitor,
  Plug,
  Store,
  Terminal,
  Webhook,
} from 'lucide-react';
import { useCallback, useEffect, useMemo } from 'react';
import { LuSettings, LuUsersRound } from 'react-icons/lu';
import { detectManifestVersion } from './migrate-to-v2/manifest-version';
import { UpgradesView } from './migrate-to-v2/upgrade-view';
import { isRailItemActive } from './rail';
import { LlmManagementView } from './sections/gateway-view';
import { ChangesView } from './sections/view/changes-view';
import { DevView } from './sections/view/dev-view';
import { ReviewView } from './sections/view/review-view';
import type { RailGroup, RailItem } from './type';

const GROUPS: readonly RailGroup[] = [
  {
    label: 'Build',
    items: [
      { section: 'agents', label: 'Agents', icon: Bot },
      { section: 'skills', label: 'Skills', icon: Sparkles },
      { section: 'commands', label: 'Commands', icon: Command },
    ],
  },
  {
    label: 'Connect',
    items: [
      { section: 'connectors', label: 'Connectors', icon: Plug },
      { section: 'secrets', label: 'Environment variables', icon: KeyRound },
      { section: 'channels', label: 'Channels', icon: ChatMessages },
    ],
  },
  {
    label: 'Automate',
    items: [
      { section: 'schedules', label: 'Schedules', icon: AlarmClock },
      { section: 'webhooks', label: 'Webhooks', icon: Webhook },
    ],
  },
  {
    label: 'Workspace',
    items: [
      { section: 'changes', label: 'Changes', icon: History },
      { section: 'sandbox', label: 'Sandbox', icon: Container },
      { section: 'dev', label: 'Dev', icon: Terminal },
    ],
  },
  {
    label: 'Manage',
    items: [
      { section: 'members', label: 'Members', icon: LuUsersRound },
      { section: 'settings', label: 'Settings', icon: LuSettings },
    ],
  },
];

const LLM_ITEM: RailItem = { section: 'llm-management', label: 'LLM', icon: Boxes };

const COMPUTERS_ITEM: RailItem = { section: 'computers', label: 'Computers', icon: Monitor };

const MARKETPLACE_ITEM: RailItem = { section: 'marketplace', label: 'Marketplace', icon: Store };

const MEET_ITEM: RailItem = { section: 'meet', label: 'Meetings', icon: AudioLines };

const REVIEW_ITEM: RailItem = { section: 'review', label: 'Review', icon: Inbox };

// The Upgrades section is always reachable (it hosts the one-off prompt runner)
// and lives pinned at the very bottom of the rail — out of the scrolling nav (see
// the desktop footer / mobile tail below). When a registry upgrade is actually
// applicable (e.g. the project is still on a v1 manifest) it carries a small
// attention dot instead of claiming a more prominent slot.
const UPGRADE_ITEM: RailItem = { section: 'upgrade', label: 'Upgrades', icon: ArrowUpCircle };

function railGroups(
  tunnelEnabled: boolean,
  marketplaceEnabled: boolean,
  llmGatewayAvailable: boolean,
  meetEnabled: boolean,
  reviewEnabled: boolean,
): readonly RailGroup[] {
  return GROUPS.map((g) => {
    if (g.label === 'Build' && marketplaceEnabled) {
      return { ...g, items: [...g.items, MARKETPLACE_ITEM] };
    }
    if (g.label === 'Connect') {
      const items = [...g.items];
      if (meetEnabled) items.push(MEET_ITEM);
      if (tunnelEnabled) items.push(COMPUTERS_ITEM);
      if (llmGatewayAvailable) items.push(LLM_ITEM);
      return { ...g, items };
    }
    if (g.label === 'Workspace' && reviewEnabled) {
      // Slot Review right after Changes — both are review surfaces.
      const items = [...g.items];
      const at = items.findIndex((it) => it.section === 'changes');
      items.splice(at >= 0 ? at + 1 : items.length, 0, REVIEW_ITEM);
      return { ...g, items };
    }
    return g;
  });
}

export function CustomizPanel({ projectId }: { projectId: string }) {
  const open = useCustomizeStore((s) => s.open);
  const section = useCustomizeStore((s) => s.section);
  const setSection = useCustomizeStore((s) => s.setSection);
  const close = useCustomizeStore((s) => s.close);
  const isMobile = useIsMobile();

  const detail = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const projectName = detail.data?.project?.name ?? '';

  // IAM visibility gating. One batched probe over every section's read leaf — a
  // custom role that OMITS a leaf (e.g. project.gitops.read) makes that section
  // disappear from the rail and blocks its content. NOT a security boundary (the
  // API re-checks every mutation); this only decides what to show. Feed the
  // accountId we ALREADY hold from the project-detail query so the probe runs on
  // first render rather than being disabled while a separate getProject resolves.
  const caps = useProjectCans(projectId, CUSTOMIZE_SECTION_GATE_ACTIONS, {
    accountId: detail.data?.project?.account_id,
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
  // A section is permitted when its GATE leaf resolved to allowed:true. Every
  // customize section gates on WRITE (editor+) — a plain `member` sees none of
  // them (Files lives on its own /projects/[id]/files page, not in here). Until
  // the probe resolves (or if it errored) we permit everything (optimistic).
  const isSectionAllowed = useCallback(
    (s: CustomizeSection) => {
      if (!capsResolved) return true;
      return isCustomizeSectionVisible(s, (action) => caps[action]?.allowed === true);
    },
    [caps, capsResolved],
  );

  const tunnelEnabled = detail.data?.project?.experimental?.agent_tunnel ?? false;
  const marketplaceEnabled = detail.data?.project?.experimental?.marketplace ?? false;
  const llmGatewayEnabled = isLlmGatewayEnabled(detail.data?.project);
  const llmGatewayAvailable = isLlmGatewayAvailable(detail.data?.project);
  const meetEnabled = detail.data?.project?.experimental?.meet ?? false;
  const reviewEnabled = detail.data?.project?.experimental?.review_center ?? false;
  // Pin Upgrades to the top only once the manifest read resolved to v1 —
  // while the detail query is in flight (or on v2 projects) the item sits in
  // its calm Manage slot instead. Same detection the section rows use.
  const upgradeAttention = detail.data
    ? detectManifestVersion(detail.data.config.manifest_raw) === 1
    : false;

  // "Needs you" count for the Review rail badge. Shares the review inbox's query
  // key so the badge and the section stay in sync; only fetched when the panel is
  // open and the flag is on.
  const reviewItemsQuery = useQuery({
    queryKey: ['review-center', projectId, 'list'],
    queryFn: () => listReviewItems(projectId),
    enabled: open && reviewEnabled && !!projectId,
    staleTime: 5_000,
    refetchInterval: open && reviewEnabled ? 15_000 : false,
  });
  const reviewNeedsYou = (reviewItemsQuery.data?.review_items ?? []).filter(
    (i) => i.status === 'needs_you',
  ).length;

  const groups = useMemo(
    // Compose flag-gating with IAM visibility: an item shows only if it passes
    // BOTH its flag check (baked into railGroups) AND its read-leaf probe. Empty
    // groups drop out so no orphan header renders.
    () =>
      railGroups(tunnelEnabled, marketplaceEnabled, llmGatewayAvailable, meetEnabled, reviewEnabled)
        .map((g) => ({ ...g, items: g.items.filter((item) => isSectionAllowed(item.section)) }))
        .filter((g) => g.items.length > 0),
    [
      tunnelEnabled,
      marketplaceEnabled,
      llmGatewayAvailable,
      meetEnabled,
      reviewEnabled,
      isSectionAllowed,
    ],
  );
  // Upgrades lives in its own pinned footer, but stays in the item universe so
  // deep-links, the mobile tail, and the active-section fallback all still see it.
  const upgradeAllowed = isSectionAllowed('upgrade');
  const allItems = useMemo(
    () => [...groups.flatMap((g) => g.items), ...(upgradeAllowed ? [UPGRADE_ITEM] : [])],
    [groups, upgradeAllowed],
  );
  // `llm-management` stands in for every `llm-*` sub-section so deep-links still work.
  const sectionVisible = allItems.some((item) => isRailItemActive(item, section));

  useEffect(() => {
    if (open && !sectionVisible) {
      setSection(DEFAULT_CUSTOMIZE_SECTION);
    }
  }, [open, sectionVisible, setSection]);

  // If the active section is denied once the probe resolves (e.g. a bookmarked
  // deep-link into a section this role no longer grants), fall back to the first
  // permitted section. Only after the probe RESOLVES — never during the
  // loading/optimistic window, or we'd clobber a valid deep-link.
  const activeAllowed = isSectionAllowed(section);
  useEffect(() => {
    if (!open || !capsResolved || activeAllowed) return;
    const fallback = allItems[0]?.section ?? DEFAULT_CUSTOMIZE_SECTION;
    if (fallback !== section) setSection(fallback);
  }, [open, capsResolved, activeAllowed, allItems, section, setSection]);

  return (
    <Modal open={open} onOpenChange={(next) => (next ? undefined : close())}>
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
          'inset-0 top-0 left-0 h-dvh min-h-dvh w-screen max-w-none translate-x-0 translate-y-0 space-y-0 rounded-none border-0 shadow-none sm:max-w-none sm:rounded-none lg:top-0 lg:left-0 lg:h-dvh lg:min-h-dvh lg:max-w-none lg:translate-x-0 lg:translate-y-0',
        )}
      >
        <ModalTitle className="sr-only">Customize {projectName || 'project'}</ModalTitle>

        <div
          className={cn(
            'min-h-0 flex-1',
            isMobile ? 'flex flex-col' : 'grid grid-cols-[250px_1fr]',
          )}
        >
          {isMobile ? (
            <nav
              aria-label="Customize"
              className="border-border/60 bg-background flex h-auto shrink-0 items-center border-b"
            >
              <FadedScrollArea
                orientation="horizontal"
                fadeColor="from-background"
                className="min-w-0 flex-1 py-2"
              >
                <ul className="flex items-center gap-1 px-2">
                  {allItems.map((item) => (
                    <li key={item.section} className="shrink-0">
                      <RailButton
                        item={item}
                        active={isRailItemActive(item, section)}
                        onClick={() => setSection(item.section)}
                        orientation="horizontal"
                        count={item.section === 'review' ? reviewNeedsYou : undefined}
                        attention={item.section === 'upgrade' && upgradeAttention}
                      />
                    </li>
                  ))}
                </ul>
              </FadedScrollArea>
              <div className="flex shrink-0 items-center px-4">
                <ModalClose asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground shrink-0"
                    aria-label="Close"
                  >
                    <Icon.Close className="text-foreground size-4 stroke-1" />
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

              <nav
                aria-label="Customize"
                className="mt-8 min-h-0 flex-1 [scrollbar-width:none] overflow-y-auto px-2.5 py-3 [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
              >
                {groups.map((group, idx) => (
                  <div
                    key={group.label ?? idx}
                    className={cn('space-y-1', idx > 0 ? 'mt-4' : undefined)}
                  >
                    {group.label && (
                      <Label className="text-muted-foreground px-2 pb-1">{group.label}</Label>
                    )}
                    <ul className="space-y-0.5">
                      {group.items.map((item) => (
                        <li key={item.section}>
                          <RailButton
                            item={item}
                            active={isRailItemActive(item, section)}
                            onClick={() => setSection(item.section)}
                            count={item.section === 'review' ? reviewNeedsYou : undefined}
                          />
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </nav>

              {/* Upgrades pinned to the extreme bottom of the rail, below the
                  scrolling nav. Carries an attention dot on a v1 manifest. */}
              {upgradeAllowed && (
                <div className="mt-2 shrink-0 px-2.5 pt-3">
                  <RailButton
                    item={UPGRADE_ITEM}
                    active={isRailItemActive(UPGRADE_ITEM, section)}
                    onClick={() => setSection('upgrade')}
                    attention={upgradeAttention}
                  />
                </div>
              )}
            </section>
          )}

          <main className="bg-background flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {open && sectionVisible && (
              <div className="flex min-h-0 flex-1 flex-col">
                <SectionContent
                  section={section}
                  projectId={projectId}
                  llmGatewayEnabled={llmGatewayEnabled}
                />
              </div>
            )}
          </main>
        </div>
      </ModalContent>
    </Modal>
  );
}

function RailButton({
  item,
  active,
  onClick,
  orientation = 'vertical',
  count,
  attention,
}: {
  item: RailItem;
  active: boolean;
  onClick: () => void;
  orientation?: 'vertical' | 'horizontal';
  /** Optional attention count shown as a pill (e.g. review items needing you). */
  count?: number;
  /** A quiet dot for a pending nudge with no count (e.g. an available upgrade). */
  attention?: boolean;
}) {
  const Icon = item.icon;
  const horizontal = orientation === 'horizontal';
  const showCount = count != null && count > 0;
  return (
    <Button
      type="button"
      variant={active ? 'accent' : 'ghost'}
      size="sm"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'gap-2.5 text-left',
        horizontal ? 'w-auto shrink-0 px-3 whitespace-nowrap' : 'w-full justify-start',
      )}
    >
      {Icon && <Icon className="size-4 shrink-0" />}
      <span className={cn(!horizontal && 'truncate')}>{item.label}</span>
      {showCount ? (
        <span
          className={cn(
            'shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums',
            !horizontal && 'ml-auto',
            active ? 'bg-primary-foreground/15' : 'bg-kortix-base/15 text-kortix-base',
          )}
        >
          {count}
        </span>
      ) : attention ? (
        <span
          aria-hidden
          className={cn(
            'bg-kortix-orange size-1.5 shrink-0 rounded-full',
            !horizontal && 'ml-auto',
          )}
        />
      ) : null}
    </Button>
  );
}

function SectionContent({
  section,
  projectId,
  llmGatewayEnabled,
}: {
  section: CustomizeSection;
  projectId: string;
  llmGatewayEnabled: boolean;
}) {
  if (section.startsWith('llm-') && !llmGatewayEnabled) {
    return null;
  }

  if (section.startsWith('llm-')) {
    return <LlmManagementView projectId={projectId} />;
  }

  switch (section) {
    case 'agents':
      return <AgentsView projectId={projectId} />;
    case 'skills':
      return <SkillsView projectId={projectId} />;
    case 'commands':
      return <CommandsView projectId={projectId} />;
    case 'marketplace':
      return <MarketplaceView projectId={projectId} />;
    case 'connectors':
      return <ConnectorsView projectId={projectId} />;
    case 'secrets':
      return <SecretsView projectId={projectId} />;
    case 'channels':
      return <ChannelsView projectId={projectId} />;
    case 'meet':
      return <MeetView projectId={projectId} />;
    case 'computers':
      return <ComputersView projectId={projectId} />;
    case 'schedules':
      return <ScheduleView projectId={projectId} type="cron" />;
    case 'webhooks':
      return <ScheduleView projectId={projectId} type="webhook" />;
    case 'changes':
      return <ChangesView projectId={projectId} />;
    case 'review':
      return <ReviewView projectId={projectId} />;
    case 'sandbox':
      return <SandboxView projectId={projectId} />;
    case 'dev':
      return <DevView projectId={projectId} />;
    case 'members':
      return <MembersView projectId={projectId} />;
    case 'settings':
      return <SettingsView projectId={projectId} />;
    case 'upgrade':
      return <UpgradesView projectId={projectId} />;
    default:
      return null;
  }
}
