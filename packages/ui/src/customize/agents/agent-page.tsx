'use client';

import { MY_KORTIX_AGENT_NAME } from '@kortix/shared';
import { adminPath } from '../../lib/routes';

/**
 * /workspaces/[id]/customize/agents/[name]: one agent, as a page with a rail.
 *
 * Customize is agent-first. My Kortix is the one agent a person talks to; every
 * other agent is a work product with only the access its work needs. So the
 * page is the agent: one identity header, one rail, and room to edit.
 *
 *   ┌ Agents › ▣ Researcher  Default  [Share] [Call] [Start session] [⋯] ┐
 *   ├ General      ┬ the row's content, one centered column              ┤
 *   │  Overview    │                                                     │
 *   │  Basics      │                                                     │
 *   │  People      │                                                     │
 *   │  Triggers    │                                                     │
 *   │ Access       │                                                     │
 *   │  Skills …    │                                                     │
 *   │ Runtime      │                                                     │
 *   │  Model …     │                                                     │
 *   └────────────────── [ ● Unsaved changes  Skills  Discard  Save ⌘S ]
 *
 * The URL names the tab and its view (`agent-tabs.ts`); every old
 * `?section=` link still resolves. The rail (2026-11-03, the Settings-style
 * rail is back) lists every view as its own row under three group labels:
 * General, Access, Runtime. People opens the Share dialog. A view renders the full resource screen in agent
 * scope (one component, two variants), embedded without its own title
 * (`CapabilityShellEmbedProvider`).
 *
 * The draft is shared across rows, so a row switch never drops an edit; the
 * row with an edit carries a dot, and the save bar names the changed rows. A
 * link off the page while dirty asks Stay / Leave / Save and leave.
 *
 * Two bodies under one frame:
 *  - **Editable**: a v2+ project and a caller with `project.agent.write`.
 *    Save round-trips the whole `agents.<name>` block through the agent-config
 *    route, which commits it to the project repo.
 *  - **Read-only**: a v1 project or a caller without write. The same tabs and
 *    the same Overview, with values in place of controls and a lock banner.
 * My Kortix (a platform agent) has no page here: the project home starts it,
 * and its route reads as not found.
 *
 * The page is keyed on the agent name by its route, so switching agents
 * remounts every draft.
 */

import {
  type AgentConfigBlock,
  type AgentGrantSetV2,
  getProjectDetail,
  listProjectResourceGrants,
  type ProjectConfigSummary,
  readProjectFile,
} from '@kortix/sdk';
import { contract, qk, useFeatureFlag, useProjectAccountId, useUnifiedTriggers } from '@kortix/sdk/react';
import { DotsThreeIcon, LockSimpleIcon, PlayIcon, StarIcon, TrashIcon } from '@phosphor-icons/react';
import { Badge } from '../../primitives/badge';
import { useQueries, useQuery } from '@tanstack/react-query';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

import { useLocale, useTranslations as useI18nTranslations } from '../../i18n';
import { AgentMark, agentDisplayName } from '../../internal/components/agent-mark';
import { useAgentConfig, useUpdateAgentConfig } from '../../internal/hooks/projects/use-agent-config';
import { useNewProjectSession } from '../../internal/hooks/projects/use-new-project-session';
import { AgentCallButton } from '../../session/voice/voice-call';
import { agentHref, capabilityTabHref } from '../../internal/lib/capability-tab-routes';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectCan } from '../../internal/lib/use-project-can';
import { Button } from '../../primitives/button';
import { ConfirmDialog } from '../../primitives/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../primitives/dropdown-menu';
import { EmptyState } from '../../primitives/empty-state';
import { ErrorState } from '../../primitives/error-state';
import Hint from '../../primitives/hint';
import { InfoBanner } from '../../primitives/info-banner';
import { errorToast, successToast } from '../../primitives/toast';
import { UiLink as Link, useUiPathname, useUiRouter, useUiSearchParams } from '../../providers/ui-provider';
import { configEntitySourcePath } from '../sections/component/config-entity-source-path';
import {
  type AgentConfigSectionKey,
  AGENT_CONFIG_SECTIONS,
  AgentConfigSections,
  agentEditorOptionQueries,
  registryGrantOptions,
  useAgentDraft,
  useAgentEditorOptions,
  useLocalizedAgentConfigCatalog,
} from '../sections/view/agent-editor';
import { EditorSectionStyleProvider } from '../sections/view/agent-editor-primitives';
import { ToolsSection } from '../sections/view/permission-editor';
import { type AgentGrant, useAgentGrant } from '../shared/agent-resource-scope';
import { CapabilityShellEmbedProvider } from '../shared/capability-page-shell';
import { LeaveGuardProvider, useUnsavedChangesGuard } from '../shared/leave-guard';
import { toArray } from '../shared/utils';
import { ExtensionsPage, SkillsPage, ToolsPage } from '../skills/skills-page';
import { ConnectorsPage } from '../connectors/connectors-page';
import { SecretsPage } from '../secrets/secrets-page';
import { TriggersPage } from '../triggers/triggers-page';
import { editConfigPrompt, useConfigureThread } from '../use-configure-thread';
import { AgentAuthorityCard } from './agent-authority-card';
import { AgentModel, AgentScope } from './agent-detail-aside';
import { AgentDrivesSection } from './agent-drives-section';
import { pruneRequiredConnectors } from './connectors-required';
import { AgentOverview, type OverviewFacts } from './agent-overview';
import {
  AgentBreadcrumbHeader,
  AgentPageSkeleton,
  AgentRail,
  type AgentRailGroup,
  type AgentRailItem,
  AgentStatePage,
  AgentTabBody,
  LeaveDialog,
  SaveBar,
} from './agent-page-chrome';
import { AgentModelView } from './agent-model-view';
import { AgentApprovalRules } from './agent-approval-rules';
import { AgentPinButton } from './agent-pin-button';
import { AgentShareControl } from './agent-share-control';
import {
  ACCESS_VIEWS,
  AGENT_TABS,
  type AgentLocation,
  type AgentTab,
  agentLocationHref,
  changedItems,
  closestAgentName,
  resolveAgentLocation,
  railKeyOf,
  sectionLocationHref,
} from './agent-tabs';
import { useSpacesEnabled } from '../../internal/lib/space-scope';
import { connectorPolicySetOptions } from './agent-policy-sets';
import { AgentPolicySetsPanel, useAgentPolicySetControls } from './agent-policy-sets-section';
import { useDefaultAgent } from './use-default-agent';

/**
 * A host's Apps screen in agent mode: the ONE Apps component (it lives in
 * the host app) with this agent's grant. Without it Access → Apps is hidden.
 */
export type RenderAgentApps = (args: { agentName: string; grant: AgentGrant; needsAppRead: boolean }) => ReactNode;

type Agent = ProjectConfigSummary['agents'][number];

export function AgentPage({
  projectId,
  agentName,
  renderApps,
}: {
  projectId: string;
  agentName: string;
  renderApps?: RenderAgentApps;
}) {
  const t = useI18nTranslations('agentEditor.tabs');
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const accountId = useProjectAccountId(projectId);
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_AGENT_WRITE, { accountId }).allowed === true;

  const detailQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
  });
  const config = detailQuery.data?.config ?? null;
  // A platform agent (My Kortix) has nothing to edit here: not found.
  const agent = toArray(config?.agents).find((a) => a.name === agentName && !a.platform) ?? null;

  // Every read starts on the first render, in parallel: the skeleton lasts as
  // long as the slowest single read, not three in a row.
  const configQuery = useAgentConfig(projectId, agentName);
  const editorOptionQueries = agentEditorOptionQueries(projectId);
  useQueries({
    queries: [editorOptionQueries.secrets, editorOptionQueries.connectors, editorOptionQueries.sandboxes].map(
      (query) => ({ ...query, enabled: canWrite }),
    ),
  });

  if (detailQuery.isLoading || (agent && configQuery.isLoading)) {
    return <AgentPageSkeleton />;
  }

  const retry = (
    <Button variant="outline" size="sm" onClick={() => void detailQuery.refetch()}>
      {tI18nComplete.raw('text942087cc2d41')}
    </Button>
  );

  if (detailQuery.isError || !config) {
    return (
      <AgentStatePage title={agentDisplayName(agentName)}>
        <ErrorState
          size="sm"
          title={t('loadError')}
          description={<ErrorDetails error={detailQuery.error} />}
          action={retry}
        />
      </AgentStatePage>
    );
  }

  if (!agent) {
    // Only agents this page opens: a platform agent (My Kortix) is not found here either.
    const suggestion = closestAgentName(
      agentName,
      toArray(config.agents)
        .filter((a) => !a.platform)
        .map((a) => a.name),
    );
    return (
      <AgentStatePage title={t('notFoundHeader')}>
        <EmptyState
          size="sm"
          title={t('notFoundTitle')}
          description={
            <span className="space-y-1">
              <span className="block">
                {t.rich('notFoundBody', { name: () => <span className="font-mono">{agentName}</span> })}
              </span>
              {suggestion ? (
                <span className="block">
                  {t.rich('didYouMean', {
                    link: () => (
                      <Link
                        href={agentHref(projectId, suggestion)}
                        className="text-foreground underline underline-offset-4"
                      >
                        {agentDisplayName(suggestion)}
                      </Link>
                    ),
                  })}
                </span>
              ) : null}
            </span>
          }
          action={
            <Button asChild variant="outline" size="sm">
              <Link href={capabilityTabHref(projectId, 'agent')}>{t('allAgents')}</Link>
            </Button>
          }
        />
      </AgentStatePage>
    );
  }

  // A writer whose agent-config read failed would otherwise land on the
  // read-only page with no word on why: say what failed, offer the retry.
  if (canWrite && configQuery.isError) {
    return (
      <AgentStatePage title={agentDisplayName(agent.name)}>
        <ErrorState
          size="sm"
          title={t('configLoadError', { name: agentDisplayName(agent.name) })}
          description={<ErrorDetails error={configQuery.error} />}
          action={
            <Button variant="outline" size="sm" onClick={() => void configQuery.refetch()}>
              {tI18nComplete.raw('text942087cc2d41')}
            </Button>
          }
        />
      </AgentStatePage>
    );
  }

  const editable = canWrite && configQuery.data?.editable === true;
  return editable ? (
    <EditableAgentPage
      projectId={projectId}
      agent={agent}
      config={config}
      initial={configQuery.data?.block ?? {}}
      renderApps={renderApps}
    />
  ) : (
    <ReadOnlyAgentPage
      projectId={projectId}
      agent={agent}
      config={config}
      block={configQuery.data?.block ?? blockFromScope(agent)}
      canWrite={canWrite}
    />
  );
}

/** The raw failure, folded, in mono. No fold when there is nothing to show. */
function ErrorDetails({ error }: { error: unknown }) {
  const t = useI18nTranslations('agentEditor.tabs');
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (!message) return null;
  return (
    <details className="mt-2 text-left">
      <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs transition-colors">
        {t('details')}
      </summary>
      <p className="text-muted-foreground mt-2 font-mono text-xs break-words">{message}</p>
    </details>
  );
}

/** The block a reader sees when the agent-config read returned nothing. */
function blockFromScope(agent: Agent): AgentConfigBlock {
  const scope = agent.scope;
  return {
    enabled: agent.enabled,
    space: agent.space ?? undefined,
    sandbox: agent.sandbox ?? undefined,
    connectors: scope?.connectors,
    secrets: scope?.env,
    apps: scope?.apps,
    kortix_permissions: scope?.kortix_permissions ?? scope?.kortix_cli,
    behavior: {
      description: agent.description ?? undefined,
      model: agent.model ?? undefined,
      mode: (agent.mode as 'primary' | 'subagent' | 'all' | null) ?? undefined,
      hidden: agent.hidden,
    },
  };
}

// ─── Shared hooks ────────────────────────────────────────────────────────────

/** Whether the caller may share the agent: the rail's People row needs it. */
function useCanManageMembers(projectId: string): boolean {
  const accountId = useProjectAccountId(projectId);
  return useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE, { accountId }).allowed === true;
}

function useAgentLocation(tabs: readonly AgentTab[], views: readonly AgentConfigSectionKey[]): AgentLocation {
  const params = useUiSearchParams();
  return resolveAgentLocation(
    { tab: params.get('tab'), view: params.get('view'), section: params.get('section') },
    tabs,
    views,
  );
}

/** How many triggers start this agent (kortix.yaml and runtime), and how
 *  many grants name it. `GET /triggers/all` leaves out what the caller may not read. */
function useAgentUseCounts(projectId: string, agentName: string, config: ProjectConfigSummary) {
  const accountId = useProjectAccountId(projectId);
  const canManageMembers =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE, { accountId }).allowed === true;
  const triggers = useUnifiedTriggers(projectId);
  const grants = useQuery({
    queryKey: qk.project.resourceGrants(projectId),
    queryFn: () => listProjectResourceGrants(projectId),
    enabled: canManageMembers,
    retry: false,
    ...contract('inventory'),
  });
  // A trigger stored as `default` starts the project's default agent.
  const fallback = config.default_agent ?? null;
  return {
    triggerCount: triggers.data
      ? triggers.data.triggers.filter(
          (a) => a.target.kind === 'agent' && (a.target.agent === 'default' && fallback ? fallback : a.target.agent) === agentName,
        ).length
      : undefined,
    peopleCount: grants.data
      ? grants.data.grants.filter((g) => g.resource_type === 'agent' && g.resource_id === agentName).length
      : undefined,
  };
}

/** The Overview's catalog totals and the connectors that need a sign-in. */
function useOverviewFacts(
  projectId: string,
  agentName: string,
  config: ProjectConfigSummary,
  block: AgentConfigBlock,
): OverviewFacts {
  const queries = agentEditorOptionQueries(projectId);
  const connectors = useQuery(queries.connectors);
  const secrets = useQuery(queries.secrets);
  const counts = useAgentUseCounts(projectId, agentName, config);
  const all = connectors.data?.connectors ?? [];
  const granted = block.connectors;
  const needsSignIn = all
    .filter((c) => c.status === 'needs_auth' && (granted === 'all' || (Array.isArray(granted) && granted.includes(c.slug))))
    .map((c) => c.slug);
  const secretIds = new Set((secrets.data?.items ?? []).map((s) => s.identifier));
  return {
    totals: {
      skills: toArray(config.skills).length,
      ...(connectors.data ? { connectors: all.length } : {}),
      ...(secrets.data ? { secrets: secretIds.size } : {}),
    },
    needsSignIn,
    ...counts,
  };
}

/**
 * The breadcrumb's badges beside the name: only states worth flagging.
 * Default, Off, and how it starts when a person cannot start it alone.
 */
function HeaderBadges({ agent, config, block }: { agent: Agent; config: ProjectConfigSummary; block: AgentConfigBlock }) {
  const t = useI18nTranslations('agentEditor.tabs');
  const tPage = useI18nTranslations('agentEditor.page');
  const enabled = block.enabled !== false;
  const mode = (block.behavior?.mode ?? agent.mode ?? 'primary').toLowerCase();
  const isDefault = config.default_agent === agent.name;
  return (
    <>
      {isDefault ? (
        <Badge variant="secondary" size="xs">
          {tPage('default')}
        </Badge>
      ) : null}
      {mode === 'subagent' ? (
        <Badge variant="muted" size="xs">
          {t('startSubagent')}
        </Badge>
      ) : null}
      {!enabled ? (
        <Badge variant="muted" size="xs">
          {t('off')}
        </Badge>
      ) : null}
    </>
  );
}

interface ShareState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

/**
 * The header's Share dialog. The old `?tab=people` link opens it; closing it
 * drops that query, so a reload or a later tab click does not reopen it.
 */
function useShareDialog(openedByLink: boolean): ShareState {
  const pathname = useUiPathname();
  const router = useUiRouter();
  const [open, setOpenState] = useState(openedByLink);
  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      if (!next && openedByLink) router.replace(pathname);
    },
    [openedByLink, router, pathname],
  );
  return { open, setOpen };
}

/**
 * Mod+S saves the agent, only while the draft holds an edit. With nothing to
 * save the key keeps the browser's own behavior. A key pressed inside an open
 * dialog (an embedded screen's own editor, the secret form) belongs to that
 * dialog, never to the agent's draft.
 */
function useSaveShortcut(dirty: boolean, onSave: () => void) {
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key !== 's') return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[role="dialog"], [role="alertdialog"]')) return;
      event.preventDefault();
      onSave();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dirty, onSave]);
}

/**
 * The rail's rows. Overview, Basics, People and Triggers are General; every
 * grant is Access; Model, Tools and Workspace are Runtime. Each row carries
 * the URL of its tab and view (`agent-tabs.ts`), so a row is a link a person
 * can be sent to. People opens the Share dialog, and only for a caller who
 * may manage members (`onPeople`).
 */
function useRailGroups(
  pathname: string,
  views: readonly AgentConfigSectionKey[],
  counts: { triggerCount?: number },
  onPeople?: () => void,
): AgentRailGroup[] {
  const t = useI18nTranslations('agentEditor.tabs');
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const catalog = useLocalizedAgentConfigCatalog();
  const labelOf = (key: AgentConfigSectionKey) =>
    key === 'subagents'
      ? tI18nComplete.raw('agentsListSubagentsTitle')
      : (catalog.sections.find((s) => s.key === key)?.label ?? key);
  const viewRows = (keys: readonly AgentConfigSectionKey[]): AgentRailItem[] =>
    keys
      .filter((key) => views.includes(key))
      .map((key) => ({ key, label: labelOf(key), href: sectionLocationHref(pathname, key) }));
  const [general, access, runtime] = catalog.groups;
  return [
    {
      key: 'general',
      label: general,
      items: [
        { key: 'overview', label: t('tabOverview'), href: agentLocationHref(pathname, 'overview') },
        { key: 'basics', label: labelOf('basics'), href: agentLocationHref(pathname, 'basics') },
        ...(onPeople ? [{ key: 'people' as const, label: labelOf('people'), href: pathname, onSelect: onPeople }] : []),
        {
          key: 'triggers',
          label: t('tabTriggers'),
          href: agentLocationHref(pathname, 'triggers'),
          count: counts.triggerCount || undefined,
        },
      ],
    },
    { key: 'access', label: access, items: viewRows(RAIL_ACCESS) },
    { key: 'runtime', label: runtime, items: viewRows(['model', 'tools', 'workspace']) },
  ];
}

/** The Access rows in rail order. Tools sits under Runtime on the rail. */
const RAIL_ACCESS = [
  'skills',
  'subagents',
  'commands',
  'extensions',
  'connectors',
  'secrets',
  'apps',
  'actions',
  'drives',
] as const satisfies readonly AgentConfigSectionKey[];

/** The rail beside the one scroller. */
function RailLayout({ rail, children }: { rail: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      {rail}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

// ─── Header actions ──────────────────────────────────────────────────────────

/**
 * Share, Call, Start session, and the ⋯ menu. Share renders for everyone and gates
 * itself on `project.members.manage`. The ⋯ menu needs `project.agent.write`.
 * Call (behind the project's `voice_call` flag) starts a session on this agent
 * with its call open, so it is offered only where Start session is.
 * Start session boots a session
 * on THIS agent through the sidebar's New session hook. A subagent is called
 * by other agents, never picked for a session, so its button is disabled with
 * the reason. Below `sm` Start session is an icon button.
 */
function AgentActions({
  projectId,
  agent,
  config,
  canWrite,
  share,
}: {
  projectId: string;
  agent: Agent;
  config: ProjectConfigSummary;
  canWrite: boolean;
  /** The Share dialog, owned by the page so the Overview can open it too. */
  share: ShareState;
}) {
  const t = useI18nTranslations('agentEditor.tabs');
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const startSession = useNewProjectSession(projectId);
  const configure = useConfigureThread(projectId);
  const makeDefault = useDefaultAgent(projectId);
  const [confirm, setConfirm] = useState<'edit' | 'delete' | null>(null);
  const isDefault = config.default_agent === agent.name;
  const mode = agent.mode?.toLowerCase();
  const startBlocked =
    agent.enabled === false
      ? t('startDisabled')
      : mode === 'subagent'
        ? t('startSubagentBlocked')
        : null;
  const startLabel = tI18nComplete.raw('textb1c52ee3677d');
  const start = (
    <>
      <Button
        size="sm"
        disabled={startBlocked !== null}
        onClick={() => startSession({ create: { agent_name: agent.name } })}
        className="hidden sm:inline-flex"
      >
        <PlayIcon weight="fill" className="size-3.5 shrink-0" />
        {startLabel}
      </Button>
      <Button
        size="icon-base"
        aria-label={startLabel}
        disabled={startBlocked !== null}
        onClick={() => startSession({ create: { agent_name: agent.name } })}
        className="sm:hidden"
      >
        <PlayIcon weight="fill" className="size-3.5" />
      </Button>
    </>
  );

  return (
    <>
      <AgentPinButton projectId={projectId} agent={agent.name} />
      <AgentShareControl projectId={projectId} agentName={agent.name} open={share.open} onOpenChange={share.setOpen} />
      {/* A call starts its own session on this agent, so it is offered where Start session is. */}
      {startBlocked ? null : <AgentCallButton projectId={projectId} agentName={agent.name} />}
      {startBlocked ? (
        <Hint label={startBlocked}>
          <span className="inline-flex">{start}</span>
        </Hint>
      ) : (
        start
      )}
      {canWrite ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-base" aria-label={tI18nComplete.raw('textf8d46c2570e7')}>
              <DotsThreeIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={isDefault || agent.enabled === false || makeDefault.isPending}
              onSelect={() => makeDefault.mutate(agent.name)}
            >
              <StarIcon className="size-4" />
              {isDefault ? tI18nComplete.raw('texte8cb80e5c5cb') : tI18nComplete.raw('texte8f43f910a4e')}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={configure.pending} onSelect={() => setConfirm('edit')}>
              <AgentMark slug={MY_KORTIX_AGENT_NAME} />
              {t('askToEditAgent')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" disabled={configure.pending} onSelect={() => setConfirm('delete')}>
              <TrashIcon className="size-4" />
              {t('deleteAgent', { name: agentDisplayName(agent.name) })}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {/* Both open a new chat with My Kortix, which proposes the change as a
          change request. A new chat is a bigger step than a menu row, so ask. */}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => (open ? undefined : setConfirm(null))}
        title={confirm === 'delete' ? t('deleteTitle', { name: agentDisplayName(agent.name) }) : tI18nComplete.raw('text24ba36a8ec86')}
        description={
          confirm === 'delete'
            ? t('deleteBody')
            : tI18nComplete('text13324ae62b23', { value0: agent.name })
        }
        confirmLabel={tI18nComplete.raw('text0bce1a892dec')}
        cancelLabel={tI18nComplete.raw('text19766ed6ccb2')}
        confirmVariant={confirm === 'delete' ? 'destructive' : 'default'}
        onConfirm={() => {
          const kind = confirm;
          setConfirm(null);
          configure.start(
            kind === 'delete'
              ? t('deletePrompt', { name: agent.name, path: agent.path })
              : editConfigPrompt('agent', agent.name, agent.path),
          );
        }}
      />
    </>
  );
}

/**
 * The one column every Access and Runtime view sits in, embedded resource
 * screen or settings form alike: the same width, the same top offset.
 * Triggers is not a view: it keeps the full width its list
 * and detail split needs.
 */
/** A view beside the Capabilities or Access rail, centered in the space right of the rail. */
const RAIL_COLUMN = 'mx-auto max-w-3xl';
/** A one-view tab (Workspace, Model): centered, the Overview's column. */
const CENTER_COLUMN = 'mx-auto max-w-3xl';

/** Frames a full resource screen in agent scope, with `lead` atop its scroller. */
function Embedded({
  agentName,
  lead,
  column,
  children,
}: {
  agentName: string;
  lead?: ReactNode;
  /** The view column (`RAIL_COLUMN`); omitted for Triggers. */
  column?: string;
  children: ReactNode;
}) {
  return (
    // A view in a column sits beside the rail, which names no view: the screen shows its own title.
    <CapabilityShellEmbedProvider value={{ agentName, lead, className: column, titled: column !== undefined }}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
    </CapabilityShellEmbedProvider>
  );
}

/** Runtime > Model's one way out to the project-wide model screens. */
function ProjectModelsLink({ projectId }: { projectId: string }) {
  const t = useI18nTranslations('agentEditor.tabs');
  return (
    <p className="text-muted-foreground text-sm text-pretty">
      {t.rich('projectModelsLink', {
        link: (chunks) => (
          <Link
            href={adminPath(projectId, 'models')}
            className="text-foreground decoration-border hover:decoration-foreground underline underline-offset-4 transition-colors"
          >
            {chunks}
          </Link>
        ),
      })}
    </p>
  );
}

// ─── Editable body ───────────────────────────────────────────────────────────

function EditableAgentPage({
  projectId,
  agent,
  config,
  initial,
  renderApps,
}: {
  projectId: string;
  agent: Agent;
  config: ProjectConfigSummary;
  initial: AgentConfigBlock;
  renderApps?: RenderAgentApps;
}) {
  const tCapabilities = useI18nTranslations('agentCapabilities');
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const locale = useLocale();
  const editor = useAgentDraft(initial);
  const options = useAgentEditorOptions(projectId);
  const update = useUpdateAgentConfig(projectId, agent.name);
  const configure = useConfigureThread(projectId);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const pathname = useUiPathname();
  const drivesOn = useFeatureFlag(projectId, 'drives').enabled;
  const views = useMemo<AgentConfigSectionKey[]>(
    () => AGENT_CONFIG_SECTIONS.map((s) => s.key).filter((k) => drivesOn || k !== 'drives'),
    [drivesOn],
  );
  const location = useAgentLocation(AGENT_TABS, views);
  const share = useShareDialog(location.open === 'share');
  const registryOptions = useMemo(
    () => registryGrantOptions({ manifest_raw: config.manifest_raw, agents: toArray(config.agents) }, agent.name),
    [config.manifest_raw, config.agents, agent.name],
  );
  const skillsOptions = toArray(config.skills).map((skill) => ({
    id: skill.name,
    label: skill.name,
    description: skill.description ?? undefined,
  }));
  const policySetOptions = useMemo(
    () => connectorPolicySetOptions(config.manifest_raw),
    [config.manifest_raw],
  );
  const policySetControl = useAgentPolicySetControls(projectId, editor, policySetOptions);
  const surface = { kind: 'agent', agentName: agent.name } as const;
  const defaultAgent = config.default_agent;
  const name = agentDisplayName(agent.name);
  const sourcePath = editor.draft.file ?? configEntitySourcePath(agent.path);

  const { draft, set } = editor;
  const connectorsGrant = useAgentGrant(draft.connectors, (v) => {
    set('connectors', v);
    // `connectors_required` is no longer enforced: keep it inside the grant.
    const kept = pruneRequiredConnectors(draft.connectors_required, v);
    if (kept !== draft.connectors_required) set('connectors_required', kept);
  });
  const secretsGrant = useAgentGrant(draft.secrets, (v) => set('secrets', v));
  const appsGrant = useAgentGrant(draft.apps, (v) => set('apps', v));

  const facts = useOverviewFacts(projectId, agent.name, config, draft);
  const spacesOn = useSpacesEnabled(projectId);

  const onSave = useCallback(async (): Promise<boolean> => {
    if (!editor.isDirty || update.isPending) return !editor.isDirty;
    try {
      const response = await update.mutateAsync(editor.draft);
      editor.commit(response.block ?? editor.draft);
      successToast(tI18nComplete('text6b0bbffdbd6e', { value0: name }));
      return true;
    } catch (e) {
      errorToast((e as Error)?.message ?? tI18nComplete.raw('text166442c65e8e'));
      return false;
    }
  }, [editor, update, name, tI18nComplete]);
  const saveNow = useCallback(() => void onSave(), [onSave]);

  // Tab links change only the query on this path: the draft survives them, so
  // the guard lets them through.
  const leaveGuard = useUnsavedChangesGuard(editor.isDirty, pathname);
  useSaveShortcut(editor.isDirty, saveNow);

  const canManageMembers = useCanManageMembers(projectId);
  const railGroups = useRailGroups(pathname, views, facts, canManageMembers ? () => share.setOpen(true) : undefined);
  const railItems = railGroups.flatMap((group) => group.items);
  const dirtyItems = useMemo(() => changedItems(editor.draft, editor.baseline), [editor.draft, editor.baseline]);
  const changed = new Intl.ListFormat(locale, { type: 'conjunction' }).format(
    dirtyItems.map((key) => railItems.find((item) => item.key === key)?.label ?? key),
  );

  const editorSection = (view: AgentConfigSectionKey) => (
    <AgentConfigSections
      section={view}
      editor={editor}
      options={options}
      skillsOptions={skillsOptions}
      registryOptions={registryOptions}
      apps={null}
      drives={
        <AgentDrivesSection
          projectId={projectId}
          agentName={agent.name}
          repositoryAccess={draft.repository_access !== false}
        />
      }
      sectionStyle="tab"
    />
  );

  const body = (() => {
    const view = location.view;
    switch (location.tab) {
      case 'basics':
        return (
          <AgentTabBody>
            <AgentOverview
              part="basics"
              agent={agent}
              config={config}
              block={draft}
              prompt={editor.oc.prompt ?? ''}
              editor={editor}
              sourcePath={sourcePath}
              showSpace={spacesOn}
            />
          </AgentTabBody>
        );
      case 'overview':
        return (
          <AgentTabBody>
            <AgentOverview
              agent={agent}
              config={config}
              block={draft}
              prompt={editor.oc.prompt ?? ''}
              editor={editor}
              sourcePath={sourcePath}
              showSpace={spacesOn}
              onAskMyKortix={() => configure.start(editConfigPrompt('agent', agent.name, agent.path))}
              focusInstructions={location.open === 'instructions'}
            />
          </AgentTabBody>
        );
      case 'access':
      case 'runtime': {
        if (!view) return null;
        // Every Access view is the ONE component Project admin shows for the
        // same library, in agent mode: the agent's grant row and a switch per
        // item over the project's catalog (Marko, 2026-10-27).
        if (view === 'skills' || view === 'tools' || view === 'extensions') {
          const Page = view === 'skills' ? SkillsPage : view === 'tools' ? ToolsPage : ExtensionsPage;
          return (
            <Embedded agentName={agent.name} column={RAIL_COLUMN}>
              <Page
                projectId={projectId}
                agent={{ name: agent.name, editor }}
                footer={
                  view === 'tools' ? (
                    <AgentApprovalRules
                      projectId={projectId}
                      editor={editor}
                      rules={
                        <EditorSectionStyleProvider value="panel">
                          <ToolsSection
                            permission={editor.oc.permission}
                            onChange={(next) => editor.setOc('permission', next)}
                            title={tCapabilities('rulesTitle')}
                          />
                        </EditorSectionStyleProvider>
                      }
                    />
                  ) : undefined
                }
              />
            </Embedded>
          );
        }
        if (view === 'connectors')
          return (
            <Embedded agentName={agent.name} column={RAIL_COLUMN}>
              <ConnectorsPage
                projectId={projectId}
                surface={surface}
                grant={connectorsGrant}
                rowControl={policySetControl}
                agentPanel={
                  <>
                    <AgentPolicySetsPanel projectId={projectId} editor={editor} catalog={policySetOptions} unlistedOnly />
                    <RequiredConnectorsNote names={draft.connectors_required} />
                  </>
                }
              />
            </Embedded>
          );
        if (view === 'secrets')
          return (
            <Embedded agentName={agent.name} column={RAIL_COLUMN}>
              <SecretsPage projectId={projectId} surface={surface} grant={secretsGrant} />
            </Embedded>
          );
        if (view === 'apps' && renderApps)
          return (
            <Embedded agentName={agent.name} column={RAIL_COLUMN}>
              {renderApps({ agentName: agent.name, grant: appsGrant, needsAppRead: !grantsAppRead(draft.kortix_permissions ?? draft.kortix_cli) })}
            </Embedded>
          );
        if (view === 'drives')
          return (
            <Embedded agentName={agent.name} column={RAIL_COLUMN}>
              <AgentDrivesSection projectId={projectId} agentName={agent.name} repositoryAccess={draft.repository_access !== false} />
            </Embedded>
          );
        // Model is this agent's model only. The project-wide gateway screens
        // (providers, routing, costs, logs) live once, in Project admin.
        if (view === 'model')
          return (
            <AgentTabBody>
              <AgentModelView oc={editor.oc} setOc={editor.setOc} footer={<ProjectModelsLink projectId={projectId} />} />
            </AgentTabBody>
          );
        return (
          <AgentTabBody className={`${view === 'workspace' ? CENTER_COLUMN : RAIL_COLUMN} space-y-5`}>
            <CapabilityShellEmbedProvider value={{ agentName: agent.name }}>{editorSection(view)}</CapabilityShellEmbedProvider>
          </AgentTabBody>
        );
      }
      case 'triggers':
        return (
          <Embedded agentName={agent.name}>
            <TriggersPage projectId={projectId} surface={surface} defaultAgent={defaultAgent} />
          </Embedded>
        );
    }
  })();

  return (
    // Embedded screens leave through the router too (a configure session):
    // they ask the same question as a link click.
    <LeaveGuardProvider value={leaveGuard.confirmLeave}>
      <div className="relative flex h-full min-h-0 flex-1 flex-col">
        <AgentBreadcrumbHeader
          listHref={capabilityTabHref(projectId, 'agent')}
          slug={agent.name}
          title={name}
          badges={<HeaderBadges agent={agent} config={config} block={draft} />}
          actions={
            <AgentActions
              projectId={projectId}
              agent={agent}
              config={config}
              canWrite
              share={share}
            />
          }
        />
        <RailLayout rail={<AgentRail groups={railGroups} active={railKeyOf(location)} dirty={dirtyItems} />}>
          {body}
        </RailLayout>
        <SaveBar
          dirty={editor.isDirty}
          pending={update.isPending}
          changed={changed}
          onDiscard={() => setConfirmDiscard(true)}
          onSave={saveNow}
        />
        <ConfirmDialog
          open={confirmDiscard}
          onOpenChange={setConfirmDiscard}
          title={tI18nComplete.raw('text3b13192b9d88')}
          description={tI18nComplete('text8a36cce34f68', { value0: name })}
          confirmLabel={tI18nComplete.raw('texteb1a70e39274')}
          cancelLabel={tI18nComplete.raw('texte76fd2add010')}
          confirmVariant="destructive"
          onConfirm={() => {
            setConfirmDiscard(false);
            editor.discard();
          }}
        />
        <LeaveDialog
          open={leaveGuard.asking}
          changed={changed}
          pending={update.isPending}
          onStay={leaveGuard.stay}
          onLeave={leaveGuard.leave}
          onSaveAndLeave={async () => {
            if (await onSave()) leaveGuard.leave();
          }}
        />
      </div>
    </LeaveGuardProvider>
  );
}

// ─── Read-only body ──────────────────────────────────────────────────────────

/** A reader's tabs and views: what can be shown without the editor. */
const READ_ONLY_VIEWS: readonly AgentConfigSectionKey[] = ['actions', 'model'];

function ReadOnlyAgentPage({
  projectId,
  agent,
  config,
  block,
  canWrite,
}: {
  projectId: string;
  agent: Agent;
  config: ProjectConfigSummary;
  block: AgentConfigBlock;
  /** A writer on a read-only answer keeps Make default and Ask My Kortix to edit. */
  canWrite: boolean;
}) {
  const t = useI18nTranslations('agentEditor.tabs');
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const pathname = useUiPathname();
  const sourcePath = configEntitySourcePath(agent.path);
  // The served block carries the prompt when the read returned it; otherwise
  // read the agent's source file.
  const fileQuery = useQuery({
    queryKey: ['entity-file-content', projectId, sourcePath],
    queryFn: () => readProjectFile(projectId, sourcePath),
    staleTime: 30_000,
    enabled: block.behavior?.prompt === undefined,
  });
  const prompt = block.behavior?.prompt ?? (fileQuery.data ? stripFrontmatter(fileQuery.data.content) : null);
  const views = useMemo(() => {
    const own = ACCESS_VIEWS.filter((v) => v === 'skills' || v === 'connectors' || v === 'secrets' || v === 'apps' || v === 'actions');
    return [...own, 'model'] as AgentConfigSectionKey[];
  }, []);
  const location = useAgentLocation(AGENT_TABS, READ_ONLY_VIEWS);
  const share = useShareDialog(location.open === 'share');
  const facts = useOverviewFacts(projectId, agent.name, config, block);
  const spacesOn = useSpacesEnabled(projectId);
  const canManageMembers = useCanManageMembers(projectId);
  const railGroups = useRailGroups(pathname, READ_ONLY_VIEWS, facts, canManageMembers ? () => share.setOpen(true) : undefined);
  const name = agentDisplayName(agent.name);
  // A reader has a page for Kortix permissions and Model only. Every other
  // Access row shows its grant by name on the Overview and links nowhere.
  const banner = (
    <InfoBanner tone="neutral" icon={LockSimpleIcon} title={t('readOnlyTitle')}>
      {t.rich('readOnlyBody', { code: (chunks) => <span className="font-mono">{chunks}</span> })}
    </InfoBanner>
  );

  const body = (() => {
    switch (location.tab) {
      case 'basics':
        return (
          <AgentTabBody className="space-y-6">
            {banner}
            <AgentOverview
              part="basics"
              agent={agent}
              config={config}
              block={block}
              prompt={prompt}
              sourcePath={sourcePath}
              showSpace={spacesOn}
            />
          </AgentTabBody>
        );
      case 'overview':
        return (
          <AgentTabBody className="space-y-6">
            {banner}
            <AgentOverview
              agent={agent}
              config={config}
              block={block}
              prompt={prompt}
              sourcePath={sourcePath}
              showSpace={spacesOn}
            />
          </AgentTabBody>
        );
      case 'access':
      case 'runtime':
        return (
          <AgentTabBody className={`${location.view === 'model' || location.view === 'workspace' ? CENTER_COLUMN : RAIL_COLUMN} space-y-6`}>
            {banner}
            <EditorSectionStyleProvider value="panel">
              {location.view === 'model' ? (
                <div className="space-y-3">
                  <AgentModel projectId={projectId} agentName={agent.name} />
                  <p className="text-muted-foreground text-xs text-pretty">{tI18nComplete.raw('text9dee2a1acfd9')}</p>
                </div>
              ) : (
                <div className="space-y-8">
                  {/* The manifest allowlist, read-only for a reader. */}
                  <AgentScope projectId={projectId} agentName={agent.name} scope={agent.scope} />
                  <AgentAuthorityCard
                    projectId={projectId}
                    agentName={agent.name}
                    grant={block.kortix_permissions ?? block.kortix_cli}
                  />
                </div>
              )}
            </EditorSectionStyleProvider>
          </AgentTabBody>
        );
      case 'triggers':
        // The same Triggers screen; its own controls decide what a reader may change.
        return (
          <Embedded agentName={agent.name}>
            <TriggersPage
              projectId={projectId}
              surface={{ kind: 'agent', agentName: agent.name }}
              defaultAgent={config.default_agent}
            />
          </Embedded>
        );
    }
  })();

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col">
      <AgentBreadcrumbHeader
        listHref={capabilityTabHref(projectId, 'agent')}
        slug={agent.name}
        title={name}
        badges={<HeaderBadges agent={agent} config={config} block={block} />}
        actions={
          <AgentActions
            projectId={projectId}
            agent={agent}
            config={config}
            canWrite={canWrite}
            share={share}
          />
        }
      />
      <RailLayout rail={<AgentRail groups={railGroups} active={railKeyOf(location)} />}>
        {body}
      </RailLayout>
    </div>
  );
}

/** A markdown file's body without its frontmatter. */
function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, '');
}

/** Whether a Kortix permissions grant lets the agent open project Apps. */
function grantsAppRead(grant: AgentGrantSetV2 | null | undefined): boolean {
  return grant === 'all' || (Array.isArray(grant) && grant.includes('project.app.read'));
}


/**
 * `connectors_required` (kortix.yaml), when the block sets it: read-only,
 * because sessions no longer wait for these connectors.
 */
function RequiredConnectorsNote({ names }: { names: readonly string[] | undefined }) {
  const t = useI18nTranslations('agentEditor.tabs');
  if (!names || names.length === 0) return null;
  return (
    <section className="space-y-1">
      <h2 className="text-sm font-medium">{t('requiredConnectors')}</h2>
      <p className="text-foreground font-mono text-sm">{names.join(', ')}</p>
      <p className="text-muted-foreground text-xs text-pretty">{t('requiredConnectorsHelp')}</p>
    </section>
  );
}
