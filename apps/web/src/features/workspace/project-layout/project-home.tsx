'use client';

import {
  BellIcon as Bell,
  RobotIcon as Bot,
  CalendarDotsIcon as CalendarClock,
  ShippingContainerIcon as Container,
  FileCodeIcon as FileCode,
  PackageIcon as Package,
  SidebarSimpleIcon as PanelLeft,
  SparkleIcon as SparklesSolid,
  UsersThreeIcon as UsersGroupSolid,
} from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type ComponentType, type ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Hint from '@/components/ui/hint';
import { useSidebar } from '@/components/ui/sidebar';
import { Kortix } from '@/features/icon/icons/kortix';
import { Slack } from '@/features/icon/icons/slack';
import { ComposerChatInput, type ComposerOptions } from '@/features/session/composer-chat-input';
import type { AttachedFile } from '@/features/session/session-chat-input';
import { SessionWelcome } from '@/features/session/session-welcome';
import {
  CAPABILITY_TABS,
  capabilityTabHref,
  channelsHref,
  type CapabilityTab,
} from '@/features/workspace/capabilities/shared/capability-tab-routes';
import {
  sidebarOpenerLabel,
  useShowPageSidebarOpener,
} from '@/features/workspace/project-layout/sidebar-opener';
import {
  projectSettingsSectionHref,
  type ProjectSettingsSectionKey,
} from '@/features/workspace/capabilities/project-settings/project-settings-sections';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { STARTER_PROMPTS } from '@/lib/starter-prompts';
import { useProjectCans } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import { useComposerPrefillStore } from '@/stores/composer-prefill-store';
import {
  type SandboxTemplate,
  listProjectAccessRequests,
  listProjectSandboxes,
} from '@kortix/sdk';
import { contract, qk, useProjectName, type Command } from '@kortix/sdk/react';
import { META_SANDBOX_SLUG, chalkColors, isMetaAgentName } from '@kortix/shared';
import { SquaresFourIcon as HiOutlineViewGrid } from '@phosphor-icons/react';

export interface ProjectHomeSendOptions extends ComposerOptions {
  sandbox_slug?: string;
}

export function ProjectHome({
  projectId,
  onSend,
  busy,
}: {
  projectId: string;
  onSend: (
    text: string,
    files: AttachedFile[] | undefined,
    options?: ProjectHomeSendOptions,
  ) => void;
  busy: boolean;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const { state: sidebarState, toggleSidebar, peek, peekEnter, peekLeave } = useSidebar();
  const sidebarToggleLabel = sidebarOpenerLabel({ state: sidebarState, peek });
  // Shared gate — see sidebar-opener.ts. This used to be a local
  // `isMobileViewport || state !== 'expanded'`, which is true on the desktop
  // shell too: the button below is `absolute top-2 left-2`, so on macOS it
  // rendered directly on top of the traffic lights, alongside the shell's own
  // opener at x=72. The shell owns that corner; this one stands down there.
  const showSidebarToggle = useShowPageSidebarOpener();

  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<{ text: string; id: number } | null>(null);

  // The sandbox TEMPLATE catalog, not live sandbox health (that is
  // `useSandboxHealth`, its own key and its own polling). Changed only by this
  // app's own mutations, which invalidate this key — see `FRESHNESS.sandboxes`.
  const sandboxesQuery = useQuery({
    queryKey: qk.project.sandboxes(projectId),
    queryFn: () => listProjectSandboxes(projectId),
    ...contract('config'),
    refetchOnWindowFocus: false,
  });
  const sandboxItems: SandboxTemplate[] = sandboxesQuery.data?.items ?? [];
  const defaultSlug = sandboxesQuery.data?.default_slug ?? 'default';
  const activeSlug = selectedSlug ?? defaultSlug;
  const metaSelected = isMetaAgentName(selectedAgent);

  useEffect(() => {
    if (metaSelected) setSelectedSlug(null);
  }, [metaSelected]);

  const showSandboxPicker = sandboxItems.length >= 1;
  const router = useRouter();
  const accessRequests = useQuery({
    queryKey: qk.project.accessRequests(projectId),
    queryFn: () => listProjectAccessRequests(projectId, { showErrors: false }),
    retry: false,
    ...contract('inventory'),
    refetchOnWindowFocus: false,
  });
  const pendingAccessCount = accessRequests.data?.requests.length ?? 0;

  const pendingPrefill = useComposerPrefillStore((s) => s.prefillByProject[projectId]);
  const consumePrefill = useComposerPrefillStore((s) => s.consume);

  useEffect(() => {
    if (!pendingPrefill) return;
    consumePrefill(projectId);
    setPrefill({ text: pendingPrefill, id: Date.now() });
  }, [pendingPrefill, projectId, consumePrefill]);

  const handleSend = useCallback(
    (text: string, files: AttachedFile[] | undefined, options: ComposerOptions) => {
      onSend(text, files, {
        ...options,
        ...(metaSelected
          ? { sandbox_slug: META_SANDBOX_SLUG }
          : selectedSlug
            ? { sandbox_slug: selectedSlug }
            : {}),
      });
    },
    [metaSelected, selectedSlug, onSend],
  );

  const handleCommand = useCallback(
    (cmd: Command, args: string | undefined, options: ComposerOptions) => {
      handleSend(`/${cmd.name}${args ? ` ${args}` : ''}`, undefined, options);
    },
    [handleSend],
  );

  const applySuggestion = (s: string) => {
    setPrefill({ text: s, id: Date.now() });
  };

  return (
    <div
      className={cn('bg-background relative flex min-h-0 flex-1 flex-col overflow-hidden px-4.5')}
    >
      <div className="pointer-events-none absolute inset-0 z-0" aria-hidden>
        <SessionWelcome />
      </div>
      {showSidebarToggle && (
        <Button
          type="button"
          aria-label={sidebarToggleLabel}
          variant="ghost"
          size="icon"
          onClick={toggleSidebar}
          onPointerEnter={sidebarState === 'collapsed' ? peekEnter : undefined}
          onPointerLeave={sidebarState === 'collapsed' ? peekLeave : undefined}
          className="hover:bg-sidebar-accent hover:text-sidebar-foreground absolute top-2 left-2 z-20 shrink-0 cursor-pointer items-center justify-center rounded-md transition-[color,background-color,transform] duration-150 ease-out active:scale-[0.96]"
        >
          <PanelLeft className="cn-rtl-flip size-4" />
        </Button>
      )}
      {pendingAccessCount > 0 ? (
        <div className="absolute top-4 right-4 z-20">
          <Hint
            label={`${pendingAccessCount} pending access request${pendingAccessCount === 1 ? '' : 's'}`}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="bg-background/80 relative backdrop-blur-sm"
              onClick={() => router.push(capabilityTabHref(projectId, 'members'))}
              aria-label={`${pendingAccessCount} pending access request${pendingAccessCount === 1 ? '' : 's'}`}
            >
              <Bell className="size-4" />
              <Badge
                size="xs"
                variant="new"
                className="absolute -top-1 -right-1 min-w-5 px-1 tabular-nums"
              >
                {pendingAccessCount}
              </Badge>
            </Button>
          </Hint>
        </div>
      ) : null}

      <ProjectHomeWelcomeBody
        projectId={projectId}
        onPickSuggestion={applySuggestion}
        composer={
          <ComposerChatInput
            onSend={handleSend}
            onCommand={handleCommand}
            projectId={projectId}
            // `busy` here means "create in flight" — spinner in the send slot,
            // input locked. NOT isBusy (that renders agent-running stop-button
            // semantics, which leave the composer with no button at all here).
            isSending={busy}
            disabled={busy}
            // The home composer navigates to the new session on send — don't clear
            // it first (that only flashes an empty box before the route swaps, and
            // would drop the text on a gated send). The message rides across via the
            // start-stash and reappears as the instant shell's optimistic turn.
            clearOnSend={false}
            autoFocus
            cardClassName="rounded-xl"
            // A hero composer floating mid-page has no column for a second
            // rail to align to, so the attach/agent/context controls ride on
            // the toolbar itself, ahead of the model selector. The session
            // page keeps the default row beneath the card.
            underbarPlacement="inline"
            // Hero composer mid-page: the `/` menu opens BELOW the card, into
            // the empty lower half, instead of shoving the heading up.
            slashMenuPlacement="below"
            placeholder={tI18nHardcoded.raw(
              'autoFeaturesCoWorkerProjectLayoutProjectHomeJsxAttrPlaceholder115e6c2d',
            )}
            prefill={prefill}
            onAgentSelectionChange={setSelectedAgent}
            toolbarSlot={metaSelected ? <MetaRuntimeIndicator /> : null}
            // The template chooser lives inside the overrides panel, not on the
            // bar — the bar keeps only agent + model.
            sandboxSlot={
              !metaSelected && showSandboxPicker
                ? {
                    summary: selectedSlug
                      ? (sandboxItems.find((t) => t.slug === selectedSlug)?.name ?? selectedSlug)
                      : 'Agent default',
                    overridden: selectedSlug !== null,
                    control: (
                      <SandboxPicker
                        items={sandboxItems}
                        activeSlug={activeSlug}
                        selectedSlug={selectedSlug}
                        onSelect={setSelectedSlug}
                      />
                    ),
                    onReset: () => setSelectedSlug(null),
                    resetLabel: 'Reset to agent default',
                  }
                : undefined
            }
          />
        }
      />
    </div>
  );
}

function MetaRuntimeIndicator() {
  return (
    <Hint label="Meta uses a fixed minimal sandbox. It starts specialized sessions for project work.">
      <span className="text-muted-foreground inline-flex h-8 items-center gap-1.5 px-2.5 text-xs font-medium">
        <Container className="size-3.5" />
        Meta runtime
      </span>
    </Hint>
  );
}

/**
 * The project-home empty-state body, laid out like Perplexity's home: the
 * centered welcome heading with the composer directly beneath it and the
 * starter-prompt chips right under the input — all vertically centered — while
 * the quiet "set up your project" pills sit at the bottom of the viewport.
 * Shared by the project index page AND the instant session shell's empty state
 * so a brand-new session opens onto the identical surface.
 */
export function ProjectHomeWelcomeBody({
  projectId,
  composer,
  onPickSuggestion,
}: {
  projectId: string;
  /** The composer input rendered in the hero position, directly under the heading. */
  composer?: ReactNode;
  /** When provided, starter-prompt chips render directly below the composer. */
  onPickSuggestion?: (text: string) => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  // One source for the project name — see `useProjectName`'s doc comment.
  const name = useProjectName(projectId) ?? '';
  const displayName = name.trim() || 'this project';

  return (
    <div className="relative z-10 flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="m-auto flex w-full max-w-[52rem] flex-col items-center gap-8 px-2 py-8 sm:px-4">
          <h1 className="text-muted-foreground max-w-2xl text-center text-4xl leading-[1.2] tracking-tight text-balance max-sm:text-3xl">
            Give <span className="text-foreground">{displayName}</span>{' '}
            {tI18nHardcoded.raw(
              'autoFeaturesCoWorkerProjectLayoutProjectHomeJsxTextSomething18ab9904',
            )}
          </h1>

          {composer || onPickSuggestion ? (
            <div className="flex w-full flex-col items-center space-y-4">
              {composer}
              {onPickSuggestion ? <StarterPromptChips onPick={onPickSuggestion} /> : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 justify-center px-4 pb-6">
        <ProjectHomeSections projectId={projectId} />
      </div>
    </div>
  );
}

/**
 * Starter prompt suggestions rendered as a centered, wrapping row of quiet
 * pills directly above the composer (Perplexity-style). All prompts are
 * visible at once — no scroll machinery; small screens show the first four.
 */
export function StarterPromptChips({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      {STARTER_PROMPTS.map((p, i) => {
        const ChipIcon = p.icon;
        const chalk = chalkColors(p.label);
        return (
          <Button
            key={p.id}
            onClick={() => onPick(p.prompt)}
            variant="outline"
            size="sm"
            className={cn(
              'bg-background/60 shrink-0 gap-1.5 rounded-md backdrop-blur-sm',
              i >= 4 && 'max-sm:hidden',
            )}
          >
            <ChipIcon
              className="size-3.5 shrink-0"
              style={{ color: chalk.foreground }}
              aria-hidden
            />
            {p.label}
          </Button>
        );
      })}
    </div>
  );
}

function SandboxPicker({
  items,
  activeSlug,
  selectedSlug,
  onSelect,
}: {
  items: SandboxTemplate[];
  activeSlug: string;
  selectedSlug: string | null;
  onSelect: (slug: string | null) => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const active = items.find((t) => t.slug === activeSlug) ?? items[0] ?? null;
  if (!active) return null;
  const ActiveIcon = active.is_default ? Container : active.has_image ? Package : FileCode;
  const activeStateTone =
    active.daytona_state === 'active'
      ? 'bg-kortix-green'
      : ['pulling', 'building'].includes(active.daytona_state)
        ? 'bg-kortix-blue'
        : active.daytona_state === 'missing'
          ? 'bg-muted-foreground/40'
          : 'bg-destructive';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={tI18nHardcoded.raw(
            'autoFeaturesCoWorkerProjectLayoutProjectHomeJsxAttrAria4acf4ecd',
          )}
          className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors duration-200"
        >
          <ActiveIcon className="size-3.5 shrink-0" />
          <span className="max-w-[7rem] truncate">
            {selectedSlug ? active.name : 'Agent environment'}
          </span>
          <span className={cn('size-1.5 shrink-0 rounded-full', activeStateTone)} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuLabel>
          {tI18nHardcoded.raw('autoFeaturesCoWorkerProjectLayoutProjectHomeJsxTextSandboxe9c5fbaa')}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="flex items-start gap-2" onSelect={() => onSelect(null)}>
          <Bot className="text-muted-foreground mt-0.5 size-4" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Agent environment</span>
              {selectedSlug === null && (
                <Badge variant="outline" size="xs">
                  selected
                </Badge>
              )}
            </div>
            <div className="text-muted-foreground text-xs">
              Uses the selected agent, project, or platform default.
            </div>
          </div>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {items.map((tpl) => {
          const Icon = tpl.is_default ? Container : tpl.has_image ? Package : FileCode;
          const subtitle = tpl.is_default
            ? 'Platform default · clones workspace at boot'
            : tpl.has_image
              ? `Image: ${tpl.image}`
              : `Dockerfile: ${tpl.dockerfile_path}`;
          const stateTone =
            tpl.daytona_state === 'active'
              ? 'text-kortix-green'
              : ['pulling', 'building'].includes(tpl.daytona_state)
                ? 'text-kortix-blue'
                : tpl.daytona_state === 'missing'
                  ? 'text-muted-foreground'
                  : 'text-destructive';
          const stateLabel =
            tpl.daytona_state === 'active'
              ? 'Ready'
              : ['pulling', 'building'].includes(tpl.daytona_state)
                ? 'Building — session will wait'
                : tpl.daytona_state === 'missing'
                  ? 'Not built — first session will build it'
                  : tpl.daytona_state.replace('_', ' ');
          return (
            <DropdownMenuItem
              key={tpl.template_id ?? `tpl-${tpl.slug}`}
              className="flex items-start gap-2"
              onSelect={() => onSelect(tpl.slug)}
            >
              <Icon className="text-muted-foreground mt-0.5 size-4" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{tpl.name}</span>
                  {tpl.slug === selectedSlug && (
                    <Badge variant="outline" size="xs">
                      selected
                    </Badge>
                  )}
                </div>
                <div className="text-muted-foreground truncate text-xs">{subtitle}</div>
                <div className={cn('mt-0.5 text-xs capitalize', stateTone)}>{stateLabel}</div>
              </div>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type SetupTile = {
  icon: ComponentType<{ className?: string }>;
  title: string;
  desc: string;
  // Every tile is a route now. Agents, Connectors, Skills and Triggers are
  // capability tabs of their own (`capabilities/capability-tab-routes.ts`);
  // Your team is a section of the Customize bar's Settings tab
  // (`capabilities/project-settings/project-settings-sections.ts`).
  //
  // A tile is routed by `href` if it has one, then by `isCapabilityTabKey`,
  // then by section key — so a key must be spelled exactly as its URL segment.
  // A near-miss lands on the Settings tab's default section instead of the
  // tile's own destination.
  section: ProjectSettingsSectionKey | CapabilityTab['key'];
  /**
   * The exact destination, for a tile whose target is not a bare route. Only
   * Slack needs it: Channels is a SCOPE of the Connectors page now
   * (`?scope=channels`), and neither route builder emits a query. Without it
   * the tile would open the connector catalogue — the right page, the wrong
   * half of it.
   */
  href?: (projectId: string) => string;
  /**
   * The IAM leaf the tile's DESTINATION asserts. A tile whose probe comes back
   * an explicit deny is not rendered: without this the row offered every user
   * six buttons and a plain project `member` — who holds none of
   * project.connector.read / skill.read / agent.read (they live in
   * EDITOR_EXTRAS, `apps/api/src/iam/role-perms.ts`) — got a "forbidden" toast
   * on click instead of a page.
   *
   * Each action is copied from `TAB_PREFERENCE`
   * (`project-sidebar/project-settings-nav.tsx`), the single table that already
   * maps a capability tab to the leaf its route asserts, so the pill row, the
   * Customize rail and the Customize index all hide the same rows for the same
   * caller. Do not invent a narrower leaf here — a pill that survives its own
   * gate but 403s on arrival is the bug this field exists to prevent.
   */
  action: string;
};

const isCapabilityTabKey = (section: SetupTile['section']): section is CapabilityTab['key'] =>
  CAPABILITY_TABS.some((tab) => tab.key === section);

/** Static navigation does not fetch counts before the user opens Customize. */
const PROJECT_SETUP_TILES: SetupTile[] = [
  {
    icon: HiOutlineViewGrid,
    title: 'Connectors',
    desc: 'Connect tools your agent can act in.',
    section: 'connectors',
    action: PROJECT_ACTIONS.PROJECT_CONNECTOR_READ,
  },
  {
    icon: CalendarClock,
    title: 'Triggers',
    desc: 'Run work on a repeating schedule, or when another app sends a signal.',
    section: 'triggers',
    action: PROJECT_ACTIONS.PROJECT_TRIGGER_READ,
  },
  {
    icon: SparklesSolid,
    title: 'Skills',
    desc: 'Repeatable workflows your agent reuses.',
    section: 'skills',
    action: PROJECT_ACTIONS.PROJECT_SKILL_READ,
  },
  {
    icon: Slack,
    title: 'Slack',
    desc: 'Run this project right from chat.',
    section: 'connectors',
    href: channelsHref,
    // Channels is a SCOPE of the Connectors page, so it gates on the same leaf
    // the Connectors tile does — exactly as TAB_PREFERENCE folded the old
    // `channels` row into `project.connector.read`.
    action: PROJECT_ACTIONS.PROJECT_CONNECTOR_READ,
  },
  {
    icon: UsersGroupSolid,
    title: 'Your team',
    desc: 'Invite people to run and review work.',
    section: 'members',
    action: PROJECT_ACTIONS.PROJECT_MEMBERS_READ,
  },
  {
    icon: Kortix,
    title: 'Agent',
    desc: 'Shape how your agent thinks and acts.',
    // 'agent' (the route segment), not the old 'agents' overlay section —
    // `isCapabilityTabKey` matches on the key, so the wrong spelling would
    // silently fall through to the Settings tab and land on its default
    // section instead of Agents.
    section: 'agent',
    action: PROJECT_ACTIONS.PROJECT_AGENT_READ,
  },
];

/** Stable across renders — `useProjectCans` keys its query on this list. */
const SETUP_TILE_ACTIONS: readonly string[] = Array.from(
  new Set(PROJECT_SETUP_TILES.map((t) => t.action)),
);

function ProjectHomeSections({ projectId }: { projectId: string }) {
  const router = useRouter();
  const caps = useProjectCans(projectId, SETUP_TILE_ACTIONS);
  // Hide on an explicit deny only, never on `!allowed`: a probe still in
  // flight reports `allowed:false`, so gating on truthiness would blank the
  // whole row on every cold load and pop it back in. Same rule as
  // `CustomizeIndexPage` and `ProjectCustomizeNavItem`.
  const tiles = PROJECT_SETUP_TILES.filter((tile) => caps[tile.action]?.allowed !== false);

  // A caller denied every destination gets no row at all, not an empty strip
  // holding its gap/margin open under the composer.
  if (tiles.length === 0) return null;

  return (
    <div className="flex w-full max-w-3xl flex-wrap items-center justify-center gap-2">
      {tiles.map((tile) => {
        const { icon: TileIcon, title, desc, section, href } = tile;

        return (
          // Keyed by title, not by section: two tiles land on the Connectors
          // route now (the catalogue, and Slack's Channels scope), so the
          // section key is no longer unique across this list.
          <Hint key={title} label={desc} side="top">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                router.push(
                  href
                    ? href(projectId)
                    : isCapabilityTabKey(section)
                      ? capabilityTabHref(projectId, section)
                      : projectSettingsSectionHref(projectId, section),
                )
              }
              className="bg-background/60 gap-1.5 rounded-md backdrop-blur-sm"
            >
              <TileIcon className="text-muted-foreground size-4.5 shrink-0" />
              {title}
            </Button>
          </Hint>
        );
      })}
    </div>
  );
}
