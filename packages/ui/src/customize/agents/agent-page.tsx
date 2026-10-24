'use client';
import { AgentMark, agentDisplayName } from '../../internal/components/agent-mark';
import { EntityFilePane } from '../shared/entity/entity-modal';
import { useDefaultAgent } from './use-default-agent';

import { useTranslations as useI18nTranslations } from '../../i18n';
/**
 * /projects/[id]/customize/agents/[name] — one agent, as a full-page editor.
 * The core screen of Customize.
 *
 * Customize is agent-first: the agent is the one object a project manager
 * grants a person or a group, and My Kortix configures every other agent as a
 * least-privilege work product. So the page answers, in this order: who is
 * this agent, what does it do, what may it touch, how does it run — then
 * lets the person change each answer.
 *
 *   ┌ Agents › ▣ Name                      [Share] [Start session] [⋯] ┐
 *   ├──────────────┬──────────────────────────────────────────────────┤
 *   │ Overview     │  Overview: the hero (mark, name, kind,           │
 *   │ Instructions │  description), the instructions excerpt, then    │
 *   │ People  …    │  Access / Runtime / Use lists. Every row opens   │
 *   │ Access  …    │  its section. Other sections: their editor, or   │
 *   │ Runtime …    │  the full resource page in agent scope.          │
 *   └──────────────┴──────────────────────────────────────────────────┘
 *                     [ Unsaved changes        Discard   Save ⌘S ]
 *
 * The rail stays because the resource sections are whole pages (their own
 * heading, search and scroller) and a person moves between them; each topic
 * has a URL (`?section=<key>`). The draft is shared across topics, so
 * switching never drops an edit; the save bar floats at the foot while the
 * draft is dirty. Below `lg` the rail is a horizontal strip. An agent with one
 * section (My Kortix) has no rail at all.
 *
 * Two bodies behind one top bar:
 *
 *  - **Editable**: a v2+ project and a caller with `project.agent.write`.
 *    Save round-trips the whole `agents.<name>` block through the
 *    agent-config route, which commits it to the project repo.
 *  - **Read-only**: a v1 project, a caller without write, or a platform
 *    agent. Overview shows the agent's source file; People, Triggers,
 *    Kortix permissions and Model remain. We degrade, never blank.
 *
 * The page is keyed on the agent name by its route, so switching agents
 * remounts every draft rather than carrying one agent's edits onto another.
 */

import { MarkdownWithFrontmatter } from '../../markdown/markdown-frontmatter';
import { Button } from '../../primitives/button';
import { ConfirmDialog } from '../../primitives/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../primitives/dropdown-menu';
import Hint from '../../primitives/hint';
import { InfoBanner } from '../../primitives/info-banner';
import { Kbd } from '../../primitives/kbd';
import Loading from '../../primitives/loading';
import { Skeleton } from '../../primitives/skeleton';
import { Tabs, TabsList, TabsTrigger } from '../../primitives/tabs';
import { Textarea } from '../../primitives/textarea';
import { errorToast, successToast } from '../../primitives/toast';
import { EmptyState } from '../../primitives/empty-state';
import { ErrorState } from '../../primitives/error-state';
import { configEntitySourcePath } from '../sections/component/config-entity-source-path';
import {
  type AgentConfigSectionKey,
  AgentConfigSections,
  agentConfigSectionKeys,
  agentEditorOptionQueries,
  DEFAULT_AGENT_CONFIG_SECTION,
  isAgentConfigSectionKey,
  registryGrantOptions,
  useAgentDraft,
  useAgentEditorOptions,
  useLocalizedAgentConfigCatalog,
} from '../sections/view/agent-editor';
import { toArray } from '../shared/utils';
import {
  editConfigPrompt,
  useConfigureThread,
} from '../use-configure-thread';
import {
  agentConfigNeedsUpgrade,
  useAgentConfig,
  useUpdateAgentConfig,
} from '../../internal/hooks/projects/use-agent-config';
import { useNewProjectSession } from '../../internal/hooks/projects/use-new-project-session';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectCan } from '../../internal/lib/use-project-can';
import { cn } from '../../internal/lib/utils';
import {
  type AgentConfigBlock,
  type AgentGrantSetV2,
  getProjectDetail,
  listProjectResourceGrants,
  listProjectTriggers,
  type ProjectConfigSummary,
  readProjectFile,
} from '@kortix/sdk';
import { contract, qk, useFeatureFlag, useProjectAccountId } from '@kortix/sdk/react';
import { CaretRightIcon, DotsThreeIcon, PlayIcon, StarIcon } from '@phosphor-icons/react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, m } from 'motion/react';
import { UiLink as Link, useUiPathname, useUiRouter, useUiSearchParams } from '../../providers/ui-provider';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

import { FadedScrollArea } from '../../primitives/faded-scroll-area';
import { SETTINGS_SIDEBAR_WIDTH_PX } from '../../internal/account-hub/account-settings-shell';
import { capabilityTabHref } from '../../internal/lib/capability-tab-routes';
import { useIsMobile } from '../../internal/hooks';

import { EditorSection, EditorSectionStyleProvider } from '../sections/view/agent-editor-primitives';

import { AgentDrivesSection } from './agent-drives-section';

import { AgentAuthorityCard } from './agent-authority-card';
import { AgentModel, AgentScope } from './agent-detail-aside';
import {
  AgentHero,
  AgentOverviewSummary,
  DescriptionField,
  InstructionsExcerpt,
  SECTION_ICON,
} from './agent-overview';
import { AppsGrantPage } from './agent-grant-pages';
import { connectorPolicySetOptions } from './agent-policy-sets';
import { AgentPolicySetsPanel } from './agent-policy-sets-section';
import { AgentPeopleSection } from './agent-people-section';
import { AgentShareControl } from './agent-share-control';
import { PlatformAgentOverview } from './platform-agent-overview';
import { ConnectorsPage } from '../connectors/connectors-page';
import { ModelsPage } from '../models/models-page';
import { SecretsPage } from '../secrets/secrets-page';
import { SkillsPage } from '../skills/skills-page';
import { TriggersPage } from '../triggers/triggers-page';
import { CountBadge } from '../../primitives/count-badge';
import { ModelSection } from '../sections/view/agent-editor-basics-fields';
import { type AgentGrant, useAgentGrant } from '../shared/agent-resource-scope';
import { LeaveGuardProvider, useUnsavedChangesGuard } from '../shared/leave-guard';
import { pruneRequiredConnectors, toggleRequiredConnector } from './connectors-required';

/** A host's agent-scoped Apps screen: the full Apps page for one agent. */
export type RenderAgentApps = (args: { agentName: string; grant: AgentGrant }) => ReactNode;

type Agent = ProjectConfigSummary['agents'][number];

export function AgentPage({
  projectId,
  agentName,
  renderApps,
}: {
  projectId: string;
  agentName: string;
  /** The host's full Apps screen in agent scope. Without it the Apps section
   *  is the plain grant catalog (`agent-grant-pages.tsx`). */
  renderApps?: RenderAgentApps;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const tAgentScope = useI18nTranslations('agentScope');
  // `accountId` skips useProjectCan's own getProject and lets the IAM probe
  // run on the first render instead of waiting a round-trip for it.
  const accountId = useProjectAccountId(projectId);
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_AGENT_WRITE, { accountId }).allowed === true;

  const detailQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
  });
  const config = detailQuery.data?.config ?? null;
  const agent = toArray(config?.agents).find((a) => a.name === agentName) ?? null;
  // Meta (and any platform-owned agent) is injected by the API, not declared in
  // kortix.yaml. Its configuration is fixed: never editable, no agent-config read.
  const isPlatform = agent?.platform === true;

  // All reads start on the first render, in parallel. The agent-config read
  // used to wait for detail to list the agent, and the editor's option reads
  // for the editor to mount: three round trips in a row, each a Git read on
  // the API. Now the skeleton lasts as long as the slowest single read.
  const configQuery = useAgentConfig(projectId, agentName);
  const editorOptionQueries = agentEditorOptionQueries(projectId);
  useQueries({
    queries: [
      editorOptionQueries.secrets,
      editorOptionQueries.connectors,
      editorOptionQueries.sandboxes,
    ].map((query) => ({ ...query, enabled: canWrite })),
  });

  if (detailQuery.isLoading || (agent && !isPlatform && configQuery.isLoading)) {
    return <AgentPageSkeleton />;
  }

  if (detailQuery.isError || !config) {
    return (
      <CenteredState>
        <ErrorState
          size="sm"
          title={tI18nComplete.raw('textd70d09b7d701')}
          action={
            <Button variant="outline" size="sm" onClick={() => detailQuery.refetch()}>
              {tI18nComplete.raw('text942087cc2d41')}
            </Button>
          }
        />
      </CenteredState>
    );
  }

  if (!agent) {
    return (
      <CenteredState>
        <EmptyState
          size="sm"
          title={tI18nComplete('text8136e0c475c7', { value0: agentName })}
          description={tI18nComplete.raw('text2ad30464c3ed')}
          action={
            <Button asChild variant="outline" size="sm">
              <Link href={capabilityTabHref(projectId, 'agent')}>
                {tI18nComplete.raw('text54c32d3e2cfa')}
              </Link>
            </Button>
          }
        />
      </CenteredState>
    );
  }

  // A writer whose agent-config read failed would otherwise land on the
  // read-only page with no word on why: say it failed, and offer the retry.
  if (!isPlatform && canWrite && configQuery.isError) {
    return (
      <CenteredState>
        <ErrorState
          size="sm"
          title={tAgentScope('configError')}
          action={
            <Button variant="outline" size="sm" onClick={() => configQuery.refetch()}>
              {tI18nComplete.raw('text942087cc2d41')}
            </Button>
          }
        />
      </CenteredState>
    );
  }

  const editable = !isPlatform && canWrite && configQuery.data?.editable === true;
  const isV1 = !isPlatform && agentConfigNeedsUpgrade(configQuery.data);

  return editable ? (
    <EditableAgentPage
      projectId={projectId}
      agent={agent}
      config={config}
      initial={configQuery.data?.block ?? {}}
      schemaVersion={configQuery.data?.schema_version ?? 2}
      renderApps={renderApps}
    />
  ) : (
    <ReadOnlyAgentPage
      projectId={projectId}
      agent={agent}
      config={config}
      canWrite={canWrite}
      showUpgradeHint={isV1}
      isPlatform={isPlatform}
    />
  );
}

// ─── Frame ─────────────────────────────────────────────────────────────────

/**
 * The top bar, then the rail beside the pane, then the footer. The pane is the
 * one scroller. With one section (My Kortix) there is no rail: the pane takes
 * the whole width.
 */
function AgentPageFrame({
  header,
  section,
  sections,
  sectionHref,
  pane,
  footer,
  full = false,
  summary,
}: {
  header: ReactNode;
  section: AgentConfigSectionKey;
  sections: readonly AgentConfigSectionKey[];
  sectionHref: (key: AgentConfigSectionKey) => string;
  pane: ReactNode;
  footer?: ReactNode;
  /** The rail's right edge per section: what the agent holds there, so the
   *  rail reads as the agent's authority at a glance (`grantSummaryMark`). */
  summary?: Partial<Record<AgentConfigSectionKey, ReactNode>>;
  /** A resource section (`FULL_SECTIONS`, plus Apps) renders the full page,
   *  which brings its own `CapabilityPageShell` heading and scroll container.
   *  The frame then hands it the whole area: no centred column, no second
   *  scroller, the same context the standalone route gives that page. */
  full?: boolean;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const isMobile = useIsMobile();
  const localizedConfig = useLocalizedAgentConfigCatalog();
  const sectionKeys = new Set(sections);
  const items = localizedConfig.sections.filter((s) => sectionKeys.has(s.key));
  const groups = localizedConfig.groups
    .map((group) => ({ group, items: items.filter((s) => s.group === group) }))
    .filter((g) => g.items.length > 0);
  const showRail = items.length > 1;
  const trigger = (item: (typeof localizedConfig.sections)[number], horizontal: boolean) => {
    const SectionIcon = SECTION_ICON[item.key];
    return (
      <TabsTrigger
        key={item.key}
        value={item.key}
        asChild
        size={horizontal ? undefined : 'md'}
        className={
          horizontal
            ? 'w-auto shrink-0 gap-2 px-3 py-0.75 whitespace-nowrap'
            : cn(
                // The Settings rail's row dialect (`project-settings-page.tsx`).
                'gap-2 px-2.5 py-1 font-normal transition-none has-[>svg]:px-2.5',
                'text-foreground data-[state=inactive]:text-foreground hover:bg-hover hover:text-foreground',
                'data-[state=active]:bg-active data-[state=active]:font-medium',
                '[&_svg]:text-muted-foreground data-[state=active]:[&_svg]:text-foreground',
              )
        }
      >
        <Link href={sectionHref(item.key)} prefetch>
          <SectionIcon className="size-4 shrink-0" />
          <span className={cn(!horizontal && 'min-w-0 flex-1 truncate text-left')}>{item.label}</span>
          {!horizontal && summary?.[item.key] ? summary[item.key] : null}
        </Link>
      </TabsTrigger>
    );
  };

  const main = full ? (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{pane}</main>
  ) : (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 py-8 pb-32 lg:py-12 lg:pb-32">{pane}</div>
    </main>
  );

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b px-4 py-2.5">{header}</div>
      {!showRail ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{main}</div>
      ) : isMobile ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <nav
            aria-label={tI18nComplete.raw('text7be318295927')}
            className="flex h-auto shrink-0 items-center border-b"
          >
            <FadedScrollArea
              orientation="horizontal"
              fadeColor="from-background"
              className="min-w-0 flex-1 py-2"
            >
              <Tabs value={section} className="w-fit">
                <TabsList orientation="horizontal" className="w-fit">
                  {items.map((item) => trigger(item, true))}
                </TabsList>
              </Tabs>
            </FadedScrollArea>
          </nav>
          {main}
        </div>
      ) : (
        <div
          className="grid min-h-0 flex-1 overflow-hidden"
          style={{ gridTemplateColumns: `${SETTINGS_SIDEBAR_WIDTH_PX}px 1fr` }}
        >
          <aside className="flex min-h-0 flex-col border-r bg-inherit">
            <nav
              aria-label={tI18nComplete.raw('text7be318295927')}
              className="flex min-h-0 flex-1 [scrollbar-width:none] flex-col overflow-y-auto px-2 pt-3 pb-2 [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
            >
              <Tabs value={section} orientation="vertical" className="space-y-4">
                {groups.map((g) => (
                  <div key={g.group}>
                    {groups.length > 1 ? (
                      <div className="text-muted-foreground flex h-7 items-center px-2.5 text-xs">
                        {g.group}
                      </div>
                    ) : null}
                    <TabsList orientation="vertical" className="w-full">
                      {g.items.map((item) => trigger(item, false))}
                    </TabsList>
                  </div>
                ))}
              </Tabs>
            </nav>
          </aside>
          {main}
        </div>
      )}
      {footer}
    </div>
  );
}

function CenteredState({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-16">{children}</div>
    </div>
  );
}

/**
 * The frame, drawn before its reads land: the top bar, the rail as two
 * labelled groups, and the Overview hero. The same boxes as the loaded page,
 * so nothing moves when it resolves.
 */
function AgentPageSkeleton() {
  const isMobile = useIsMobile();
  const header = (
    <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2.5">
      <Skeleton className="h-4 w-14 rounded-sm" />
      <Skeleton className="shrink-0 rounded-sm" style={{ width: 20, height: 20 }} />
      <Skeleton className="h-4 w-24 rounded-sm" />
      <div className="flex-1" />
      <Skeleton className="h-8 w-28 shrink-0 rounded-md" />
    </div>
  );
  const pane = (
    <div className="mx-auto w-full max-w-2xl space-y-8 px-4 py-8 lg:py-12">
      <div className="flex items-center gap-4">
        {/* `AgentMark size={42}` is a 56px tile (literal px, see agent-mark.tsx). */}
        <Skeleton className="shrink-0 rounded-md" style={{ width: 56, height: 56 }} />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-6 w-40 rounded-sm" />
          <Skeleton className="h-4 w-56 max-w-full rounded-sm" />
        </div>
      </div>
      <Skeleton className="h-11 w-full rounded-md" />
      <Skeleton className="h-56 w-full rounded-md" />
    </div>
  );
  if (isMobile) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col">
        {header}
        <div className="flex shrink-0 items-center gap-2 overflow-hidden border-b py-2">
          {Array.from({ length: 5 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder
            <Skeleton key={i} className="h-8 w-20 shrink-0 rounded-md" />
          ))}
        </div>
        {pane}
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {header}
      <div
        className="grid min-h-0 flex-1"
        style={{ gridTemplateColumns: `${SETTINGS_SIDEBAR_WIDTH_PX}px 1fr` }}
      >
        <div className="space-y-4 border-r px-2 pt-3">
          {[5, 6].map((rows) => (
            <div key={rows} className="space-y-1">
              <Skeleton className="mx-2.5 my-2 h-3 w-16 rounded-sm" />
              {Array.from({ length: rows }).map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder
                <Skeleton key={i} className="h-8 w-full rounded-sm" />
              ))}
            </div>
          ))}
        </div>
        {pane}
      </div>
    </div>
  );
}

// ─── Section routing ───────────────────────────────────────────────────────

/**
 * Which topic the page shows. Seeded from `?section=` so the Access hub and
 * the Triggers tab can deep-link one; the rail's links write the same param,
 * so the URL always names the topic on screen.
 */
function useAgentSection(available: readonly AgentConfigSectionKey[]): AgentConfigSectionKey {
  const searchParams = useUiSearchParams();
  const fromUrl = searchParams.get('section');
  if (isAgentConfigSectionKey(fromUrl) && available.includes(fromUrl)) return fromUrl;
  return available.find((k) => k === DEFAULT_AGENT_CONFIG_SECTION) ?? available[0];
}

function sectionHrefFor(pathname: string) {
  return (key: AgentConfigSectionKey) => `${pathname}?section=${key}`;
}

/**
 * The Overview's Use facts: how many grants name this agent, and how many
 * triggers start it. The same two lists, under the same keys and gates, as
 * the Agents index cards, so both read one cache. A count the viewer may not
 * read stays undefined, and its row shows no value.
 */
function useAgentUseCounts(projectId: string, agentName: string, config: ProjectConfigSummary) {
  const accountId = useProjectAccountId(projectId);
  const canReadTriggers =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_TRIGGER_READ, { accountId }).allowed === true;
  const canManageMembers =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE, { accountId }).allowed === true;
  const triggers = useQuery({
    queryKey: qk.project.triggers(projectId),
    queryFn: () => listProjectTriggers(projectId),
    enabled: canReadTriggers,
    ...contract('config'),
  });
  const grants = useQuery({
    queryKey: qk.project.resourceGrants(projectId),
    queryFn: () => listProjectResourceGrants(projectId),
    enabled: canManageMembers,
    retry: false,
    ...contract('inventory'),
  });
  // A trigger stored as `default` starts the project's default agent.
  const fallback = config.default_agent ?? config.open_code_default_agent ?? null;
  return {
    triggerCount: triggers.data
      ? triggers.data.triggers.filter(
          (t) => (t.agent === 'default' && fallback ? fallback : t.agent) === agentName,
        ).length
      : undefined,
    peopleCount: grants.data
      ? grants.data.grants.filter((g) => g.resource_type === 'agent' && g.resource_id === agentName)
          .length
      : undefined,
  };
}

// ─── Header ────────────────────────────────────────────────────────────────

/**
 * The two actions every agent has, shared by the full header and the
 * compact bar so the two cannot offer different things.
 *
 * "Start session" creates a session booted on THIS agent through the same
 * hook the sidebar's New session button uses — the same guard against double
 * clicks, the same billing gate, the same navigation. It is the page's
 * primary action because an agent exists to be run. A subagent is called by
 * other agents, never picked for a session — the composer hides it — so the
 * button is disabled with the reason, not offered.
 */
function AgentActions({
  projectId,
  agent,
  config,
  canWrite,
}: {
  projectId: string;
  agent: Agent;
  config: ProjectConfigSummary;
  canWrite: boolean;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const queryClient = useQueryClient();
  const startSession = useNewProjectSession(projectId);
  const configure = useConfigureThread(projectId);
  const [confirmEditSource, setConfirmEditSource] = useState(false);
  const isDefault = (config.default_agent ?? config.open_code_default_agent) === agent.name;
  const mode = agent.mode?.toLowerCase();
  const startBlocked =
    agent.enabled === false
      ? 'This agent is disabled.'
      : mode === 'subagent'
        ? 'Subagents are called by other agents, not started directly.'
        : null;

  const makeDefault = useDefaultAgent(projectId);

  const pathname = useUiPathname();
  return (
    <div className="flex shrink-0 items-center gap-2">
      <AgentShareControl
        projectId={projectId}
        agentName={agent.name}
        peopleHref={`${pathname}?section=people`}
      />
      {startBlocked ? (
        <Hint label={startBlocked}>
          {/* A span, so the tooltip still fires over a disabled button. */}
          <span className="inline-flex">
            <Button size="sm" disabled>
              <PlayIcon weight="fill" className="size-3.5 shrink-0" />
              {tI18nComplete.raw('textb1c52ee3677d')}
            </Button>
          </span>
        </Hint>
      ) : (
        <Button size="sm" onClick={() => startSession({ create: { agent_name: agent.name } })}>
          <PlayIcon weight="fill" className="size-3.5 shrink-0" />
          {tI18nComplete.raw('textb1c52ee3677d')}
        </Button>
      )}
      {canWrite ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="secondary"
              size="icon-sm"
              aria-label={tI18nComplete.raw('textf8d46c2570e7')}
            >
              <DotsThreeIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={isDefault || agent.enabled === false || makeDefault.isPending}
              onSelect={() => makeDefault.mutate(agent.name)}
            >
              <StarIcon className="size-4" />
              {isDefault
                ? tI18nComplete.raw('texte8cb80e5c5cb')
                : tI18nComplete.raw('texte8f43f910a4e')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={configure.pending}
              onSelect={() => setConfirmEditSource(true)}
            >
              {tI18nComplete.raw('text4930821dd07b')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {/* Sending a prompt opens a whole new chat, which is a bigger commitment
          than a menu row implies — confirm first, like the entity modal did. */}
      <ConfirmDialog
        open={confirmEditSource}
        onOpenChange={setConfirmEditSource}
        title={tI18nComplete.raw('text24ba36a8ec86')}
        description={tI18nComplete('text13324ae62b23', { value0: agent.name })}
        confirmLabel={tI18nComplete.raw('text0bce1a892dec')}
        cancelLabel={tI18nComplete.raw('text19766ed6ccb2')}
        onConfirm={() => {
          setConfirmEditSource(false);
          configure.start(editConfigPrompt('agent', agent.name, agent.path));
        }}
      />
    </div>
  );
}

/**
 * The top bar of every section: where you are (Agents › mark and name, the
 * h1) and what you can do. The agent's kind, status and description live in
 * the Overview hero, so this bar stays one calm line on every section.
 */
function AgentHeader({
  projectId,
  agent,
  config,
  canWrite,
}: {
  projectId: string;
  agent: Agent;
  config: ProjectConfigSummary;
  canWrite: boolean;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  return (
    <header className="flex min-h-8 items-center gap-3">
      <nav
        aria-label={tI18nComplete.raw('text2bd873d6c734')}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-sm"
      >
        <Link
          href={capabilityTabHref(projectId, 'agent')}
          prefetch
          className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
        >
          {tI18nComplete.raw('text279b44d2ab4b')}
        </Link>
        <CaretRightIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
        <AgentMark slug={agent.name} size={14} />
        <h1 className="text-foreground truncate text-sm font-medium">
          {agentDisplayName(agent.name)}
        </h1>
      </nav>
      <AgentActions projectId={projectId} agent={agent} config={config} canWrite={canWrite} />
    </header>
  );
}

/**
 * The rail's right-edge mark for one grant: the pick count, or All. None and
 * an unset grant show nothing — an empty edge is the quiet default.
 */
function grantSummaryMark(value: AgentGrantSetV2 | undefined, allLabel: string): ReactNode {
  if (value === 'all') return <span className="text-muted-foreground shrink-0 text-xs">{allLabel}</span>;
  if (Array.isArray(value) && value.length > 0) return <CountBadge count={value.length} />;
  return null;
}

// ─── Editable body ─────────────────────────────────────────────────────────

/** What a v1 project, or a reader without write, can still see. */
const READ_ONLY_SECTIONS: readonly AgentConfigSectionKey[] = [
  'overview',
  'people',
  'triggers',
  'actions',
  'model',
];
/** A platform agent (Meta) shows one page: its identity and the platform notice.
 *  Its people, triggers, model and permissions are platform-managed, not project
 *  settings to inspect here. */
const PLATFORM_SECTIONS: readonly AgentConfigSectionKey[] = ['overview'];

/**
 * The sections that render a whole resource page in agent scope — its own
 * heading, search, filters and scroller — the same screen the project-wide
 * route shows, scoped to this agent (Marko, 2026-10-24: one component, two
 * variants). The frame hands them the full area instead of the centred
 * column. Apps joins them when the host supplies its Apps screen.
 */
const FULL_SECTIONS: readonly AgentConfigSectionKey[] = [
  'connectors',
  'skills',
  'secrets',
  'model',
  'triggers',
];

function EditableAgentPage({
  projectId,
  agent,
  config,
  initial,
  schemaVersion,
  renderApps,
}: {
  projectId: string;
  agent: Agent;
  config: ProjectConfigSummary;
  initial: AgentConfigBlock;
  /** The manifest version: v3 adds the subagent, command and extension grants. */
  schemaVersion: number;
  renderApps?: RenderAgentApps;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const tAgentScope = useI18nTranslations('agentScope');
  const editor = useAgentDraft(initial);
  const options = useAgentEditorOptions(projectId);
  const update = useUpdateAgentConfig(projectId, agent.name);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const skillsOptions = toArray(config.skills).map((skill) => ({
    id: skill.name,
    label: skill.name,
    description: skill.description ?? undefined,
  }));
  const pathname = useUiPathname();
  // Drives exists only with Volumes on (the project's derived `drives` flag).
  const drivesOn = useFeatureFlag(projectId, 'drives').enabled;
  const sections = useMemo(
    () => agentConfigSectionKeys(schemaVersion).filter((k) => drivesOn || k !== 'drives'),
    [schemaVersion, drivesOn],
  );
  const registryOptions = useMemo(
    () => registryGrantOptions({ manifest_raw: config.manifest_raw, agents: toArray(config.agents) }, agent.name),
    [config.manifest_raw, config.agents, agent.name],
  );
  const policySetOptions = useMemo(
    () => connectorPolicySetOptions(config.manifest_raw),
    [config.manifest_raw],
  );
  const section = useAgentSection(sections);
  const counts = useAgentUseCounts(projectId, agent.name, config);
  const surface = { kind: 'agent', agentName: agent.name } as const;
  const defaultAgent = config.default_agent ?? config.open_code_default_agent;

  // The agent's grant over each resource catalog the agent variant drives.
  const { draft, set } = editor;
  const connectorsGrant = useAgentGrant(draft.connectors, (v) => {
    set('connectors', v);
    const kept = pruneRequiredConnectors(draft.connectors_required, v);
    if (kept !== draft.connectors_required) set('connectors_required', kept);
  });
  const requiredConnectors = {
    list: draft.connectors_required ?? [],
    isRequired: (slug: string) => draft.connectors_required?.includes(slug) === true,
    toggle: (slug: string) =>
      set('connectors_required', toggleRequiredConnector(draft.connectors_required, slug)),
  };
  const skillsGrant = useAgentGrant(draft.skills, (v) => set('skills', v));
  const secretsGrant = useAgentGrant(draft.secrets, (v) => set('secrets', v));
  const appsGrant = useAgentGrant(draft.apps, (v) => set('apps', v));
  const full = FULL_SECTIONS.includes(section) || (section === 'apps' && renderApps !== undefined);

  const allLabel = tAgentScope('modeAll');
  const summary: Partial<Record<AgentConfigSectionKey, ReactNode>> = {
    skills: grantSummaryMark(draft.skills, allLabel),
    subagents: grantSummaryMark(draft.subagents, allLabel),
    commands: grantSummaryMark(draft.commands, allLabel),
    extensions: grantSummaryMark(draft.extensions, allLabel),
    connectors: grantSummaryMark(draft.connectors, allLabel),
    secrets: grantSummaryMark(draft.secrets, allLabel),
    apps: grantSummaryMark(draft.apps, allLabel),
  };

  const onSave = useCallback(async () => {
    if (!editor.isDirty || update.isPending) return;
    try {
      const response = await update.mutateAsync(editor.draft);
      editor.commit(response.block ?? editor.draft);
      successToast(tI18nComplete('text6b0bbffdbd6e', { value0: agentDisplayName(agent.name) }));
    } catch (e) {
      errorToast((e as Error)?.message ?? tI18nComplete.raw('text166442c65e8e'));
    }
  }, [editor, update, agent.name, tI18nComplete]);

  // Rail links change only `?section=` on this same path; the guard lets those
  // through so switching topics never asks about unsaved edits — the draft is
  // shared across topics and nothing is lost.
  const leaveGuard = useUnsavedChangesGuard(editor.isDirty, pathname);
  useSaveShortcut(onSave);

  const fullPane = (() => {
    switch (section) {
      case 'connectors':
        return (
          <ConnectorsPage
            projectId={projectId}
            surface={surface}
            grant={connectorsGrant}
            required={requiredConnectors}
            agentPanel={
              <AgentPolicySetsPanel projectId={projectId} editor={editor} catalog={policySetOptions} />
            }
          />
        );
      case 'skills':
        return <SkillsPage projectId={projectId} surface={surface} grant={skillsGrant} />;
      case 'secrets':
        return <SecretsPage projectId={projectId} surface={surface} grant={secretsGrant} />;
      case 'apps':
        return renderApps?.({ agentName: agent.name, grant: appsGrant }) ?? null;
      case 'triggers':
        return <TriggersPage projectId={projectId} surface={surface} defaultAgent={defaultAgent} />;
      case 'model':
        return (
          <ModelsPage
            projectId={projectId}
            surface={surface}
            agentSettings={
              <EditorSectionStyleProvider value="panel">
                <div className="space-y-8">
                  <ModelSection oc={editor.oc} setOc={editor.setOc} showPrompt={false} lead={false} />
                </div>
              </EditorSectionStyleProvider>
            }
          />
        );
      default:
        return null;
    }
  })();

  return (
    // Embedded screens leave through the router too (the settings nav, a
    // configure session): they ask the same question as a link click.
    <LeaveGuardProvider value={leaveGuard.confirmLeave}>
    <AgentPageFrame
      header={
        <AgentHeader projectId={projectId} agent={agent} config={config} canWrite />
      }
      section={section}
      sections={sections}
      sectionHref={sectionHrefFor(pathname)}
      full={full}
      summary={summary}
      pane={
        full ? (
          fullPane
        ) : (
        <AgentConfigSections
          section={section}
          editor={editor}
          options={options}
          skillsOptions={skillsOptions}
          registryOptions={registryOptions}
          apps={<AppsGrantPage projectId={projectId} editor={editor} />}
          drives={<AgentDrivesSection projectId={projectId} agentName={agent.name} />}
          overview={
            <div className="space-y-10">
              <AgentHero agent={agent} config={config}>
                <DescriptionField
                  value={editor.oc.description ?? ''}
                  onChange={(next) => editor.setOc('description', next)}
                  subagent={editor.oc.mode === 'subagent'}
                />
              </AgentHero>
              <InstructionsExcerpt
                prompt={editor.oc.prompt ?? ''}
                href={sectionHrefFor(pathname)('instructions')}
              />
              <AgentOverviewSummary
                sections={sections}
                sectionHref={sectionHrefFor(pathname)}
                facts={{
                  grants: {
                    skills: draft.skills,
                    subagents: draft.subagents,
                    commands: draft.commands,
                    extensions: draft.extensions,
                    connectors: draft.connectors,
                    secrets: draft.secrets,
                    apps: draft.apps,
                    actions: draft.kortix_permissions ?? draft.kortix_cli,
                  },
                  requiredConnectors: draft.connectors_required?.length ?? 0,
                  model: editor.oc.model,
                  permission: editor.oc.permission,
                  sandbox: draft.sandbox,
                  repositoryAccess: draft.repository_access,
                  ...counts,
                }}
              />
            </div>
          }
          instructions={
            <InstructionsSection
              value={editor.oc.prompt ?? ''}
              onChange={(next) => editor.setOc('prompt', next)}
            />
          }
          people={<AgentPeopleSection projectId={projectId} agentName={agent.name} />}
          authority={
            <AgentAuthorityCard
              projectId={projectId}
              agentName={agent.name}
              grant={editor.draft.kortix_permissions ?? editor.draft.kortix_cli}
            />
          }
        />
        )
      }
      footer={
        <>
          <SaveBar
            dirty={editor.isDirty}
            pending={update.isPending}
            onDiscard={() => setConfirmDiscard(true)}
            onSave={onSave}
          />

          <ConfirmDialog
            open={confirmDiscard}
            onOpenChange={setConfirmDiscard}
            title={tI18nComplete.raw('text3b13192b9d88')}
            description={tI18nComplete('text8a36cce34f68', { value0: agentDisplayName(agent.name) })}
            confirmLabel={tI18nComplete.raw('texteb1a70e39274')}
            cancelLabel={tI18nComplete.raw('texte76fd2add010')}
            confirmVariant="destructive"
            onConfirm={() => {
              setConfirmDiscard(false);
              editor.discard();
            }}
          />

          {/* The same question, asked by a link click while dirty — the
              sidebar, a tab, the breadcrumb. Confirming leaves; cancelling
              stays put. */}
          <ConfirmDialog
            open={leaveGuard.asking}
            onOpenChange={(open) => {
              if (!open) leaveGuard.stay();
            }}
            title={tI18nComplete.raw('text2190d03af90a')}
            description={tI18nComplete('textbbc5a3f2ca48', { value0: agentDisplayName(agent.name) })}
            confirmLabel={tI18nComplete.raw('textfc6e4a408d56')}
            cancelLabel={tI18nComplete.raw('texte76fd2add010')}
            confirmVariant="destructive"
            onConfirm={leaveGuard.leave}
          />
        </>
      }
    />
    </LeaveGuardProvider>
  );
}

/**
 * The instructions — the agent's system prompt, and the thing that most IS
 * the agent. Two views of one field: Edit is the textarea, Preview renders
 * the markdown the way the agent's source file reads. It opens on Preview
 * when there is something to read and on Edit when there is not; the toggle
 * is the segmented `TabsList` at the section heading's right edge.
 */
function InstructionsSection({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const [view, setView] = useState<'edit' | 'preview'>(value.trim() ? 'preview' : 'edit');
  return (
    <EditorSection
      title={tI18nComplete.raw('text934652dce41d')}
      description={tI18nComplete.raw('text5fe8921b712c')}
      lead
      trailing={
        <Tabs value={view} onValueChange={(next) => setView(next as 'edit' | 'preview')}>
          <TabsList aria-label={tI18nComplete.raw('texte75bb2d0d554')}>
            <TabsTrigger value="edit">{tI18nComplete.raw('text464c4ffd019e')}</TabsTrigger>
            <TabsTrigger value="preview">{tI18nComplete.raw('text324b134f57c7')}</TabsTrigger>
          </TabsList>
        </Tabs>
      }
      bare
    >
      {view === 'edit' ? (
        <Textarea
          aria-label={tI18nComplete.raw('text934652dce41d')}
          value={value}
          placeholder={tI18nComplete.raw('text1436469ad07f')}
          minHeight={420}
          autoFocus={value.trim().length > 0}
          className="font-mono text-xs leading-relaxed"
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <div className="bg-popover min-h-[420px] rounded-md border px-5 py-4">
          <MarkdownWithFrontmatter content={value} />
        </div>
      )}
    </EditorSection>
  );
}

/**
 * The save bar. Exists only while there is something to save — an always-on
 * disabled pair of buttons is chrome that never earns its row. It floats at
 * the bottom centre of the page in the Drive selection bar's shape
 * (`project-files/components/drive-selection-bar.tsx`): a `bg-popover` card
 * as wide as its content — the state as a title over one muted line, then
 * Discard and Save as a spaced pair (a confirm is never glued to its cancel).
 * It sits outside both scrollers, so it is reachable
 * from any point in a long instruction set.
 */
function SaveBar({
  dirty,
  pending,
  onDiscard,
  onSave,
}: {
  dirty: boolean;
  pending: boolean;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  return (
    <AnimatePresence initial={false}>
      {dirty ? (
        <m.div
          key="save-bar"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
          className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center px-4"
        >
          <div className="bg-popover text-popover-foreground border-border pointer-events-auto flex max-w-full items-center gap-3 rounded-lg border p-2 pl-3.5 shadow-md">
            <div className="min-w-0" aria-live="polite">
              <p className="text-foreground truncate text-sm font-medium">
                {tI18nComplete.raw('textefa5855ff509')}
              </p>
              <p className="text-muted-foreground truncate text-xs">
                {tI18nComplete.raw('textc8134fda3694')}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={onDiscard}
                disabled={pending}
              >
                {tI18nComplete.raw('texteb1a70e39274')}
              </Button>
              <Button size="sm" className="gap-1.5" onClick={onSave}
                disabled={pending}
              >
                {pending ? <Loading className="size-3.5 shrink-0" /> : null}
                {tI18nComplete.raw('text1509f561f241')}
                <Kbd>{tI18nComplete.raw('text8cd003e6301b')}</Kbd>
              </Button>
            </div>
          </div>
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}

/**
 * Mod+S saves. The page is a document you edit, and every editor a person
 * has used saves on that chord; without it the browser offers to save the
 * HTML, which is never what anyone meant.
 */
function useSaveShortcut(onSave: () => void) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key === 's'
      ) {
        event.preventDefault();
        onSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onSave]);
}

// ─── Read-only body ────────────────────────────────────────────────────────

function ReadOnlyAgentPage({
  projectId,
  agent,
  config,
  canWrite,
  showUpgradeHint,
  isPlatform,
}: {
  projectId: string;
  agent: Agent;
  config: ProjectConfigSummary;
  canWrite: boolean;
  showUpgradeHint: boolean;
  isPlatform: boolean;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const tUpgrades = useI18nTranslations('settings.upgrades');
  // The real repo path, with any manifest anchor stripped. Agents declared in
  // the manifest rather than as their own file carry one
  // (`kortix.yaml#agents.<name>`), and reading that verbatim is a 404.
  const sourcePath = configEntitySourcePath(agent.path);
  const fileQuery = useQuery({
    queryKey: ['entity-file-content', projectId, sourcePath],
    queryFn: () => readProjectFile(projectId, sourcePath),
    staleTime: 30_000,
    // Meta's "source" is /workspace/AGENTS.md, not a repo file — reading it 404s.
    enabled: !isPlatform,
  });
  const pathname = useUiPathname();
  const section = useAgentSection(isPlatform ? PLATFORM_SECTIONS : READ_ONLY_SECTIONS);
  const triggersFull = !isPlatform && section === 'triggers';

  const source = (
    <EditorSection
      title={tI18nComplete.raw('text934652dce41d')}
      description={<span className="font-mono">{sourcePath}</span>}
      bare
    >
      <div className="bg-popover overflow-hidden rounded-md border">
        <EntityFilePane
          path={sourcePath}
          content={fileQuery.data?.content}
          isLoading={fileQuery.isLoading}
          isError={fileQuery.isError}
          error={fileQuery.error}
          onRetry={() => {
            void fileQuery.refetch();
          }}
          skeletonRows={4}
          errorTitle={tI18nComplete.raw('text2f2f540650bf')}
        />
      </div>
    </EditorSection>
  );

  return (
    <AgentPageFrame
      header={
        <AgentHeader
          projectId={projectId}
          agent={agent}
          config={config}
          canWrite={canWrite && !isPlatform}
        />
      }
      section={section}
      sections={isPlatform ? PLATFORM_SECTIONS : READ_ONLY_SECTIONS}
      sectionHref={sectionHrefFor(pathname)}
      full={triggersFull}
      pane={
        triggersFull ? (
          // The same Triggers screen as the editable page; its own controls
          // (`useTriggerControls`) decide what this reader may change.
          <TriggersPage
            projectId={projectId}
            surface={{ kind: 'agent', agentName: agent.name }}
            defaultAgent={config.default_agent ?? config.open_code_default_agent}
          />
        ) : (
        <EditorSectionStyleProvider value="panel">
          <div className="space-y-10">
            {showUpgradeHint ? (
              <InfoBanner tone="info" title={tI18nComplete.raw('textdc7ab144ca89')}>
                {tUpgrades.rich('agentEditorHint', {
                  code: (chunks) => <span className="font-mono">{chunks}</span>,
                })}
              </InfoBanner>
            ) : null}
            {section === 'overview' ? (
              <>
                <AgentHero agent={agent} config={config}>
                  {agent.description ? (
                    <p className="text-muted-foreground text-sm text-pretty">{agent.description}</p>
                  ) : null}
                </AgentHero>
                {isPlatform ? (
                  <PlatformAgentOverview projectId={projectId} config={config} />
                ) : (
                  <>
                    {source}
                    <AgentScope projectId={projectId} agentName={agent.name} scope={agent.scope} />
                  </>
                )}
              </>
            ) : section === 'people' ? (
              <AgentPeopleSection projectId={projectId} agentName={agent.name} />
            ) : section === 'actions' ? (
              <AgentAuthorityCard
                projectId={projectId}
                agentName={agent.name}
                grant={agent.scope?.kortix_permissions ?? agent.scope?.kortix_cli}
              />
            ) : (
              <div className="space-y-3">
                <AgentModel projectId={projectId} agentName={agent.name} />
                <p className="text-muted-foreground text-xs text-pretty">
                  {tI18nComplete.raw('text9dee2a1acfd9')}
                </p>
              </div>
            )}
          </div>
        </EditorSectionStyleProvider>
        )
      }
    />
  );
}
