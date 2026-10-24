'use client';

/**
 * /projects/[id]/customize/agents: the Agents index, where the sidebar's
 * Customize row lands.
 *
 * Customize is agent-first. My Kortix leads, alone, as the Built-in row: the
 * one agent a person talks to, with Start session. Under it the work agents
 * sit in one table (Agent, Space, Access, People, Triggers, Status), each row
 * opening the agent's page. Access reads what the configuration grants
 * (KRTX-3025), never the agent's prose. A space filter appears when the
 * project splits into spaces.
 *
 * New agent opens `CreateAgentModal`; `?new=1` opens it too (the sidebar's
 * New agent row and My Kortix link here).
 *
 * Reads `config.agents` off the shared project-detail query, so this page and
 * everything else showing a project's agents agree. The trigger and grant
 * counts read the same lists the agent page reads.
 */

import {
  getProjectDetail,
  groupBySpace,
  listProjectResourceGrants,
  listProjectTriggers,
  type ProjectConfigSummary,
} from '@kortix/sdk';
import { contract, qk, useProjectAccountId } from '@kortix/sdk/react';
import { CaretRightIcon, MagnifyingGlassIcon, PlayIcon, PlusIcon } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';

import { useTranslations as useI18nTranslations } from '../../i18n';
import { useSlashFocus } from '../../internal/hooks';
import { AgentMark, agentDisplayName } from '../../internal/components/agent-mark';
import { prefetchAgentConfig } from '../../internal/hooks/projects/use-agent-config';
import { useNewProjectSession } from '../../internal/hooks/projects/use-new-project-session';
import { agentHref } from '../../internal/lib/capability-tab-routes';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectCan } from '../../internal/lib/use-project-can';
import { useActiveSpace } from '../../internal/stores/active-space-store';
import { Button } from '../../primitives/button';
import { EmptyState } from '../../primitives/empty-state';
import { ErrorState } from '../../primitives/error-state';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '../../primitives/input-group';
import { Skeleton } from '../../primitives/skeleton';
import { StatusDot, type StatusTone } from '../../primitives/status';
import { UiLink as Link, useUiPathname, useUiRouter, useUiSearchParams } from '../../providers/ui-provider';
import { CatalogNoMatch } from '../shared/catalog/catalog-empty-state';
import { ALL_SPACES, CatalogSpaceTabs } from '../shared/catalog/catalog-space-tabs';
import { agentEditorOptionQueries } from '../sections/view/agent-editor';
import { toArray } from '../shared/utils';
import { AgentAccessText } from './agent-access-text';
import { agentInMode, filterAgents } from './agent-filter';
import { AgentTabBody, CustomizeHeader } from './agent-page-chrome';
import { CreateAgentModal } from './create-agent-modal';

type Agent = ProjectConfigSummary['agents'][number];

const ROW_GRID = 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 md:grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,1.6fr)_7rem_5rem_8rem]';

export function AgentsPage({ projectId }: { projectId: string }) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const t = useI18nTranslations('agentEditor.tabs');
  const tPage = useI18nTranslations('agentEditor.page');
  const accountId = useProjectAccountId(projectId);
  const canWrite = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_AGENT_WRITE, { accountId }).allowed === true;
  const canReadTriggers =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_TRIGGER_READ, { accountId }).allowed === true;
  const canManageMembers =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE, { accountId }).allowed === true;
  const queryClient = useQueryClient();
  const startSession = useNewProjectSession(projectId);
  const params = useUiSearchParams();
  const router = useUiRouter();
  const pathname = useUiPathname();
  const [creating, setCreating] = useState(false);

  // `?new=1` opens the create modal; closing it drops the param.
  const askedNew = params.get('new') === '1';
  const createOpen = canWrite && (creating || askedNew);
  const setCreateOpen = (open: boolean) => {
    setCreating(open);
    if (!open && askedNew) router.replace(pathname);
  };

  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  // The table is the page's main content, not the search: no focus on arrival.
  useSlashFocus(searchRef, true, { focusOnArrival: false });

  const detailQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
  });
  const config = detailQuery.data?.config ?? null;

  const triggersQuery = useQuery({
    queryKey: qk.project.triggers(projectId),
    queryFn: () => listProjectTriggers(projectId),
    enabled: canReadTriggers,
    ...contract('config'),
  });
  const triggerCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const fallback = config?.default_agent ?? config?.open_code_default_agent ?? null;
    for (const trigger of triggersQuery.data?.triggers ?? []) {
      const owner = trigger.agent === 'default' && fallback ? fallback : trigger.agent;
      counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }
    return counts;
  }, [triggersQuery.data, config]);

  const grantsQuery = useQuery({
    queryKey: qk.project.resourceGrants(projectId),
    queryFn: () => listProjectResourceGrants(projectId),
    enabled: canManageMembers,
    retry: false,
    ...contract('inventory'),
  });
  const grantCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const grant of grantsQuery.data?.grants ?? []) {
      if (grant.resource_type !== 'agent') continue;
      counts.set(grant.resource_id, (counts.get(grant.resource_id) ?? 0) + 1);
    }
    return counts;
  }, [grantsQuery.data]);

  // Connectors that need a sign-in: an agent granted one shows "Needs sign-in".
  const connectorsQuery = useQuery(agentEditorOptionQueries(projectId).connectors);
  const needsAuth = useMemo(
    () => new Set((connectorsQuery.data?.connectors ?? []).filter((c) => c.status === 'needs_auth').map((c) => c.slug)),
    [connectorsQuery.data],
  );

  const agents = useMemo(() => toArray(config?.agents), [config]);
  const filtered = useMemo(() => filterAgents(agents, { mode: null, query }), [agents, query]);
  const defaultAgent = config?.default_agent ?? config?.open_code_default_agent ?? null;
  const builtIn = filtered.filter((agent) => agent.platform);
  // The agents a person starts first (the default leading), subagents after.
  const work = useMemo(
    () =>
      filtered
        .filter((agent) => !agent.platform)
        .sort(
          (a, b) =>
            Number(agentInMode(b, 'primary')) - Number(agentInMode(a, 'primary')) ||
            Number(b.name === defaultAgent) - Number(a.name === defaultAgent) ||
            agentDisplayName(a.name).localeCompare(agentDisplayName(b.name)),
        ),
    [filtered, defaultAgent],
  );
  const groups = useMemo(() => groupBySpace(work, config?.spaces), [work, config?.spaces]);
  const [activeSpace, setActiveSpace] = useActiveSpace(projectId);
  const spaceFilter = activeSpace ?? ALL_SPACES;
  const shown = spaceFilter === ALL_SPACES ? work : (groups.find((g) => g.name === spaceFilter)?.items ?? work);

  const statusOf = (agent: Agent): { tone: StatusTone; label: string } => {
    if (agent.enabled === false) return { tone: 'neutral', label: t('off') };
    const connectors = agent.scope?.connectors;
    const blocked =
      connectors === 'all' ? needsAuth.size > 0 : (connectors ?? []).some((slug) => needsAuth.has(slug));
    return blocked ? { tone: 'warning', label: t('needsSignInShort') } : { tone: 'success', label: t('enabled') };
  };

  const newButton = canWrite ? (
    <Button size="sm" onClick={() => setCreating(true)} className="gap-1.5">
      <PlusIcon className="size-4" />
      {t('newAgent')}
    </Button>
  ) : null;

  const body = (() => {
    if (detailQuery.isLoading) {
      return (
        <div className="divide-border divide-y rounded-md border">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <Skeleton className="size-7 rounded-sm" />
              <div className="space-y-1.5">
                <Skeleton className="h-4 w-32 rounded-sm" />
                <Skeleton className="h-3 w-56 rounded-sm" />
              </div>
            </div>
          ))}
        </div>
      );
    }
    if (detailQuery.isError) {
      return (
        <ErrorState
          size="sm"
          title={t('agentsLoadError')}
          action={
            <Button variant="outline" size="sm" onClick={() => void detailQuery.refetch()}>
              {tI18nComplete.raw('text942087cc2d41')}
            </Button>
          }
        />
      );
    }
    if (agents.length === 0) {
      return <EmptyState size="sm" title={tI18nComplete.raw('text971b61f8cb4d')} description={tI18nComplete.raw('textc4e4294c6777')} />;
    }
    if (filtered.length === 0) return <CatalogNoMatch query={query} />;
    return (
      <div className="space-y-8">
        {builtIn.map((agent) => (
          <section key={agent.name} aria-label={tPage('builtIn')}>
            <div className="bg-background flex items-center gap-3 rounded-md border px-4 py-3">
              <Link
                href={agentHref(projectId, agent.name)}
                onPointerEnter={() => prefetchAgentConfig(queryClient, projectId, agent.name)}
                className="flex min-w-0 flex-1 items-center gap-3"
              >
                <AgentMark slug={agent.name} size={28} />
                <span className="min-w-0">
                  <span className="text-foreground flex items-center gap-2 text-sm font-medium">
                    {agentDisplayName(agent.name)}
                    <span className="text-muted-foreground text-xs font-normal">{tPage('builtIn')}</span>
                  </span>
                  <span className="text-muted-foreground block truncate text-xs">{tPage('builtInHint')}</span>
                </span>
              </Link>
              <Button
                variant="outline"
                size="sm"
                className="hidden gap-1.5 sm:inline-flex"
                onClick={() => startSession({ create: { agent_name: agent.name } })}
              >
                <PlayIcon weight="fill" className="size-3.5" />
                {tI18nComplete.raw('textb1c52ee3677d')}
              </Button>
              <Link href={agentHref(projectId, agent.name)} aria-label={agentDisplayName(agent.name)}>
                <CaretRightIcon aria-hidden className="text-muted-foreground size-3.5" />
              </Link>
            </div>
          </section>
        ))}

        {work.length > 0 ? (
          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-foreground text-sm font-medium">
                {t('workAgents')} <span className="text-muted-foreground font-normal tabular-nums">{work.length}</span>
              </h2>
              <CatalogSpaceTabs groups={groups} value={spaceFilter} onValueChange={(v) => setActiveSpace(v === ALL_SPACES ? null : v)} />
            </div>
            <div className="bg-background overflow-hidden rounded-md border">
              <div className={`${ROW_GRID} text-muted-foreground hidden border-b px-4 py-2 text-xs md:grid`}>
                <span>{t('colAgent')}</span>
                <span>{t('space')}</span>
                <span>{t('tabAccess')}</span>
                <span>{t('people')}</span>
                <span>{t('triggers')}</span>
                <span>{t('colStatus')}</span>
              </div>
              <ul className="divide-border divide-y">
                {shown.map((agent) => {
                  const status = statusOf(agent);
                  const people = grantCounts.get(agent.name);
                  const triggers = triggerCounts.get(agent.name) ?? 0;
                  return (
                    <li key={agent.path}>
                      <Link
                        href={agentHref(projectId, agent.name)}
                        prefetch
                        onPointerEnter={() => prefetchAgentConfig(queryClient, projectId, agent.name)}
                        onFocus={() => prefetchAgentConfig(queryClient, projectId, agent.name)}
                        className={`${ROW_GRID} hover:bg-hover focus-visible:bg-hover px-4 py-2.5 transition-colors duration-fast focus-visible:outline-none`}
                      >
                        <span className="flex min-w-0 items-center gap-3">
                          <AgentMark slug={agent.name} size={21} />
                          <span className="min-w-0">
                            <span className="text-foreground flex min-w-0 items-center gap-2 text-sm font-medium">
                              <span className="truncate">{agentDisplayName(agent.name)}</span>
                              {agent.name === defaultAgent ? (
                                <span className="text-muted-foreground shrink-0 text-xs font-normal">{tPage('default')}</span>
                              ) : null}
                              {!agentInMode(agent, 'primary') ? (
                                <span className="text-muted-foreground shrink-0 text-xs font-normal">{tPage('kindSubagent')}</span>
                              ) : null}
                            </span>
                            {agent.description ? (
                              <span className="text-muted-foreground block truncate text-xs">{agent.description}</span>
                            ) : null}
                          </span>
                        </span>
                        <span className="text-muted-foreground hidden truncate text-sm md:block">
                          {agent.space ? `# ${agent.space}` : t('projectWide')}
                        </span>
                        <span className="text-muted-foreground hidden truncate text-sm md:block">
                          <AgentAccessText agent={agent} />
                        </span>
                        {/* Unknown (no members.manage) reads as a dash, nobody
                            granted as who still may use it. Never a blank cell. */}
                        <span className="text-muted-foreground hidden truncate text-sm tabular-nums md:block">
                          {people === undefined
                            ? grantsQuery.isSuccess
                              ? t('managersOnly')
                              : '—'
                            : people}
                        </span>
                        <span className="text-muted-foreground hidden text-sm tabular-nums md:block">
                          {canReadTriggers ? triggers : '—'}
                        </span>
                        <span className="flex items-center justify-end gap-2 md:justify-between">
                          <span className="text-foreground flex items-center gap-1.5 text-sm">
                            <StatusDot tone={status.tone} />
                            <span className="hidden sm:inline">{status.label}</span>
                          </span>
                          <CaretRightIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>
        ) : null}
      </div>
    );
  })();

  const search = (ref?: typeof searchRef) => (
    <InputGroupSearch>
      <InputGroupSearchIcon>
        <MagnifyingGlassIcon />
      </InputGroupSearchIcon>
      <InputGroupSearchInput
        ref={ref}
        aria-label={tI18nComplete.raw('text212fd04a1d20')}
        placeholder={tI18nComplete.raw('text212fd04a1d20')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        variant="popover"
        size="sm"
      />
      {query ? <InputGroupSearchClear onClick={() => setQuery('')} /> : null}
    </InputGroupSearch>
  );

  // The same header as the agent page, My Kortix and Review (`CustomizeHeader`),
  // so the title never jumps between them. Search sits in it from `md`; below
  // that it is the first row of the list.
  return (
    <>
      <div className="flex h-full min-h-0 flex-1 flex-col">
        <CustomizeHeader
          title={tI18nComplete.raw('text279b44d2ab4b')}
          description={t('agentsLead')}
          rule
          actions={
            <>
              <div className="hidden w-64 md:block">{search(searchRef)}</div>
              {newButton}
            </>
          }
        />
        <AgentTabBody className="space-y-5">
          <div className="md:hidden">{search()}</div>
          {body}
        </AgentTabBody>
      </div>
      {canWrite ? (
        <CreateAgentModal open={createOpen} onOpenChange={setCreateOpen} projectId={projectId} config={config} />
      ) : null}
    </>
  );
}
