'use client';

/**
 * /projects/[id]/agent/[name] — one agent, as a full-page editor. The core
 * screen of Customize.
 *
 * Customize is agent-centric (Marko, 2026-09-01): the agent is the only
 * object a project manager grants a person or a group, so every other
 * decision — who may use it, which model, which skills, which connectors and
 * secrets, when it runs — hangs off it. This page is built like the Settings
 * page (Marko, 2026-09-03: "make it a regular full page Agent Editor"): a
 * header, a left rail of topics, and one full-width pane per topic.
 *
 *   ┌ Agents › name                  ● Name  chips   [Start session] [⋯] ┐
 *   ├──────────────┬──────────────────────────────────────────────────────┤
 *   │ Overview     │                                                      │
 *   │ People       │   the selected topic's pane, one column,            │
 *   │ Access       │   `max-w-2xl` like the Settings page                 │
 *   │ Triggers     │                                                      │
 *   │ Model        │                                                      │
 *   │ Workspace    │                                                      │
 *   │ Tools        │                                                      │
 *   │ Basics       │                                                      │
 *   ├──────────────┴──────────────────────────────────────────────────────┤
 *   │ Unsaved changes · commits to the repo             [Discard] [Save ⌘S] │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * The rail is the Settings rail's dialect (`project-settings-page.tsx`,
 * `settings-panel.tsx`): same width, same row classes, a real `<Link>` per
 * topic so a topic has a URL (`?section=<key>`) a person can be sent to. The
 * draft is shared across topics, so switching never drops an edit, and the
 * save bar spans the page foot. Below `lg` the rail is a horizontal row.
 *
 * Two bodies behind one header:
 *
 *  - **Editable** — a v2 (kortix.yaml) project and a caller with
 *    `project.agent.write`. Every field is live; Save round-trips the whole
 *    `agents.<name>` block through the agent-config route, which commits it to
 *    the project repo. State lives in `useAgentDraft`; the panes are
 *    `AgentConfigSections` with the page's own Overview, People and Triggers
 *    slotted in.
 *  - **Read-only** — a v1 project, or a caller without write. Overview shows
 *    the agent's source file; People, Access (the legacy scope mirror),
 *    Triggers and Model (the gateway pin) remain. We degrade, never blank.
 *
 * The page is keyed on the agent name by its route, so switching agents
 * remounts every draft rather than carrying one agent's edits onto another.
 */

import { HighlightedCode } from '@/components/markdown/code';
import { MarkdownWithFrontmatter } from '@/components/markdown/markdown-frontmatter';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import { Kbd } from '@/components/ui/kbd';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { configEntitySourcePath } from '@/features/workspace/customize/sections/component/config-entity-source-path';
import {
  AGENT_CONFIG_SECTION_GROUPS,
  AGENT_CONFIG_SECTIONS,
  type AgentConfigSectionKey,
  AgentConfigSections,
  DEFAULT_AGENT_CONFIG_SECTION,
  isAgentConfigSectionKey,
  useAgentDraft,
  useAgentEditorOptions,
} from '@/features/workspace/customize/sections/view/agent-editor';
import { formatMode, toArray } from '@/features/workspace/customize/shared/utils';
import {
  editConfigPrompt,
  useConfigureThread,
} from '@/features/workspace/customize/use-configure-thread';
import { useAgentConfig, useUpdateAgentConfig } from '@/hooks/projects/use-agent-config';
import { useNewProjectSession } from '@/hooks/projects/use-new-project-session';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import {
  type AgentConfigBlock,
  getProjectDetail,
  type ProjectConfigSummary,
  readProjectFile,
  updateProjectDefaultAgent,
} from '@kortix/sdk';
import { contract, qk, useProjectAccountId } from '@kortix/sdk/react';
import { capitalizeWords } from '@kortix/shared';
import {
  BookOpenTextIcon,
  CaretRightIcon,
  CpuIcon,
  CubeIcon,
  DotsThreeIcon,
  FileTextIcon,
  type Icon,
  KeyIcon,
  PlayIcon,
  PlugsConnectedIcon,
  RobotIcon,
  SlidersHorizontalIcon,
  StarIcon,
  TerminalWindowIcon,
  TimerIcon,
  UsersIcon,
  WrenchIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, m } from 'motion/react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useState } from 'react';

import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import { SETTINGS_SIDEBAR_WIDTH_PX } from '@/features/accounts/hub/account-settings-shell';
import { capabilityTabHref } from '@/features/workspace/capabilities/shared/capability-tab-routes';
import {
  isMarkdownPath,
  languageForPath,
} from '@/features/workspace/capabilities/shared/entity/entity-files';
import { useIsMobile } from '@/hooks/utils';

import { EditorSectionStyleProvider } from '@/features/workspace/customize/sections/view/agent-editor-primitives';

import { AgentModel, AgentScope } from './agent-detail-aside';
import { ConnectorsGrantPage, SecretsGrantPage, SkillsGrantPage } from './agent-grant-pages';
import { AgentPeopleSection } from './agent-people-section';
import { AgentShareControl } from './agent-share-control';
import { AgentTriggersSection } from './agent-triggers-section';

type Agent = ProjectConfigSummary['agents'][number];

/** The rail's icons — the one place that draws them (`AGENT_CONFIG_SECTIONS`
 *  is pure data, imported by the editor module). */
const SECTION_ICON: Record<AgentConfigSectionKey, Icon> = {
  overview: FileTextIcon,
  people: UsersIcon,
  basics: SlidersHorizontalIcon,
  triggers: TimerIcon,
  skills: BookOpenTextIcon,
  connectors: PlugsConnectedIcon,
  secrets: KeyIcon,
  actions: TerminalWindowIcon,
  model: CpuIcon,
  tools: WrenchIcon,
  workspace: CubeIcon,
};

export function AgentPage({ projectId, agentName }: { projectId: string; agentName: string }) {
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

  const configQuery = useAgentConfig(projectId, agent ? agentName : undefined);

  if (detailQuery.isLoading || (agent && configQuery.isLoading)) {
    return <AgentPageSkeleton />;
  }

  if (detailQuery.isError || !config) {
    return (
      <CenteredState>
        <ErrorState
          size="sm"
          title="Couldn't load this project's agents"
          action={
            <Button variant="outline" size="sm" onClick={() => detailQuery.refetch()}>
              Retry
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
          icon={RobotIcon}
          size="sm"
          title={`No agent named ${agentName}`}
          description="It may have been renamed or removed from the project's configuration."
          action={
            <Button asChild variant="outline" size="sm">
              <Link href={capabilityTabHref(projectId, 'agent')}>All agents</Link>
            </Button>
          }
        />
      </CenteredState>
    );
  }

  const editable = canWrite && configQuery.data?.editable === true;
  const isV1 = configQuery.data !== undefined && configQuery.data.editable !== true;

  return editable ? (
    <EditableAgentPage
      projectId={projectId}
      agent={agent}
      config={config}
      initial={configQuery.data?.block ?? {}}
    />
  ) : (
    <ReadOnlyAgentPage
      projectId={projectId}
      agent={agent}
      config={config}
      canWrite={canWrite}
      showUpgradeHint={isV1}
    />
  );
}

// ─── Frame ─────────────────────────────────────────────────────────────────

/**
 * Header on top, then the rail beside the pane, then the footer. The pane is
 * the one scroller; the rail is the Settings rail
 * (`project-settings-page.tsx`), row for row.
 */
function AgentPageFrame({
  header,
  section,
  sections,
  sectionHref,
  pane,
  footer,
}: {
  header: ReactNode;
  section: AgentConfigSectionKey;
  sections: readonly AgentConfigSectionKey[];
  sectionHref: (key: AgentConfigSectionKey) => string;
  pane: ReactNode;
  footer?: ReactNode;
}) {
  const isMobile = useIsMobile();
  const items = AGENT_CONFIG_SECTIONS.filter((s) => sections.includes(s.key));
  // The Preferences rail's rule: a heading over a lone group labels nothing.
  const groups = AGENT_CONFIG_SECTION_GROUPS.map((group) => ({
    group,
    items: items.filter((s) => s.group === group),
  })).filter((g) => g.items.length > 0);
  const showGroupLabels = groups.length > 1;
  const trigger = (item: (typeof AGENT_CONFIG_SECTIONS)[number], horizontal: boolean) => {
    const SectionIcon = SECTION_ICON[item.key];
    return (
      <TabsTrigger
        key={item.key}
        value={item.key}
        asChild
        size={horizontal ? undefined : 'md'}
        className={
          horizontal
            ? 'w-auto shrink-0 gap-2.5 px-3 py-0.75 whitespace-nowrap'
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
          <span className={cn(!horizontal && 'truncate')}>{item.label}</span>
        </Link>
      </TabsTrigger>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="border-border/60 shrink-0 border-b px-5 py-3">{header}</div>
      <div
        className={cn(
          'min-h-0 flex-1',
          isMobile ? 'flex flex-col overflow-hidden' : 'grid overflow-hidden',
        )}
        style={isMobile ? undefined : { gridTemplateColumns: `${SETTINGS_SIDEBAR_WIDTH_PX}px 1fr` }}
      >
        {isMobile ? (
          <nav
            aria-label="Agent sections"
            className="border-border/60 flex h-auto shrink-0 items-center border-b"
          >
            <FadedScrollArea
              orientation="horizontal"
              fadeColor="from-background"
              className="min-w-0 flex-1 py-2"
            >
              <Tabs value={section} className="w-fit">
                <TabsList orientation="horizontal" className="w-fit gap-1 px-2">
                  {items.map((item) => trigger(item, true))}
                </TabsList>
              </Tabs>
            </FadedScrollArea>
          </nav>
        ) : (
          <aside className="flex min-h-0 flex-col border-r bg-inherit">
            <nav
              aria-label="Agent sections"
              className="flex min-h-0 flex-1 [scrollbar-width:none] flex-col gap-4 overflow-y-auto px-2 pt-3 pb-2 [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
            >
              <Tabs value={section} orientation="vertical" className="space-y-3">
                {groups.map((g) => (
                  <div key={g.group}>
                    {showGroupLabels ? (
                      <div className="text-muted-foreground flex h-7 items-center px-2.5 text-xs font-medium">
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
        )}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl px-6 py-8 pb-24 lg:py-10">{pane}</div>
        </main>
      </div>
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

function AgentPageSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="border-border/60 shrink-0 space-y-4 border-b px-5 pt-5 pb-4">
        <Skeleton className="h-4 w-32 rounded-sm" />
        <Skeleton className="h-8 w-56 rounded-sm" />
      </div>
      <div
        className="grid min-h-0 flex-1"
        style={{ gridTemplateColumns: `${SETTINGS_SIDEBAR_WIDTH_PX}px 1fr` }}
      >
        <div className="space-y-1.5 border-r px-2 pt-3">
          {Array.from({ length: 6 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder
            <Skeleton key={i} className="h-8 w-full rounded-sm" />
          ))}
        </div>
        <div className="mx-auto w-full max-w-2xl space-y-6 px-6 py-8">
          <Skeleton className="h-11 w-full rounded-md" />
          <Skeleton className="h-72 w-full rounded-md" />
        </div>
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
  const searchParams = useSearchParams();
  const fromUrl = searchParams.get('section');
  if (isAgentConfigSectionKey(fromUrl) && available.includes(fromUrl)) return fromUrl;
  return available.find((k) => k === DEFAULT_AGENT_CONFIG_SECTION) ?? available[0];
}

function sectionHrefFor(pathname: string) {
  return (key: AgentConfigSectionKey) => `${pathname}?section=${key}`;
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
  const queryClient = useQueryClient();
  const startSession = useNewProjectSession(projectId);
  const configure = useConfigureThread(projectId);
  const [confirmEditSource, setConfirmEditSource] = useState(false);
  const isDefault = config.open_code_default_agent === agent.name;
  const mode = agent.mode?.toLowerCase();
  const startBlocked =
    agent.enabled === false
      ? 'This agent is disabled.'
      : mode === 'subagent'
        ? 'Subagents are called by other agents, not started directly.'
        : null;

  const makeDefault = useMutation({
    mutationFn: () => updateProjectDefaultAgent(projectId, agent.name),
    onSuccess: async (result) => {
      successToast(`${capitalizeWords(result.default_agent)} is now the project default`);
      await queryClient.invalidateQueries({ queryKey: qk.project.detail(projectId) });
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to update default agent'),
  });

  const pathname = usePathname();
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
              Start session
            </Button>
          </span>
        </Hint>
      ) : (
        <Button size="sm" onClick={() => startSession({ create: { agent_name: agent.name } })}>
          <PlayIcon weight="fill" className="size-3.5 shrink-0" />
          Start session
        </Button>
      )}
      {canWrite ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon-sm" aria-label="More actions">
              <DotsThreeIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={isDefault || agent.enabled === false || makeDefault.isPending}
              onSelect={() => makeDefault.mutate()}
            >
              <StarIcon className="size-4" />
              {isDefault ? 'Project default' : 'Make project default'}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={configure.pending}
              onSelect={() => setConfirmEditSource(true)}
            >
              Edit source in a chat
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {/* Sending a prompt opens a whole new chat, which is a bigger commitment
          than a menu row implies — confirm first, like the entity modal did. */}
      <ConfirmDialog
        open={confirmEditSource}
        onOpenChange={setConfirmEditSource}
        title="Edit this agent's source in a chat?"
        description={`This starts a new session that edits ${agent.name}'s source file for you.`}
        confirmLabel="Start chat"
        cancelLabel="Cancel"
        onConfirm={() => {
          setConfirmEditSource(false);
          configure.start(editConfigPrompt('agent', agent.name, agent.path));
        }}
      />
    </div>
  );
}

/** The status chips beside the name. Only states worth flagging. */
function AgentChips({
  agent,
  config,
  size,
}: {
  agent: Agent;
  config: ProjectConfigSummary;
  size: 'sm' | 'xs';
}) {
  const mode = agent.mode?.toLowerCase();
  const isDefault = config.open_code_default_agent === agent.name;
  return (
    <span className="flex items-center gap-1.5">
      {mode && mode !== 'primary' ? (
        <Badge variant="outline" size={size} className="text-muted-foreground font-medium">
          {formatMode(agent.mode ?? '')}
        </Badge>
      ) : null}
      {isDefault ? (
        <Badge variant="outline" size={size} className="text-muted-foreground gap-1 font-medium">
          <StarIcon weight="fill" className="text-kortix-orange size-3 shrink-0" />
          Default
        </Badge>
      ) : null}
      {agent.enabled === false ? (
        <Badge variant="muted" size={size}>
          Disabled
        </Badge>
      ) : null}
    </span>
  );
}

/**
 * Breadcrumb, avatar, name, chips, actions — the full header at the top of
 * the document. `children` is rendered under the title; the read-only body
 * passes the description there.
 */
function AgentHeader({
  projectId,
  agent,
  config,
  canWrite,
  children,
}: {
  projectId: string;
  agent: Agent;
  config: ProjectConfigSummary;
  canWrite: boolean;
  children?: ReactNode;
}) {
  return (
    <header className="space-y-2">
      {/* One row (Marko, 2026-09-03): the breadcrumb's last crumb IS the
          title — an h1 — with the status chips beside it, and every action on
          the right. A second row for the name alone said nothing new. */}
      <div className="flex items-center justify-between gap-3">
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
          <Link
            href={capabilityTabHref(projectId, 'agent')}
            prefetch
            className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
          >
            Agents
          </Link>
          <CaretRightIcon aria-hidden className="text-muted-foreground/50 size-3.5 shrink-0" />
          <h1 className="text-foreground truncate text-sm font-semibold">
            {capitalizeWords(agent.name)}
          </h1>
          <AgentChips agent={agent} config={config} size="xs" />
        </nav>
        <AgentActions projectId={projectId} agent={agent} config={config} canWrite={canWrite} />
      </div>
      {children}
    </header>
  );
}

// ─── Editable body ─────────────────────────────────────────────────────────

const EDITABLE_SECTIONS: readonly AgentConfigSectionKey[] = AGENT_CONFIG_SECTIONS.map((s) => s.key);
/** What a v1 project, or a reader without write, can still see. */
const READ_ONLY_SECTIONS: readonly AgentConfigSectionKey[] = [
  'overview',
  'people',
  'triggers',
  'model',
];

function EditableAgentPage({
  projectId,
  agent,
  config,
  initial,
}: {
  projectId: string;
  agent: Agent;
  config: ProjectConfigSummary;
  initial: AgentConfigBlock;
}) {
  const editor = useAgentDraft(initial);
  const options = useAgentEditorOptions(projectId);
  const update = useUpdateAgentConfig(projectId, agent.name);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const skillsOptions = toArray(config.skills).map((skill) => ({
    id: skill.name,
    label: skill.name,
    description: skill.description ?? undefined,
  }));
  const pathname = usePathname();
  const section = useAgentSection(EDITABLE_SECTIONS);

  const onSave = useCallback(async () => {
    if (!editor.isDirty || update.isPending) return;
    try {
      const response = await update.mutateAsync(editor.draft);
      editor.commit(response.block ?? editor.draft);
      successToast(`${capitalizeWords(agent.name)} saved`);
    } catch (e) {
      errorToast((e as Error)?.message ?? 'Failed to save configuration');
    }
  }, [editor, update, agent.name]);

  // Rail links change only `?section=` on this same path; the guard lets those
  // through so switching topics never asks about unsaved edits — the draft is
  // shared across topics and nothing is lost.
  const leaveGuard = useUnsavedChangesGuard(editor.isDirty, pathname);
  useSaveShortcut(onSave);

  return (
    <AgentPageFrame
      header={<AgentHeader projectId={projectId} agent={agent} config={config} canWrite />}
      section={section}
      sections={EDITABLE_SECTIONS}
      sectionHref={sectionHrefFor(pathname)}
      pane={
        <AgentConfigSections
          section={section}
          editor={editor}
          options={options}
          skillsOptions={skillsOptions}
          skills={<SkillsGrantPage projectId={projectId} config={config} editor={editor} />}
          connectors={<ConnectorsGrantPage projectId={projectId} editor={editor} />}
          secrets={<SecretsGrantPage projectId={projectId} editor={editor} />}
          overview={
            <OverviewPane
              description={editor.oc.description ?? ''}
              onDescriptionChange={(next) => editor.setOc('description', next)}
              descriptionHelp={
                editor.oc.mode === 'subagent'
                  ? 'Required. This is how other agents decide to call it.'
                  : 'One line on what this agent is for. Other agents read it when picking a subagent.'
              }
              prompt={editor.oc.prompt ?? ''}
              onPromptChange={(next) => editor.setOc('prompt', next)}
            />
          }
          triggers={
            <AgentTriggersSection
              projectId={projectId}
              agentName={agent.name}
              defaultAgent={config.open_code_default_agent}
            />
          }
          people={<AgentPeopleSection projectId={projectId} agentName={agent.name} />}
        />
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
            title="Discard your changes?"
            description={`${capitalizeWords(agent.name)} keeps its saved configuration. Anything you changed here is lost.`}
            confirmLabel="Discard"
            cancelLabel="Keep editing"
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
            open={leaveGuard.pendingHref !== null}
            onOpenChange={(open) => {
              if (!open) leaveGuard.stay();
            }}
            title="Leave without saving?"
            description={`Your changes to ${capitalizeWords(agent.name)} are not saved. Leave now and they are lost.`}
            confirmLabel="Leave"
            cancelLabel="Keep editing"
            confirmVariant="destructive"
            onConfirm={leaveGuard.leave}
          />
        </>
      }
    />
  );
}

/**
 * The Overview topic — what the agent IS: one line of description and the
 * instructions, which are the agent. Two cards, in the pane's card dialect.
 */
function OverviewPane({
  description,
  onDescriptionChange,
  descriptionHelp,
  prompt,
  onPromptChange,
}: {
  description: string;
  onDescriptionChange: (next: string) => void;
  descriptionHelp: string;
  prompt: string;
  onPromptChange: (next: string) => void;
}) {
  return (
    <div className="space-y-4">
      <section className="bg-popover rounded-md border">
        <div className="border-border/60 border-b px-4 pt-4 pb-3">
          <h3 className="text-foreground text-sm font-medium">Description</h3>
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed text-pretty">
            {descriptionHelp}
          </p>
        </div>
        <div className="px-4 py-4">
          <Textarea
            aria-label="Description"
            value={description}
            placeholder="What this agent is for"
            minHeight={44}
            className="text-sm"
            onChange={(e) => onDescriptionChange(e.target.value)}
          />
        </div>
      </section>
      <InstructionsPanel value={prompt} onChange={onPromptChange} />
    </div>
  );
}

/**
 * The instructions — the agent's system prompt, and the thing that most IS
 * the agent. Two views of one field: Edit is the textarea, Preview renders
 * the markdown the way the agent's source file reads. It opens on Preview
 * when there is something to read and on Edit when there is not; the toggle
 * is a segmented pair at the section's right edge, the same control the list
 * pages use for their filters.
 */
function InstructionsPanel({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const [view, setView] = useState<'edit' | 'preview'>(value.trim() ? 'preview' : 'edit');
  return (
    <section className="bg-popover rounded-md border">
      <div className="border-border/60 flex items-end justify-between gap-3 border-b px-4 pt-4 pb-3">
        <div className="space-y-1">
          <h3 className="text-foreground text-sm font-medium">Instructions</h3>
          <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
            Told to this agent at the start of every session. Markdown. Leave empty to use the
            default instructions.
          </p>
        </div>
        <Tabs value={view} onValueChange={(next) => setView(next as 'edit' | 'preview')}>
          <TabsList aria-label="Instructions view">
            <TabsTrigger value="edit">Edit</TabsTrigger>
            <TabsTrigger value="preview">Preview</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {view === 'edit' ? (
        <div className="p-2">
          <Textarea
            aria-label="Instructions"
            value={value}
            placeholder={'You are…\n\nGoal: …\n\nSteps:\n1. …'}
            minHeight={420}
            autoFocus={value.trim().length > 0}
            className="border-0 font-mono text-xs leading-relaxed focus-visible:ring-0"
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      ) : (
        <div className="min-h-[420px] px-5 py-4">
          <MarkdownWithFrontmatter content={value} />
        </div>
      )}
    </section>
  );
}

/**
 * The save bar. Exists only while there is something to save — an always-on
 * disabled pair of buttons is chrome that never earns its row. It sits across
 * the foot of the page, outside both scrollers, so it is reachable from any
 * point in a long instruction set and from anywhere in the pane.
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
  return (
    <AnimatePresence initial={false}>
      {dirty ? (
        <m.div
          key="save-bar"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
          className="bg-background/95 border-border/60 z-10 shrink-0 border-t shadow-sm backdrop-blur"
        >
          <div className="flex w-full items-center justify-between gap-3 px-6 py-3 lg:px-10">
            <p className="text-muted-foreground min-w-0 truncate text-xs">
              <span className="text-foreground font-medium">Unsaved changes.</span> Saving commits
              to your project repo.
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="outline-ghost" size="sm" onClick={onDiscard} disabled={pending}>
                Discard
              </Button>
              <Button size="sm" onClick={onSave} disabled={pending}>
                {pending ? <Loading className="size-3.5 shrink-0" /> : null}
                Save
                <Kbd className="ml-1">⌘S</Kbd>
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

/**
 * Holds a dirty page on the page until the person decides.
 *
 * Two exits, two guards. A tab close or a reload reaches only `beforeunload`,
 * so that is armed while dirty. An in-app link — the sidebar, a tab, the
 * breadcrumb — never fires it, and the App Router has no navigation event to
 * cancel, so anchor clicks are intercepted in the capture phase instead: the
 * click is swallowed, the target href is parked, and the page asks. `leave`
 * pushes the parked href; `stay` drops it. Modified clicks (new tab) and
 * external links pass through — nothing is lost by opening a second tab.
 */
function useUnsavedChangesGuard(isDirty: boolean, currentPath?: string) {
  const router = useRouter();
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== '_self') return;
      if (anchor.origin !== window.location.origin) return;
      const href = anchor.pathname + anchor.search + anchor.hash;
      if (href === window.location.pathname + window.location.search + window.location.hash) return;
      // A link that only changes `?section=` on this page switches topic; the
      // draft survives that, so it never needs the question.
      if (currentPath && anchor.pathname === currentPath) return;
      event.preventDefault();
      event.stopPropagation();
      setPendingHref(href);
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [isDirty, currentPath]);

  return {
    pendingHref,
    stay: () => setPendingHref(null),
    leave: () => {
      const href = pendingHref;
      setPendingHref(null);
      if (href) router.push(href);
    },
  };
}

// ─── Read-only body ────────────────────────────────────────────────────────

function ReadOnlyAgentPage({
  projectId,
  agent,
  config,
  canWrite,
  showUpgradeHint,
}: {
  projectId: string;
  agent: Agent;
  config: ProjectConfigSummary;
  canWrite: boolean;
  showUpgradeHint: boolean;
}) {
  // The real repo path, with any manifest anchor stripped. Agents declared in
  // the manifest rather than as their own file carry one
  // (`kortix.yaml#agents.<name>`), and reading that verbatim is a 404.
  const sourcePath = configEntitySourcePath(agent.path);
  const fileQuery = useQuery({
    queryKey: ['entity-file-content', projectId, sourcePath],
    queryFn: () => readProjectFile(projectId, sourcePath),
    staleTime: 30_000,
  });
  const pathname = usePathname();
  const section = useAgentSection(READ_ONLY_SECTIONS);

  const source = (
    <section className="bg-popover rounded-md border">
      <div className="border-border/60 border-b px-4 pt-4 pb-3">
        <h3 className="text-foreground text-sm font-medium">Instructions</h3>
        <p className="text-muted-foreground mt-1 text-xs">
          <span className="font-mono">{sourcePath}</span>
        </p>
      </div>
      {fileQuery.isLoading ? (
        <div className="space-y-2.5 p-4">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-10/12" />
          <Skeleton className="h-4 w-9/12" />
        </div>
      ) : fileQuery.isError ? (
        <div className="p-4">
          <ErrorState
            size="sm"
            title="Couldn't load the source"
            description={
              fileQuery.error instanceof Error
                ? fileQuery.error.message
                : 'You may not have permission to read this file.'
            }
            action={
              <Button variant="outline" size="sm" onClick={() => fileQuery.refetch()}>
                Retry
              </Button>
            }
          />
        </div>
      ) : isMarkdownPath(sourcePath) ? (
        <div className="p-4">
          <MarkdownWithFrontmatter content={fileQuery.data?.content ?? ''} />
        </div>
      ) : (
        <pre
          className={cn(
            'overflow-x-auto p-4',
            'text-foreground font-mono text-sm leading-[1.65]',
            '[&_code]:border-none [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit',
            '[&_.shiki]:!bg-transparent [&_span]:border-none [&_span]:!bg-transparent [&_span]:outline-none',
          )}
        >
          <HighlightedCode
            code={fileQuery.data?.content ?? ''}
            language={languageForPath(sourcePath)}
          />
        </pre>
      )}
    </section>
  );

  return (
    <AgentPageFrame
      header={
        <AgentHeader projectId={projectId} agent={agent} config={config} canWrite={canWrite}>
          {agent.description ? (
            <p className="text-muted-foreground max-w-2xl text-sm text-pretty">
              {agent.description}
            </p>
          ) : null}
        </AgentHeader>
      }
      section={section}
      sections={READ_ONLY_SECTIONS}
      sectionHref={sectionHrefFor(pathname)}
      pane={
        <EditorSectionStyleProvider value="panel">
          <div className="space-y-4">
            {showUpgradeHint ? (
              <InfoBanner tone="info" title="Upgrade for the full agent editor">
                This project uses a v1 manifest. Migrate to{' '}
                <span className="font-mono">kortix.yaml</span> (kortix_version 2) to edit this
                agent's instructions, model, tool permissions and access here.
              </InfoBanner>
            ) : null}
            {section === 'overview' ? (
              <>
                {source}
                <AgentScope projectId={projectId} agentName={agent.name} scope={agent.scope} />
              </>
            ) : section === 'people' ? (
              <AgentPeopleSection projectId={projectId} agentName={agent.name} />
            ) : section === 'triggers' ? (
              <AgentTriggersSection
                projectId={projectId}
                agentName={agent.name}
                defaultAgent={config.open_code_default_agent}
              />
            ) : (
              <div className="space-y-4">
                <AgentModel projectId={projectId} agentName={agent.name} />
                <p className="text-muted-foreground text-xs text-pretty">
                  The model this agent runs on is set in its source file. With the model gateway on,
                  a per-agent pin can override it above.
                </p>
              </div>
            )}
          </div>
        </EditorSectionStyleProvider>
      }
    />
  );
}
