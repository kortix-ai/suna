'use client';

import {
  BellIcon as Bell,
  RobotIcon as Bot,
  CalendarDotsIcon as CalendarClock,
  ShippingContainerIcon as Container,
  FileCodeIcon as FileCode,
  PackageIcon as Package,
  SparkleIcon as SparklesSolid,
  UsersThreeIcon as UsersGroupSolid,
} from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { useCallback, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';

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
import { Kortix } from '@/features/icon/icons/kortix';
import { Slack } from '@/features/icon/icons/slack';
import { ComposerChatInput, type ComposerOptions } from '@/features/session/composer-chat-input';
import type { DraftScope } from '@/features/session/composer/draft/composer-draft';
import type { AttachedFile } from '@/features/session/session-chat-input';
import { SessionWelcome } from '@/features/session/session-welcome';
import {
  CAPABILITY_TABS,
  capabilityTabHref,
  channelsHref,
  type CapabilityTab,
} from '@/features/workspace/capabilities/shared/capability-tab-routes';
import { SidebarToggle } from '@/features/workspace/project-layout/sidebar-toggle';
import {
  projectSettingsSectionHref,
  type ProjectSettingsSectionKey,
} from '@/features/workspace/capabilities/project-settings/project-settings-sections';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { SubprojectReportsPreview } from '@/features/subprojects/subproject-reports-preview';
import { SubprojectsHomePreview } from '@/features/subprojects/subprojects-home-preview';
import { useProjectCan, useProjectCans } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import { useComposerPrefillStore } from '@/stores/composer-prefill-store';
import {
  type SandboxTemplate,
  getProjectDetail,
  listProjectAccessRequests,
  listProjectSandboxes,
} from '@kortix/sdk';
import { contract, qk, useProjectName, type Command } from '@kortix/sdk/react';
import { META_SANDBOX_SLUG, isMetaAgentName } from '@kortix/shared';
import { SquaresFourIcon as HiOutlineViewGrid } from '@phosphor-icons/react';

export interface ProjectHomeSendOptions extends ComposerOptions {
  sandbox_slug?: string;
}

/** The bell's icon and count, shared by its anchor and its pre-`account_id` state. */
function AccessRequestsBellBody({ count }: { count: number }) {
  return (
    <>
      <Bell className="size-4" />
      <Badge size="xs" variant="new" className="absolute -top-1 -right-1 min-w-5 px-1 tabular-nums">
        {count}
      </Badge>
    </>
  );
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
  // `GET /projects/:id/access-requests` asserts project.members.manage
  // (`apps/api/src/projects/routes/r6.ts`), so firing it for a plain member is
  // a guaranteed 403 for a bell they could never act on anyway. Probe the leaf
  // first and keep the query disabled until it says yes — `showErrors: false`
  // only silenced the toast, the request still went out and still failed.
  const canManageMembers =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE).allowed === true;
  const accessRequests = useQuery({
    queryKey: qk.project.accessRequests(projectId),
    queryFn: () => listProjectAccessRequests(projectId, { showErrors: false }),
    retry: false,
    enabled: canManageMembers,
    ...contract('inventory'),
    refetchOnWindowFocus: false,
  });
  const pendingAccessCount = accessRequests.data?.requests.length ?? 0;

  // Same query key page.tsx (`ProjectIndexPage`) already fetches for this
  // project — this dedupes against that cache entry rather than firing a
  // second request. Needed here only to resolve `account_id` for the pending
  // access requests bell below, which now routes into the account hub's
  // Access tab (`/accounts/<id>?tab=access-projects`) instead of the deleted
  // project Members capability tab.
  const projectDetailQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
    ...contract('config'),
  });
  const accountId = projectDetailQuery.data?.project?.account_id;
  // Resolved during render so the bell is an anchor and Next holds its payload
  // in the segment cache. `account_id` arrives on a different query than the
  // count, so the bell can paint before the destination exists.
  const accessRequestsHref = accountId
    ? `/accounts/${accountId}?tab=access-projects&project=${projectId}`
    : null;

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

  const pendingPrefill = useComposerPrefillStore((s) => s.prefillByProject[projectId]);
  const consumePrefill = useComposerPrefillStore((s) => s.consume);

  useEffect(() => {
    if (!pendingPrefill) return;
    consumePrefill(projectId);
    // The onboarding hand-off (`project-onboarding-wizard.tsx`) sets
    // `autoSend: true` so the finish step's "Open project" click actually
    // starts the first turn instead of just filling the box — see
    // `composer-prefill-store.ts`. Every other caller (the `?q=` deep link,
    // the command palette) omits the flag and keeps the old prefill-only
    // behavior below.
    if (pendingPrefill.autoSend) {
      handleSend(pendingPrefill.text, undefined, {});
      return;
    }
    setPrefill({ text: pendingPrefill.text, id: Date.now() });
  }, [pendingPrefill, projectId, consumePrefill, handleSend]);

  const handleCommand = useCallback(
    (cmd: Command, args: string | undefined, options: ComposerOptions) => {
      handleSend(`/${cmd.name}${args ? ` ${args}` : ''}`, undefined, options);
    },
    [handleSend],
  );

  // The home composer has no session yet, so its unsent draft is keyed by the
  // project. Memoized because it crosses into a `React.memo`-wrapped composer.
  const draftScope = useMemo<DraftScope>(() => ({ kind: 'project', projectId }), [projectId]);

  return (
    <div
      className={cn('bg-background relative flex min-h-0 flex-1 flex-col overflow-hidden px-4.5')}
    >
      <div className="pointer-events-none absolute inset-0 z-0" aria-hidden>
        <SessionWelcome />
      </div>
      <SidebarToggle placement="floating" />
      {pendingAccessCount > 0 ? (
        <div className="absolute top-4 right-4 z-20">
          <Hint
            label={`${pendingAccessCount} pending access request${pendingAccessCount === 1 ? '' : 's'}`}
          >
            {accessRequestsHref ? (
              <Button
                asChild
                variant="ghost"
                size="icon"
                className="bg-background/80 relative backdrop-blur-sm"
                aria-label={`${pendingAccessCount} pending access request${pendingAccessCount === 1 ? '' : 's'}`}
              >
                <Link href={accessRequestsHref} prefetch>
                  <AccessRequestsBellBody count={pendingAccessCount} />
                </Link>
              </Button>
            ) : (
              // The destination needs `account_id`. Until it lands the bell is
              // inert, exactly as it was before — never a broken href.
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="bg-background/80 relative backdrop-blur-sm"
                aria-label={`${pendingAccessCount} pending access request${pendingAccessCount === 1 ? '' : 's'}`}
              >
                <AccessRequestsBellBody count={pendingAccessCount} />
              </Button>
            )}
          </Hint>
        </div>
      ) : null}

      <ProjectHomeWelcomeBody
        projectId={projectId}
        composer={
          <ComposerChatInput
            onSend={handleSend}
            onCommand={handleCommand}
            projectId={projectId}
            draftScope={draftScope}
            // Home hero: strip the shell's side gutter (`px-4 md:pr-1`) AND its
            // `max-w-210` cap so the card spans the welcome container exactly,
            // and the subprojects preview below shares its edges 1:1. Scoped to this
            // hero instance — session pages keep the shell defaults.
            parentClassName="max-w-none px-0 md:pr-0"
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
 * centered welcome heading with the composer directly beneath it, then the
 * subproject-run report and the installable subprojects grid — all vertically centered —
 * while the quiet "set up your project" pills sit at the bottom of the
 * viewport. Shared by the project index page AND the instant session shell's
 * empty state so a brand-new session opens onto the identical surface.
 *
 * Runs come BEFORE the store: on a project that already has subprojects, "did they
 * run and did anything break" is the live question, and browsing more subprojects
 * is the follow-up.
 */
export function ProjectHomeWelcomeBody({
  projectId,
  composer,
}: {
  projectId: string;
  /** The composer input rendered in the hero position, directly under the heading. */
  composer?: ReactNode;
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

          {composer ? (
            <div className="flex w-full flex-col items-center space-y-4">
              {composer}
              <SubprojectReportsPreview projectId={projectId} />
              <SubprojectsHomePreview projectId={projectId} />
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
   * The exact destination, for a tile whose target is not a bare route.
   * Slack needs it because Channels is a SCOPE of the Connectors page now
   * (`?scope=channels`), and neither route builder emits a query — the tile
   * would otherwise open the connector catalogue, the right page but the
   * wrong half of it. "Your team" needs it because Members graduated out of
   * the project into the account hub's Access tab
   * (`/accounts/<id>?tab=access-projects&project=<id>`), which needs the
   * project's `account_id` — not a value either route builder below can
   * produce. Returning `undefined` means "not ready yet" (account_id still
   * loading): the tile does nothing rather than navigating to a broken URL.
   */
  href?: (projectId: string, accountId?: string) => string | undefined;
  /**
   * Every IAM leaf the tile's destination asserts. ALL of them must be allowed
   * or the tile is not rendered — hidden, never disabled, because a control a
   * person can press and only then be told "forbidden" is worse than no
   * control at all.
   *
   * Five of the six land inside the Customize surface, so they carry
   * `project.customize.read` (the leaf the whole surface is gated on — see
   * `project-sidebar/project-settings-nav.tsx`) PLUS the page's own read leaf,
   * because a custom role can hold the surface and still have one capability
   * deactivated. "Your team" is the exception: it leaves the project entirely
   * for the account hub's Access tab, which renders read-only for anyone who
   * can read the project's member list, so it gates on
   * `project.members.read` alone (see `components/iam/access-projects-tab.tsx`,
   * where every write control probes `project.members.manage` separately).
   */
  actions: readonly string[];
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
    actions: [PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ, PROJECT_ACTIONS.PROJECT_CONNECTOR_READ],
  },
  {
    icon: CalendarClock,
    title: 'Triggers',
    desc: 'Run work on a repeating schedule, or when another app sends a signal.',
    section: 'triggers',
    actions: [PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ, PROJECT_ACTIONS.PROJECT_TRIGGER_READ],
  },
  {
    icon: SparklesSolid,
    title: 'Skills',
    desc: 'Repeatable workflows your agent reuses.',
    section: 'skills',
    actions: [PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ, PROJECT_ACTIONS.PROJECT_SKILL_READ],
  },
  {
    icon: Slack,
    title: 'Slack',
    desc: 'Run this project right from chat.',
    section: 'connectors',
    href: channelsHref,
    // Channels is a SCOPE of the Connectors page, so it asserts exactly what
    // the Connectors tile above asserts — same page, same leaves.
    actions: [PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ, PROJECT_ACTIONS.PROJECT_CONNECTOR_READ],
  },
  {
    icon: UsersGroupSolid,
    title: 'Your team',
    desc: 'Invite people to run and review work.',
    // Members graduated into the account hub's Access tab — this tile always
    // routes through `href` (below), which needs the project's `account_id`.
    // `section` is unused for this tile but still has to satisfy the type;
    // 'general' is an arbitrary valid placeholder, never read.
    section: 'general',
    href: (projectId, accountId) =>
      accountId ? `/accounts/${accountId}?tab=access-projects&project=${projectId}` : undefined,
    actions: [PROJECT_ACTIONS.PROJECT_MEMBERS_READ],
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
    actions: [PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ, PROJECT_ACTIONS.PROJECT_AGENT_READ],
  },
];

/**
 * Every distinct leaf the tiles above name, deduped and module-level so its
 * identity is stable — `useProjectCans` keys its query on the action list and
 * would refetch on each render otherwise.
 */
export const PROJECT_SETUP_TILE_ACTIONS: readonly string[] = [
  ...new Set(PROJECT_SETUP_TILES.flatMap((tile) => tile.actions)),
];

function ProjectHomeSections({ projectId }: { projectId: string }) {
  // One batched probe for every leaf the six tiles name — not one hook per
  // tile, which would fan out six `/effective` GETs on a page that already
  // fires nine of them.
  //
  // Hide only on a denial we actually RECEIVED (`allowed === false`), the same
  // optimistic-while-loading rule `CustomizeIndexPage` and the sidebar's
  // Customize row use: a slow probe must never blink a tile away from someone
  // who does have access.
  const caps = useProjectCans(projectId, PROJECT_SETUP_TILE_ACTIONS);
  const tiles = PROJECT_SETUP_TILES.filter((tile) =>
    tile.actions.every((action) => caps[action]?.allowed !== false),
  );

  // Resolves the project's account_id for the "Your team" tile, which routes
  // into the account hub's Access tab. Same queryKey the pending access
  // requests bell in `ProjectHome` uses — React Query dedupes against that
  // cache entry when both are mounted, and this is the only fetch when this
  // component renders alone (e.g. inside the instant session shell, which has
  // no project-detail query of its own).
  const projectDetailQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
    ...contract('config'),
  });
  const accountId = projectDetailQuery.data?.project?.account_id;

  // Every tile denied — render nothing rather than an empty row that still
  // reserves its gap and padding at the bottom of the hero.
  if (tiles.length === 0) return null;

  return (
    <div className="flex w-full max-w-3xl flex-wrap items-center justify-center gap-2">
      {tiles.map((tile) => {
        const { icon: TileIcon, title, desc, section, href } = tile;
        // Resolved during render, not inside the click handler, so the tile is
        // an anchor Next can prefetch. Only "Your team" returns undefined, and
        // only while `account_id` is still loading — skip it rather than render
        // a tile that swallows the click.
        const target = href
          ? href(projectId, accountId)
          : isCapabilityTabKey(section)
            ? capabilityTabHref(projectId, section)
            : projectSettingsSectionHref(projectId, section);


        return (
          // Keyed by title, not by section: two tiles land on the Connectors
          // route now (the catalogue, and Slack's Channels scope), so the
          // section key is no longer unique across this list.
          <Hint key={title} label={desc} side="top">
            <Button
              // Only "Your team" can lack a target, and only while
              // `qk.project.detail` is still in flight — which is EVERY time
              // inside the instant session shell, since that surface has no
              // project-detail query of its own. Dropping the tile from the DOM
              // meanwhile reflowed the other five across a `flex-wrap` row.
              //
              // So it keeps its place and simply carries no anchor yet: same
              // box, same size, click inert, exactly as before this row became
              // anchors. NOT `disabled` — `project-home.test.tsx` pins the rule
              // that a tile is hidden on a received denial and is never shown
              // greyed out while a read is still in flight.
              asChild={Boolean(target)}
              variant="outline"
              size="sm"
              className="bg-background/60 gap-1.5 rounded-md backdrop-blur-sm"
            >
              {/* Intent-gated, not mount-gated. Six tiles render here, and a
                  forced `prefetch` would issue six dynamic RSC renders of six
                  capability routes on every project-home paint for a grid most
                  users never touch — the same flood `HoverPrefetchLink` was
                  built to stop in the sidebar (21 RSC fetches per session
                  open). Hover/focus/touch arms it, which still lands
                  100-300ms before the click. */}
              {target ? (
                <HoverPrefetchLink href={target} prefetch>
                  <TileIcon className="text-muted-foreground size-4.5 shrink-0" />
                  {title}
                </HoverPrefetchLink>
              ) : (
                <>
                  <TileIcon className="text-muted-foreground size-4.5 shrink-0" />
                  {title}
                </>
              )}
            </Button>
          </Hint>
        );
      })}
    </div>
  );
}
