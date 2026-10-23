'use client';

import { customizePath, uiRoutes } from '../../lib/routes';
import { NewEntityMenu } from '../shared/new-entity-menu';
import { type UiTranslator, useTranslations as useI18nTranslations } from '../../i18n';
import { agentAccess } from './agent-access';
import { useMemo, useRef, useState } from 'react';

import { Badge } from '../../primitives/badge';
import { Button } from '../../primitives/button';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '../../primitives/input-group';
import Loading from '../../primitives/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../primitives/select';
import { errorToast, successToast } from '../../primitives/toast';
import { EmptyState } from '../../primitives/empty-state';
import { detectManifestVersion } from '../../internal/lib/manifest-version';
import { toArray } from '../shared/utils';
import {
  newConfigPrompt,
  useConfigureThread,
} from '../use-configure-thread';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectCan } from '../../internal/lib/use-project-can';
import { cn } from '../../internal/lib/utils';
import {
  getProjectDetail,
  groupByDomain,
  listProjectResourceGrants,
  listProjectTriggers,
  type ProjectConfigSummary,
  updateProjectDefaultAgent,
} from '@kortix/sdk';
import { contract, qk, useProjectAccountId } from '@kortix/sdk/react';
import { capitalizeWords, isMetaAgentName, META_AGENT_DISPLAY_NAME } from '@kortix/shared';
import { MagnifyingGlassIcon, RobotIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { CapabilityPageShell } from '../shared/capability-page-shell';
import { agentHref } from '../../internal/lib/capability-tab-routes';
import { prefetchAgentConfig } from '../../internal/hooks/projects/use-agent-config';
import { catalogEmptyKind } from '../shared/catalog/catalog-empty';
import { CatalogNoMatch } from '../shared/catalog/catalog-empty-state';
import { CatalogDomainSections } from '../shared/catalog/catalog-domain-sections';
import { CatalogGrid } from '../shared/catalog/catalog-grid';
import { GRID_CLASSNAME } from '../shared/catalog/catalog-grid-tokens';

import { AgentMark } from '../../internal/components/agent-mark';
import { AgentCoverCard } from './agent-cover-card';
import { agentInMode, filterAgents } from './agent-filter';
import { useSlashFocus } from '../../internal/hooks';

type Agent = ProjectConfigSummary['agents'][number];

/**
 * /projects/[id]/agent — the Agents list, and the landing page of Customize.
 *
 * Customize is agent-centric (Marko, 2026-09-01). An agent is the one object
 * a project manager grants a person or a group — every other resource is
 * reached THROUGH an agent — so it is the object this whole surface is built
 * around, and this list is where the sidebar's Customize row lands. Each card
 * is a link to that agent's page (`agentHref`): its instructions, model,
 * triggers, grants and who may use it, on one routed screen. The cards used to
 * open a detail modal with the editor swapped into its source pane; a modal
 * has no URL and buried the editor two clicks deep.
 *
 * Reads `config.agents` off the shared `['project-detail', projectId]` query,
 * so this page and everything else showing a project's agents cannot disagree
 * about what they are. `toArray` because the API can return the field as
 * `undefined` for a repo-less / capability-gated / config-build-failure
 * project, and `.filter` on that throws into prod Sentry.
 *
 * The trigger count on each card comes from the same `qk.project.triggers`
 * list the Triggers tab reads — one request, counted per agent name.
 */
export function AgentsPage({ projectId }: { projectId: string }) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  // `accountId` skips useProjectCan's own getProject and lets the IAM probe
  // run on the first render instead of waiting a round-trip for it.
  const accountId = useProjectAccountId(projectId);
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_AGENT_WRITE, { accountId }).allowed === true;
  const canReadTriggers =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_TRIGGER_READ, { accountId }).allowed === true;
  const canManageMembers =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE, { accountId }).allowed ===
    true;
  const configure = useConfigureThread(projectId);
  const queryClient = useQueryClient();

  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  useSlashFocus(searchRef);

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
  // A trigger stored as `default` counts for the project's default agent —
  // see `triggerStartsAgent`.
  const triggerCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const fallback = config?.default_agent ?? config?.open_code_default_agent ?? null;
    for (const trigger of triggersQuery.data?.triggers ?? []) {
      const owner = trigger.agent === 'default' && fallback ? fallback : trigger.agent;
      counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }
    return counts;
  }, [triggersQuery.data, config]);

  // Who is granted each agent. Same key the agent page's People section
  // reads, manager-gated like it.
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

  const facts = (agent: Agent) => (
    <AgentCardFacts
      agent={agent}
      triggerCount={triggerCounts.get(agent.name) ?? 0}
      grantCount={grantCounts.get(agent.name) ?? 0}
    />
  );

  const agents = useMemo(() => toArray(config?.agents), [config]);

  const filtered = useMemo(() => filterAgents(agents, { mode: null, query }), [agents, query]);
  const defaultAgent = config?.default_agent ?? config?.open_code_default_agent ?? null;

  // Agents first, subagents second (Marko, 2026-10-17). A project with 2
  // agents and 15 subagents buried the 2 a person starts in one alphabetical
  // grid. The agents a person starts get the full cards, the default first;
  // the ones other agents call sit below in a compact list. `all` is usable
  // both ways, so it stays with the agents a person starts.
  const primaryAgents = useMemo(
    () =>
      filtered
        .filter((agent) => agentInMode(agent, 'primary'))
        .sort((a, b) => Number(b.name === defaultAgent) - Number(a.name === defaultAgent)),
    [filtered, defaultAgent],
  );
  const subagents = useMemo(
    () => filtered.filter((agent) => !agentInMode(agent, 'primary')),
    [filtered],
  );
  // Domain grouping: when the project declares domains (top-level `domains:` or
  // any agent's `domain`), the primary agents render in domain sections
  // (`groupByDomain`, the default bucket last). With no domains it stays one
  // flat grid — an existing project sees no change.
  const primaryDomainGroups = useMemo(
    () => groupByDomain(primaryAgents, config?.domains),
    [primaryAgents, config?.domains],
  );
  const useDomainGrouping =
    (config?.domains?.length ?? 0) > 0 || primaryAgents.some((agent) => Boolean(agent.domain));
  // `null` = render the grid. Otherwise which "nothing to show" copy applies:
  // genuinely zero agents vs. agents exist but this filter/search hid all of
  // them. Telling the user "No agents yet" in the second case is false and
  // points at the wrong fix (clear the filter, not create an agent).
  const emptyKind = catalogEmptyKind(agents.length, filtered.length);

  // One control, two labels — same rule as the Skills page. The header has a
  // title beside it and can be terse; the empty state is the whole screen and
  // has to name what it creates. Both start the same configure thread, so they
  // cannot drift apart.
  // The header button is `h-9`, the height of the `size="sm"` search input
  // beside it. The empty state keeps `sm` to match its `sm` docs link.
  const createButton = (label: string, size?: 'sm') =>
    canWrite ? (
      <NewEntityMenu
        label={label}
        size={size}
        pending={configure.pending}
        onChat={() => configure.start(newConfigPrompt('agent'))}
        manual={{
          description: tI18nComplete.raw('text5210c5acc2cd'),
          href: uiRoutes().files(projectId) ?? customizePath(projectId, 'repo'),
        }}
      />
    ) : null;

  const renderPrimaryAgentCard = (agent: ProjectConfigSummary['agents'][number]) => (
    <AgentCoverCard
      key={agent.path}
      slug={agent.name}
      href={agentHref(projectId, agent.name)}
      onIntent={() => prefetchAgentConfig(queryClient, projectId, agent.name)}
      title={agentTitle(agent.name)}
      description={agent.description}
      badges={<AgentCardBadges agent={agent} />}
      coverLabel={defaultAgent === agent.name ? tI18nComplete.raw('text21b111cbfe6e') : undefined}
      meta={facts(agent)}
    />
  );

  return (
    <CapabilityPageShell
      title={tI18nComplete.raw('text279b44d2ab4b')}
      description={tI18nComplete.raw('text636453e23d69')}
      action={
        // The default-agent selector sits in the header beside New: it is a
        // page-level setting, not a filter on the list.
        <>
          {config ? (
            <DefaultAgentSelector projectId={projectId} config={config} canWrite={canWrite} />
          ) : null}
          {createButton('New')}
        </>
      }
      search={
        <InputGroupSearch>
          <InputGroupSearchIcon>
            <MagnifyingGlassIcon />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            ref={searchRef}
            placeholder={tI18nComplete.raw('text212fd04a1d20')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            variant="popover"
            size="sm"
          />
          <InputGroupSearchClear onClick={() => setQuery('')} />
        </InputGroupSearch>
      }
    >
      {useDomainGrouping && !detailQuery.isLoading && !detailQuery.isError && emptyKind === null ? (
        <CatalogDomainSections groups={primaryDomainGroups} renderCard={renderPrimaryAgentCard} />
      ) : (
        <CatalogGrid
          isLoading={detailQuery.isLoading}
          isError={detailQuery.isError}
          error={detailQuery.error}
          onRetry={() => detailQuery.refetch()}
          isEmpty={emptyKind !== null}
          empty={
            emptyKind === 'no-match' ? (
              <CatalogNoMatch query={query} />
            ) : (
              <EmptyState
                icon={RobotIcon}
                size="sm"
                title={tI18nComplete.raw('text971b61f8cb4d')}
                description={tI18nComplete.raw('textc4e4294c6777')}
                action={createButton('Create an agent', 'sm')}
                secondaryAction={
                  <Button asChild variant="ghost" size="sm" className="gap-1.5">
                    <a
                      href="/docs/project/agents"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {tI18nComplete.raw('text7af023c43013')}
                    </a>
                  </Button>
                }
              />
            )
          }
        >
          {primaryAgents.map(renderPrimaryAgentCard)}
        </CatalogGrid>
      )}
      {!detailQuery.isLoading && !detailQuery.isError && subagents.length > 0 ? (
        <section
          aria-labelledby="subagents-heading"
          className={cn('space-y-2', primaryAgents.length > 0 && 'mt-8')}
        >
          <div>
            <h2 id="subagents-heading" className="text-foreground text-sm font-medium">
              {tI18nComplete.raw('agentsListSubagentsTitle')}{' '}
              <span className="text-muted-foreground font-normal tabular-nums">
                {subagents.length}
              </span>
            </h2>
            <p className="text-muted-foreground mt-1 text-xs">
              {tI18nComplete.raw('agentsListSubagentsHint')}
            </p>
          </div>
          <div className={GRID_CLASSNAME}>
            {subagents.map((agent) => (
              <AgentCoverCard
                key={agent.path}
                slug={agent.name}
                href={agentHref(projectId, agent.name)}
                onIntent={() => prefetchAgentConfig(queryClient, projectId, agent.name)}
                title={agentTitle(agent.name)}
                description={agent.description}
                badges={<AgentCardBadges agent={agent} />}
                meta={facts(agent)}
              />
            ))}
          </div>
        </section>
      ) : null}
    </CapabilityPageShell>
  );
}

function agentTitle(name: string): string {
  return isMetaAgentName(name) ? META_AGENT_DISPLAY_NAME : capitalizeWords(name);
}


/**
 * The access fact (KRTX-3025): "Full access", or the connectors an agent can
 * reach. Nothing for an agent without connectors — the card does not list what
 * an agent lacks.
 */
function accessLabelOf(access: ReturnType<typeof agentAccess>, t: UiTranslator): string | null {
  if (!access) return null;
  if (access.kind === 'full') return t.raw('textf19611c61ca5');
  const connectors = access.parts.find((part) => part.kind === 'connectors')?.value ?? 0;
  if (connectors === 'all') return t.raw('textd83250185d41');
  return connectors > 0 ? t('text15589a542412', { count: connectors }) : null;
}

/**
 * The card's facts line, joined by `•`: access, the agent's own model,
 * triggers, grants. A fact with nothing to say is left out — no "0 triggers",
 * no "Default model" — so an empty slot never reads as information.
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
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const facts = [
    accessLabelOf(agentAccess(agent.scope), tI18nComplete),
    agent.model ? agent.model.split('/').pop() : null,
    triggerCount > 0 ? `${triggerCount} ${triggerCount === 1 ? 'trigger' : 'triggers'}` : null,
    grantCount > 0 ? `${grantCount} ${grantCount === 1 ? 'grant' : 'grants'}` : null,
  ].filter((fact): fact is string => Boolean(fact));
  if (facts.length === 0) return null;
  return (
    <span className="truncate tabular-nums">
      {facts.map((fact, index) => (
        <span key={fact}>
          {index > 0 ? (
            <span aria-hidden className="px-1.5">
              •
            </span>
          ) : null}
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
 *
 * v2-only: the default agent is a `kortix.yaml` concept, so a v1 project gets
 * no control instead of one that cannot persist.
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
  // v2 and v3 declare `default_agent` in kortix.yaml; v1 has no such key.
  const declaresDefaultAgent = detectManifestVersion(config.manifest_raw) >= 2;
  // A subagent cannot start a chat, so it is not offered as the default.
  const availableAgents = toArray(config.agents).filter(
    (agent) => agent.enabled !== false && agentInMode(agent, 'primary'),
  );
  const current = config.default_agent ?? config.open_code_default_agent;
  const mutation = useMutation({
    mutationFn: (agentName: string) => updateProjectDefaultAgent(projectId, agentName),
    onSuccess: async (result) => {
      successToast(
        tI18nComplete('text0bb557895b32', { value0: capitalizeWords(result.default_agent) }),
      );
      // One invalidation, not two: the project CONFIG is a `select` projection
      // over this same `qk.project.detail(id)` entry (`useProjectConfig`), not
      // its own fetch. The retired standalone `['project-config', id]` slot no
      // longer exists, so a second call for it would invalidate nothing.
      await queryClient.invalidateQueries({ queryKey: qk.project.detail(projectId) });
    },
    onError: (error: Error) => errorToast(error.message || tI18nComplete.raw('text7f724c2ad694')),
  });

  if (!declaresDefaultAgent || availableAgents.length === 0 || !current) return null;

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
                <span className="truncate">{agentTitle(agent.name)}</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
