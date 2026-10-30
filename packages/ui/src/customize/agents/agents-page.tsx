'use client';

/**
 * /projects/[id]/customize/agents: the Agents index, where the sidebar's
 * Customize row lands.
 *
 * Customize is agent-first. My Kortix is not listed: the project home starts
 * it. The page lists the agents a person starts, as cover cards (the default first), then the subagents other
 * agents call, as their own section: prod's catalog layout. Each card's facts
 * line reads what the configuration grants (KRTX-3025), never the agent's
 * prose. A space filter appears when the project splits into spaces.
 *
 * New agent opens `CreateAgentModal`; `?new=1` opens it too (the sidebar's
 * New agent row links here).
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
  updateProjectDefaultAgent,
} from '@kortix/sdk';
import { contract, qk, useProjectAccountId } from '@kortix/sdk/react';
import { MagnifyingGlassIcon, PlusIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';

import { useTranslations as useI18nTranslations } from '../../i18n';
import { useSlashFocus } from '../../internal/hooks';
import { AgentMark, agentDisplayName } from '../../internal/components/agent-mark';
import { prefetchAgentConfig } from '../../internal/hooks/projects/use-agent-config';
import { agentHref } from '../../internal/lib/capability-tab-routes';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectCan } from '../../internal/lib/use-project-can';
import { useActiveSpace } from '../../internal/stores/active-space-store';
import { useSpacesEnabled } from '../../internal/lib/space-scope';
import { Badge } from '../../primitives/badge';
import { Button } from '../../primitives/button';
import Loading from '../../primitives/loading';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../primitives/select';
import { errorToast, successToast } from '../../primitives/toast';
import { cn } from '../../internal/lib/utils';
import { EmptyState } from '../../primitives/empty-state';
import { ErrorState } from '../../primitives/error-state';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '../../primitives/input-group';
import { Skeleton } from '../../primitives/skeleton';
import { UiLink as Link, useUiPathname, useUiRouter, useUiSearchParams } from '../../providers/ui-provider';
import { CatalogNoMatch } from '../shared/catalog/catalog-empty-state';
import { CatalogGridSkeleton } from '../shared/catalog/catalog-grid';
import { GRID_CLASSNAME } from '../shared/catalog/catalog-grid-tokens';
import { ALL_SPACES, CatalogSpaceTabs } from '../shared/catalog/catalog-space-tabs';
import { toArray } from '../shared/utils';
import { AgentAccessText } from './agent-access-text';
import { AgentCoverCard } from './agent-cover-card';
import { agentInMode, filterAgents } from './agent-filter';
import { AgentTabBody, CustomizeHeader } from './agent-page-chrome';
import { CreateAgentModal } from './create-agent-modal';
import { AgentPinButton } from './agent-pin-button';

type Agent = ProjectConfigSummary['agents'][number];

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

  const agents = useMemo(() => toArray(config?.agents), [config]);
  const filtered = useMemo(() => filterAgents(agents, { mode: null, query }), [agents, query]);
  const defaultAgent = config?.default_agent ?? config?.open_code_default_agent ?? null;
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
  // Spaces are Work in progress: with `project_channels` off, no space filter and no Space column.
  const spacesOn = useSpacesEnabled(projectId);
  const groups = useMemo(() => (spacesOn ? groupBySpace(work, config?.spaces) : []), [spacesOn, work, config?.spaces]);
  const [activeSpace, setActiveSpace] = useActiveSpace(projectId);
  const spaceFilter = activeSpace ?? ALL_SPACES;
  const shown = spaceFilter === ALL_SPACES ? work : (groups.find((g) => g.name === spaceFilter)?.items ?? work);

  // Agents first, subagents second (Marko, 2026-10-17): the agents a person
  // starts get the cover cards, the default first; the ones other agents call
  // sit in their own section. `all` is usable both ways and stays with the first.
  const primaryAgents = shown.filter((agent) => agentInMode(agent, 'primary'));
  const subagents = shown.filter((agent) => !agentInMode(agent, 'primary'));
  const card = (agent: Agent, cover?: string) => (
    <AgentCoverCard
      key={agent.path}
      slug={agent.name}
      href={agentHref(projectId, agent.name)}
      onIntent={() => prefetchAgentConfig(queryClient, projectId, agent.name)}
      title={agentDisplayName(agent.name)}
      description={agent.description}
      badges={<AgentCardBadges agent={agent} />}
      coverLabel={cover}
      action={<AgentPinButton projectId={projectId} agent={agent.name} onCard />}
      meta={
        <AgentCardFacts
          agent={agent}
          triggerCount={triggerCounts.get(agent.name) ?? 0}
          grantCount={grantCounts.get(agent.name) ?? 0}
        />
      }
    />
  );

  const newButton = canWrite ? (
    <Button size="sm" onClick={() => setCreating(true)} className="gap-1.5">
      <PlusIcon className="size-4" />
      {t('newAgent')}
    </Button>
  ) : null;

  const body = (() => {
    if (detailQuery.isLoading) return <CatalogGridSkeleton />;
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
        {work.length > 0 ? (
          <section className="space-y-3">
            {groups.length > 0 ? (
              <CatalogSpaceTabs groups={groups} value={spaceFilter} onValueChange={(v) => setActiveSpace(v === ALL_SPACES ? null : v)} />
            ) : null}
            {primaryAgents.length > 0 ? (
              <div className={GRID_CLASSNAME}>
                {primaryAgents.map((agent) => card(agent, agent.name === defaultAgent ? tPage('default') : undefined))}
              </div>
            ) : null}
            {subagents.length > 0 ? (
              <section aria-labelledby="subagents-heading" className={cn('space-y-2', primaryAgents.length > 0 && 'pt-5')}>
                <div>
                  <h2 id="subagents-heading" className="text-foreground text-sm font-medium">
                    {tI18nComplete.raw('agentsListSubagentsTitle')}{' '}
                    <span className="text-muted-foreground font-normal tabular-nums">{subagents.length}</span>
                  </h2>
                  <p className="text-muted-foreground mt-1 text-xs">{tI18nComplete.raw('agentsListSubagentsHint')}</p>
                </div>
                <div className={GRID_CLASSNAME}>{subagents.map((agent) => card(agent))}</div>
              </section>
            ) : null}
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
          rule
          actions={
            <>
              <div className="hidden w-64 md:block">{search(searchRef)}</div>
              {config ? <DefaultAgentSelector projectId={projectId} config={config} canWrite={canWrite} /> : null}
              {newButton}
            </>
          }
        />
        {/* A centered column: three cards across at most, never the whole window.
            Equal top and bottom inset: this page has no save bar to clear. */}
        <AgentTabBody className="mx-auto max-w-6xl space-y-5 pb-5">
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

/**
 * The card's facts line: what the configuration grants (KRTX-3025), in the
 * one grant vocabulary (All, None or a count, `AgentAccessText`), then the
 * agent's own model, triggers and grants. A fact with nothing to say is left
 * out: no "0 triggers", no "Default model".
 */
function AgentCardFacts({
  agent,
  triggerCount,
  grantCount,
}: {
  agent: Agent;
  triggerCount: number;
  grantCount: number;
}) {
  const facts = [
    agent.model ? agent.model.split('/').pop() : null,
    triggerCount > 0 ? `${triggerCount} ${triggerCount === 1 ? 'trigger' : 'triggers'}` : null,
    grantCount > 0 ? `${grantCount} ${grantCount === 1 ? 'grant' : 'grants'}` : null,
  ].filter((fact): fact is string => Boolean(fact));
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 tabular-nums">
      <AgentAccessText agent={agent} />
      {facts.map((fact) => (
        <span key={fact} className="truncate">
          {fact}
        </span>
      ))}
    </span>
  );
}

/**
 * Card badges — "also a subagent", disabled. The default agent is marked on
 * the cover instead.
 *
 * The section already says primary or subagent, so a mode chip only marks the
 * both-ways `all` agent: it sits with the primaries but other agents call it
 * too.
 */
function AgentCardBadges({ agent }: { agent: Agent }) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const mode = agent.mode?.toLowerCase();
  return (
    <>
      {mode === 'all' ? (
        <Badge variant="muted" size="xs">
          {tI18nComplete.raw('agentsListAlsoSubagent')}
        </Badge>
      ) : null}
      {agent.enabled === false ? (
        <Badge variant="muted" size="xs">
          {tI18nComplete.raw('text75081b593d15')}
        </Badge>
      ) : null}
    </>
  );
}

/**
 * Which agent a new chat in this project starts with. Rides the filter row
 * rather than a banner of its own — it is one setting, and giving it a titled
 * block above the grid would outweigh the list it belongs to.
 */
function DefaultAgentSelector({
  projectId,
  config,
  canWrite,
}: {
  projectId: string;
  config: ProjectConfigSummary;
  canWrite: boolean;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const queryClient = useQueryClient();
  // A subagent cannot start a chat, so it is not offered as the default.
  const availableAgents = toArray(config.agents).filter(
    (agent) => agent.enabled !== false && agentInMode(agent, 'primary'),
  );
  const current = config.default_agent ?? config.open_code_default_agent;
  const mutation = useMutation({
    mutationFn: (agentName: string) => updateProjectDefaultAgent(projectId, agentName),
    onSuccess: async (result) => {
      successToast(
        tI18nComplete('text0bb557895b32', { value0: agentDisplayName(result.default_agent) }),
      );
      // One invalidation, not two: the project CONFIG is a `select` projection
      // over this same `qk.project.detail(id)` entry (`useProjectConfig`), not
      // its own fetch. The retired standalone `['project-config', id]` slot no
      // longer exists, so a second call for it would invalidate nothing.
      await queryClient.invalidateQueries({ queryKey: qk.project.detail(projectId) });
    },
    onError: (error: Error) => errorToast(error.message || tI18nComplete.raw('text7f724c2ad694')),
  });

  if (availableAgents.length === 0 || !current) return null;

  return (
    <div className="flex shrink-0 items-center gap-2">
      {mutation.isPending ? <Loading className="size-4 shrink-0" /> : null}
      <Select
        value={current}
        onValueChange={(agentName) => mutation.mutate(agentName)}
        disabled={!canWrite || mutation.isPending}
      >
        <SelectTrigger
          aria-label={tI18nComplete.raw('text94da52ecd6c5')}
          className="h-9 w-44 shrink-0"
          size="sm"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {availableAgents.map((agent) => (
            <SelectItem key={agent.name} value={agent.name}>
              <span className="flex min-w-0 items-center gap-2">
                <AgentMark slug={agent.name} />
                <span className="truncate">{agentDisplayName(agent.name)}</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
