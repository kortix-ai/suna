'use client';

import { adminPath } from '../../lib/routes';

/**
 * /projects/[id]/customize/agents/[name]: one agent, as a page with a rail.
 *
 * Customize is agent-first. My Kortix is the one agent a person talks to; every
 * other agent is a work product with only the access its work needs. So the
 * page is the agent: one identity header, one rail, and room to edit.
 *
 *   ┌ ▣ researcher                         [Share] [Start session] [⋯] ┐
 *   │   ● Enabled · Space: workspace · People start it                 │
 *   ├ Overview      ┬ the row, full width                              ┤
 *   │ Triggers      │                                                  │
 *   │ Access: Connectors None · Secrets All · Skills All · Tools …     │
 *   │ Runtime: Model · Workspace                                       │
 *   └────────────────── [ ● Unsaved changes  Skills  Discard  Save ⌘S ]
 *
 * The URL names the tab and its view (`agent-tabs.ts`); every old
 * `?section=` link still resolves. The rail lists every view as its own row
 * (2026-10-28: Access and Runtime are group labels, not a second level), each
 * with its grant state. A view renders the full resource screen in agent
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
 * My Kortix (a platform agent) has its own Overview and no editor.
 *
 * The page is keyed on the agent name by its route, so switching agents
 * remounts every draft.
 */

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
import { DotsThreeIcon, LockSimpleIcon, PlayIcon, SparkleIcon, StarIcon, TrashIcon } from '@phosphor-icons/react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

import { useLocale, useTranslations as useI18nTranslations } from '../../i18n';
import { agentDisplayName } from '../../internal/components/agent-mark';
import {
  agentConfigNeedsUpgrade,
  useAgentConfig,
  useUpdateAgentConfig,
  useProjectCapabilities,
} from '../../internal/hooks/projects/use-agent-config';
import { useNewProjectSession } from '../../internal/hooks/projects/use-new-project-session';
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
  AgentConfigSections,
  agentConfigSectionKeys,
  agentEditorOptionQueries,
  registryGrantOptions,
  useAgentDraft,
  useAgentEditorOptions,
  useLocalizedAgentConfigCatalog,
} from '../sections/view/agent-editor';
import { EditorSectionStyleProvider } from '../sections/view/agent-editor-primitives';
import { ModelSection } from '../sections/view/agent-editor-basics-fields';
import { ToolsSection } from '../sections/view/permission-editor';
import { type AgentGrant, plainGrant, useAgentGrant } from '../shared/agent-resource-scope';
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
import { useGrantLabel } from './agent-access-text';
import { AgentOverview, grantExcluded, grantOf, type OverviewFacts } from './agent-overview';
import {
  AgentIdentityHeader,
  AgentPageSkeleton,
  AgentStatePage,
  AgentRail,
  type AgentRailItem,
  AgentTabBody,
  type HeaderFact,
  LeaveDialog,
  SaveBar,
} from './agent-page-chrome';
import { AgentShareControl } from './agent-share-control';
import {
  ACCESS_VIEWS,
  AGENT_TABS,
  type AgentLocation,
  type AgentRailKey,
  type AgentTab,
  agentLocationHref,
  changedItems,
  closestAgentName,
  resolveAgentLocation,
  railKeyOf,
  RUNTIME_VIEWS,
  sectionLocationHref,
} from './agent-tabs';
import { PlatformAgentOverview } from './platform-agent-overview';
import { connectorPolicySetOptions } from './agent-policy-sets';
import { AgentPolicySetsPanel } from './agent-policy-sets-section';
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
  const agent = toArray(config?.agents).find((a) => a.name === agentName) ?? null;
  const isPlatform = agent?.platform === true;

  // Every read starts on the first render, in parallel: the skeleton lasts as
  // long as the slowest single read, not three in a row.
  const configQuery = useAgentConfig(projectId, agentName);
  const editorOptionQueries = agentEditorOptionQueries(projectId);
  useQueries({
    queries: [editorOptionQueries.secrets, editorOptionQueries.connectors, editorOptionQueries.sandboxes].map(
      (query) => ({ ...query, enabled: canWrite }),
    ),
  });

  if (detailQuery.isLoading || (agent && !isPlatform && configQuery.isLoading)) {
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
    const suggestion = closestAgentName(
      agentName,
      toArray(config.agents).map((a) => a.name),
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
  if (!isPlatform && canWrite && configQuery.isError) {
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

  if (isPlatform) return <PlatformAgentPage projectId={projectId} agent={agent} config={config} canWrite={canWrite} />;

  const editable = canWrite && configQuery.data?.editable === true;
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
      block={configQuery.data?.block ?? blockFromScope(agent)}
      canWrite={canWrite}
      showUpgradeHint={agentConfigNeedsUpgrade(configQuery.data)}
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

function useAgentLocation(tabs: readonly AgentTab[], views: readonly AgentConfigSectionKey[]): AgentLocation {
  const params = useUiSearchParams();
  return resolveAgentLocation(
    { tab: params.get('tab'), view: params.get('view'), section: params.get('section') },
    tabs,
    views,
  );
}

/** How many triggers start this agent, and how many grants name it. The same
 *  lists and gates as the Agents index, so both read one cache. */
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
      ? triggers.data.triggers.filter((tr) => (tr.agent === 'default' && fallback ? fallback : tr.agent) === agentName)
          .length
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

/** The header's meta line: status, space, who starts it, default. */
function useHeaderFacts(
  agent: Agent,
  config: ProjectConfigSummary,
  block: AgentConfigBlock,
  editable: boolean,
): HeaderFact[] {
  const t = useI18nTranslations('agentEditor.tabs');
  const tPage = useI18nTranslations('agentEditor.page');
  const enabled = block.enabled !== false;
  // Editable pages pass the draft: read it alone, so Project-wide reads as
  // Project-wide before the save. A reader's block already carries the space.
  const space = (editable ? block.space : (block.space ?? agent.space)) || null;
  const mode = (block.behavior?.mode ?? agent.mode ?? 'primary').toLowerCase();
  const isDefault = (config.default_agent ?? config.open_code_default_agent) === agent.name;
  return [
    { label: enabled ? t('enabled') : t('off'), tone: enabled ? 'success' : 'neutral' },
    { label: space ? t('spaceValue', { space }) : t('projectWide') },
    { label: mode === 'subagent' ? t('startSubagent') : mode === 'all' ? t('startBoth') : t('startPrimary') },
    ...(isDefault ? [{ label: tPage('default') }] : []),
  ];
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
 * The rail's rows: Overview, Triggers, then every Access and Runtime view the
 * agent has, labelled, with its count (`countOf`) and href.
 */
function useRailItems(
  pathname: string,
  views: readonly AgentConfigSectionKey[],
  counts: { triggerCount?: number },
  countOf?: (view: AgentConfigSectionKey) => string | null,
): AgentRailItem[] {
  const t = useI18nTranslations('agentEditor.tabs');
  const catalog = useLocalizedAgentConfigCatalog();
  const labelOf = (key: AgentConfigSectionKey) => catalog.sections.find((s) => s.key === key)?.label ?? key;
  const viewRows = (own: readonly AgentConfigSectionKey[], group: 'access' | 'runtime') =>
    own
      .filter((view) => views.includes(view))
      .map((view) => ({
        key: view,
        label: labelOf(view),
        href: sectionLocationHref(pathname, view),
        count: countOf?.(view) ?? undefined,
        group,
      }));
  return [
    { key: 'overview', label: t('tabOverview'), href: agentLocationHref(pathname, 'overview') },
    {
      key: 'triggers',
      label: t('tabTriggers'),
      href: agentLocationHref(pathname, 'triggers'),
      count: counts.triggerCount || undefined,
    },
    ...viewRows(ACCESS_VIEWS, 'access'),
    ...viewRows(RUNTIME_VIEWS, 'runtime'),
  ];
}

/** The rail and the body beside it, under the header's rule. */
function RailLayout({ rail, children }: { rail: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col border-t md:flex-row">
      {rail}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

// ─── Header actions ──────────────────────────────────────────────────────────

/**
 * Share, Start session, and the ⋯ menu. Share renders for everyone and gates
 * itself on `project.members.manage`. The ⋯ menu needs `project.agent.write`;
 * on a platform agent (My Kortix) it holds only Make default, so a project
 * can always make My Kortix its default again. Start session boots a session
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
  const isDefault = (config.default_agent ?? config.open_code_default_agent) === agent.name;
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
        size="icon-sm"
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
      <AgentShareControl projectId={projectId} agentName={agent.name} open={share.open} onOpenChange={share.setOpen} />
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
            <Button variant="ghost" size="icon-sm" aria-label={tI18nComplete.raw('textf8d46c2570e7')}>
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
            {agent.platform ? null : (
              <>
                <DropdownMenuItem disabled={configure.pending} onSelect={() => setConfirm('edit')}>
                  <SparkleIcon className="size-4" />
                  {t('askToEditAgent')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" disabled={configure.pending} onSelect={() => setConfirm('delete')}>
                  <TrashIcon className="size-4" />
                  {t('deleteAgent', { name: agentDisplayName(agent.name) })}
                </DropdownMenuItem>
              </>
            )}
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
const VIEW_COLUMN = 'max-w-5xl';

/** Frames a full resource screen in agent scope, with `lead` atop its scroller. */
function Embedded({
  agentName,
  lead,
  column,
  children,
}: {
  agentName: string;
  lead?: ReactNode;
  /** The view column (`VIEW_COLUMN`); omitted for Triggers. */
  column?: string;
  children: ReactNode;
}) {
  return (
    <CapabilityShellEmbedProvider value={{ agentName, lead, className: column }}>
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
  const t = useI18nTranslations('agentEditor.tabs');
  const tCapabilities = useI18nTranslations('agentCapabilities');
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const locale = useLocale();
  const editor = useAgentDraft(initial);
  const options = useAgentEditorOptions(projectId);
  const capabilities = useProjectCapabilities(projectId);
  const update = useUpdateAgentConfig(projectId, agent.name);
  const configure = useConfigureThread(projectId);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const pathname = useUiPathname();
  const drivesOn = useFeatureFlag(projectId, 'drives').enabled;
  // A v2 agent has no extension grant, but the platform extensions its
  // sessions load are listed (and two follow tool switches): the Extensions
  // view opens on v2 too. The Overview counts grants, so it keeps v2's keys.
  const overviewViews = useMemo(
    () => agentConfigSectionKeys(schemaVersion).filter((k) => drivesOn || k !== 'drives'),
    [schemaVersion, drivesOn],
  );
  const views = useMemo<AgentConfigSectionKey[]>(
    () => (schemaVersion === 2 ? [...overviewViews, 'extensions'] : overviewViews),
    [schemaVersion, overviewViews],
  );
  const location = useAgentLocation(AGENT_TABS, views);
  const share = useShareDialog(location.open === 'share');
  const canManageMembers = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE).allowed === true;
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
  const surface = { kind: 'agent', agentName: agent.name } as const;
  const defaultAgent = config.default_agent ?? config.open_code_default_agent;
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
  const headerFacts = useHeaderFacts(agent, config, draft, true);

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

  const viewHref = (view: AgentConfigSectionKey) => sectionLocationHref(pathname, view);
  const grantLabel = useGrantLabel();
  // A tool's aliases go off with it (`agent` takes `task`): the tab counts tools, not names.
  const toolAliases = new Set((capabilities.data?.tools ?? []).flatMap((tool) => tool.aliases));
  // v2 has no extension grant: that view lists switches, no count.
  const countOf = (view: AgentConfigSectionKey) => {
    if (view === 'drives' || (view === 'extensions' && schemaVersion < 3)) return null;
    const value = grantOf(draft, view);
    const excluded = grantExcluded(value);
    return view === 'tools' && excluded.length > 0
      ? grantLabel({ exclude: excluded.filter((id) => !toolAliases.has(id)) })
      : grantLabel(value);
  };
  const railItems = useRailItems(pathname, views, facts, countOf);
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
      authority={
        <AgentAuthorityCard
          projectId={projectId}
          agentName={agent.name}
          grant={draft.kortix_permissions ?? draft.kortix_cli}
        />
      }
      sectionStyle="tab"
    />
  );

  const body = (() => {
    const view = location.view;
    switch (location.tab) {
      case 'overview':
        return (
          <AgentTabBody>
            <AgentOverview
              agent={agent}
              config={config}
              block={draft}
              prompt={editor.oc.prompt ?? ''}
              views={overviewViews}
              facts={facts}
              editor={editor}
              hrefFor={viewHref}
              hrefs={{
                model: viewHref('model'),
                workspace: viewHref('workspace'),
                triggers: agentLocationHref(pathname, 'triggers'),
              }}
              sourcePath={sourcePath}
              onOpenShare={canManageMembers ? () => share.setOpen(true) : undefined}
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
            <Embedded agentName={agent.name} column={VIEW_COLUMN}>
              <Page
                projectId={projectId}
                agent={{ name: agent.name, editor }}
                footer={
                  view === 'tools' ? (
                    <EditorSectionStyleProvider value="panel">
                      <ToolsSection
                        permission={editor.oc.permission}
                        onChange={(next) => editor.setOc('permission', next)}
                        title={tCapabilities('rulesTitle')}
                      />
                    </EditorSectionStyleProvider>
                  ) : undefined
                }
              />
            </Embedded>
          );
        }
        if (view === 'connectors')
          return (
            <Embedded agentName={agent.name} column={VIEW_COLUMN}>
              <ConnectorsPage
                projectId={projectId}
                surface={surface}
                grant={connectorsGrant}
                agentPanel={<AgentPolicySetsPanel projectId={projectId} editor={editor} catalog={policySetOptions} />}
              />
            </Embedded>
          );
        if (view === 'secrets')
          return (
            <Embedded agentName={agent.name} column={VIEW_COLUMN}>
              <SecretsPage projectId={projectId} surface={surface} grant={secretsGrant} />
            </Embedded>
          );
        if (view === 'apps' && renderApps)
          return (
            <Embedded agentName={agent.name} column={VIEW_COLUMN}>
              {renderApps({ agentName: agent.name, grant: appsGrant, needsAppRead: !grantsAppRead(draft.kortix_permissions ?? draft.kortix_cli) })}
            </Embedded>
          );
        if (view === 'drives')
          return (
            <Embedded agentName={agent.name} column={VIEW_COLUMN}>
              <AgentDrivesSection projectId={projectId} agentName={agent.name} repositoryAccess={draft.repository_access !== false} />
            </Embedded>
          );
        // Model is this agent's model only. The project-wide gateway screens
        // (providers, routing, costs, logs) live once, in Project admin.
        if (view === 'model')
          return (
            <AgentTabBody className={`${VIEW_COLUMN} space-y-5`}>
              <EditorSectionStyleProvider value="tab">
                <div className="space-y-8">
                  <ModelSection oc={editor.oc} setOc={editor.setOc} showPrompt={false} lead />
                </div>
              </EditorSectionStyleProvider>
              <ProjectModelsLink projectId={projectId} />
            </AgentTabBody>
          );
        return (
          <AgentTabBody className={`${VIEW_COLUMN} space-y-5`}>
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
        <AgentIdentityHeader
          slug={agent.name}
          title={name}
          facts={headerFacts}
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
        <RailLayout
          rail={
            <AgentRail
              items={railItems}
              active={railKeyOf(location)}
              dirty={dirtyItems}
              groupLabels={{ access: t('tabAccess'), runtime: t('tabRuntime') }}
            />
          }
        >
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
  showUpgradeHint,
}: {
  projectId: string;
  agent: Agent;
  config: ProjectConfigSummary;
  block: AgentConfigBlock;
  /** A v1-project writer keeps Make default and Ask My Kortix to edit. */
  canWrite: boolean;
  showUpgradeHint: boolean;
}) {
  const t = useI18nTranslations('agentEditor.tabs');
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const tUpgrades = useI18nTranslations('settings.upgrades');
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
  const canManageMembers = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE).allowed === true;
  const facts = useOverviewFacts(projectId, agent.name, config, block);
  const headerFacts = useHeaderFacts(agent, config, block, false);
  const railItems = useRailItems(pathname, READ_ONLY_VIEWS, facts);
  const name = agentDisplayName(agent.name);
  // A reader has a page for Kortix permissions and Model only. Every other
  // Access row shows its grant by name on the Overview and links nowhere.
  const viewHref = (view: AgentConfigSectionKey) =>
    READ_ONLY_VIEWS.includes(view) ? sectionLocationHref(pathname, view) : null;

  const banner = (
    <div className="space-y-3">
      <InfoBanner tone="neutral" icon={LockSimpleIcon} title={t('readOnlyTitle')}>
        {t.rich('readOnlyBody', { code: (chunks) => <span className="font-mono">{chunks}</span> })}
      </InfoBanner>
      {showUpgradeHint ? (
        <InfoBanner tone="info" title={tI18nComplete.raw('textdc7ab144ca89')}>
          {tUpgrades.rich('agentEditorHint', { code: (chunks) => <span className="font-mono">{chunks}</span> })}
        </InfoBanner>
      ) : null}
    </div>
  );

  const body = (() => {
    switch (location.tab) {
      case 'overview':
        return (
          <AgentTabBody className="space-y-6">
            {banner}
            <AgentOverview
              agent={agent}
              config={config}
              block={block}
              prompt={prompt}
              views={views}
              facts={facts}
              hrefFor={viewHref}
              hrefs={{
                model: sectionLocationHref(pathname, 'model'),
                workspace: sectionLocationHref(pathname, 'model'),
                triggers: agentLocationHref(pathname, 'triggers'),
              }}
              sourcePath={sourcePath}
              onOpenShare={canManageMembers ? () => share.setOpen(true) : undefined}
            />
          </AgentTabBody>
        );
      case 'access':
      case 'runtime':
        return (
          <AgentTabBody className="max-w-4xl space-y-6">
            {banner}
            <EditorSectionStyleProvider value="panel">
              {location.view === 'model' ? (
                <div className="space-y-3">
                  <AgentModel projectId={projectId} agentName={agent.name} />
                  <p className="text-muted-foreground text-xs text-pretty">{tI18nComplete.raw('text9dee2a1acfd9')}</p>
                </div>
              ) : (
                <div className="space-y-8">
                  {/* The manifest allowlist: a v1 project's editors change its
                      secrets and connectors here; everyone else reads it. */}
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
              defaultAgent={config.default_agent ?? config.open_code_default_agent}
            />
          </Embedded>
        );
    }
  })();

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col">
      <AgentIdentityHeader
        slug={agent.name}
        title={name}
        facts={headerFacts}
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
      <RailLayout
        rail={
          <AgentRail
            items={railItems}
            active={railKeyOf(location)}
            groupLabels={{ access: t('tabAccess'), runtime: t('tabRuntime') }}
          />
        }
      >
        {body}
      </RailLayout>
    </div>
  );
}

/** A markdown file's body without its frontmatter. */
function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, '');
}

// ─── My Kortix ───────────────────────────────────────────────────────────────

function PlatformAgentPage({
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
  const t = useI18nTranslations('agentEditor.tabs');
  const tPage = useI18nTranslations('agentEditor.page');
  const isDefault = (config.default_agent ?? config.open_code_default_agent) === agent.name;
  const share = useShareDialog(false);
  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col">
      <AgentIdentityHeader
        slug={agent.name}
        title={agentDisplayName(agent.name)}
        facts={[
          { label: tPage('builtIn') },
          ...(isDefault ? [{ label: t('defaultAgent') }] : []),
          { label: t('actsAsYou') },
        ]}
        rule
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
      {/* One view, so no tab row: the header's rule closes it. */}
      <AgentTabBody>
        <PlatformAgentOverview projectId={projectId} config={config} />
      </AgentTabBody>
    </div>
  );
}

/** Whether a Kortix permissions grant lets the agent open project Apps. */
function grantsAppRead(grant: AgentGrantSetV2 | null | undefined): boolean {
  return grant === 'all' || (Array.isArray(grant) && grant.includes('project.app.read'));
}
