'use client';

import { customizePath, uiRoutes } from '../../lib/routes';
import { NewEntityMenu } from '../shared/new-entity-menu';
import { useTranslations as useI18nTranslations } from '../../i18n';
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
import { Skeleton } from '../../primitives/skeleton';
import { useProjectCan } from '../../internal/lib/use-project-can';
import { cn } from '../../internal/lib/utils';
import {
  getProjectDetail,
  listProjectResourceGrants,
  listProjectTriggers,
  type ProjectConfigSummary,
  updateProjectDefaultAgent,
} from '@kortix/sdk';
import { contract, qk, useProjectAccountId } from '@kortix/sdk/react';
import { capitalizeWords, isMetaAgentName, META_AGENT_DISPLAY_NAME } from '@kortix/shared';
import {
  CaretRightIcon,
  MagnifyingGlassIcon,
  RobotIcon,
  StarIcon as StarSolid,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { CapabilityPageShell } from '../shared/capability-page-shell';
import { agentHref } from '../../internal/lib/capability-tab-routes';
import { prefetchAgentConfig } from '../../internal/hooks/projects/use-agent-config';
import { CatalogCard } from '../shared/catalog/catalog-card';
import { catalogEmptyKind } from '../shared/catalog/catalog-empty';
import { CatalogNoMatch } from '../shared/catalog/catalog-empty-state';
import { CatalogGrid } from '../shared/catalog/catalog-grid';
import {
  DENSE_GRID_CLASSNAME,
  DENSE_GRID_CONTAINER_CLASSNAME,
} from '../shared/catalog/catalog-grid-tokens';

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

  // Who is granted each agent — the card's "N people" fact. Same key the
  // agent page's People section reads, manager-gated like it.
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
  const subagentTotal = agents.filter((agent) => !agentInMode(agent, 'primary')).length;
  const primaryTotal = agents.length - subagentTotal;

  // `null` = render the grid. Otherwise which "nothing to show" copy applies:
  // genuinely zero agents vs. agents exist but this filter/search hid all of
  // them. Telling the user "No agents yet" in the second case is false and
  // points at the wrong fix (clear the filter, not create an agent).
  const emptyKind = catalogEmptyKind(agents.length, filtered.length);

  // One control, two labels — same rule as the Skills page. The header has a
  // title beside it and can be terse; the empty state is the whole screen and
  // has to name what it creates. Both start the same configure thread, so they
  // cannot drift apart.
  // `size="sm"` is `h-8` — the same height as the search input beside it in the
  // header group. The Button default is `h-9`, which left the pair 4px
  // mismatched on a row that is centred, so both edges were off.
  const createButton = (label: string) =>
    canWrite ? (
      <NewEntityMenu
        label={label}
        pending={configure.pending}
        onChat={() => configure.start(newConfigPrompt('agent'))}
        manual={{
          description: tI18nComplete.raw('text5210c5acc2cd'),
          href: uiRoutes().files(projectId) ?? customizePath(projectId, 'repo'),
        }}
      />
    ) : null;

  return (
    <CapabilityPageShell
      title={tI18nComplete.raw('text279b44d2ab4b')}
      description={tI18nComplete.raw('text636453e23d69')}
      action={createButton('New')}
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
      filters={
        // The row holds its height while the manifest loads, so the grid
        // below does not drop when the count and the selector land.
        detailQuery.isLoading ? (
          <>
            <Skeleton className="h-4 w-40 rounded-sm py-0" />
            <Skeleton className="h-8 w-44 rounded-md py-0" />
          </>
        ) : config ? (
          <>
            <p className="text-muted-foreground text-xs">
              {primaryTotal} {primaryTotal === 1 ? 'agent' : 'agents'}
              {subagentTotal > 0
                ? ` · ${subagentTotal} ${subagentTotal === 1 ? 'subagent' : 'subagents'}`
                : null}{' '}
              {tI18nComplete.raw('text582967534d0f')}{' '}
              <span className="font-mono">{tI18nComplete.raw('text1965f383021e')}</span>
            </p>
            <DefaultAgentSelector projectId={projectId} config={config} canWrite={canWrite} />
          </>
        ) : undefined
      }
    >
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
              action={createButton('Create an agent')}
              secondaryAction={
                <Button asChild variant="ghost" size="sm" className="gap-1.5">
                  <a
                    href="https://opencode.ai/docs/agents/"
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
        {primaryAgents.map((agent) => (
          <CatalogCard
            key={agent.path}
            href={agentHref(projectId, agent.name)}
            onIntent={() => prefetchAgentConfig(queryClient, projectId, agent.name)}
            title={agentTitle(agent.name)}
            subtitle={<code className="text-muted-foreground text-xs break-all">{agent.name}</code>}
            description={agent.description}
            badges={<AgentCardBadges agent={agent} isDefault={defaultAgent === agent.name} />}
            meta={
              <AgentCardFacts
                agent={agent}
                triggerCount={triggerCounts.get(agent.name) ?? 0}
                peopleCount={canManageMembers ? (grantCounts.get(agent.name) ?? 0) : null}
              />
            }
            trailing={<CardCaret />}
          />
        ))}
      </CatalogGrid>
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
          {/* `-mx-3` cancels the plain card's `px-3`, so each title lines up
              with the heading above it. */}
          <div className={cn(DENSE_GRID_CONTAINER_CLASSNAME, '-mx-3')}>
            <div className={DENSE_GRID_CLASSNAME}>
              {subagents.map((agent) => (
                <CatalogCard
                  key={agent.path}
                  variant="plain"
                  href={agentHref(projectId, agent.name)}
                  onIntent={() => prefetchAgentConfig(queryClient, projectId, agent.name)}
                  title={agentTitle(agent.name)}
                  subtitle={
                    <code className="text-muted-foreground text-xs break-all">{agent.name}</code>
                  }
                  description={agent.description}
                  badges={<AgentCardBadges agent={agent} isDefault={false} />}
                  meta={
                    <span className={cn('truncate', agent.model && 'font-mono')}>
                      {agent.model?.split('/').pop() ?? tI18nComplete.raw('text3840d9d29421')}
                    </span>
                  }
                  trailing={<CardCaret />}
                />
              ))}
            </div>
          </div>
        </section>
      ) : null}
    </CapabilityPageShell>
  );
}

function agentTitle(name: string): string {
  return isMetaAgentName(name) ? META_AGENT_DISPLAY_NAME : capitalizeWords(name);
}

function CardCaret() {
  return (
    <CaretRightIcon
      aria-hidden
      className="text-muted-foreground group-hover:text-foreground mt-0.5 size-4 transition-colors"
    />
  );
}

/**
 * The card's facts line: what the agent runs on, what starts it, and who may
 * use it — the three things a person configuring access wants to know before
 * opening the page. Model falls back to the project default rather than
 * printing nothing; triggers and people print their count, including zero,
 * so every card has the same three slots and the eye can compare down a
 * column. People is omitted for a reader who cannot see grants.
 */
function AgentCardFacts({
  agent,
  triggerCount,
  peopleCount,
}: {
  agent: Agent;
  triggerCount: number;
  peopleCount: number | null;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const model = agent.model ? agent.model.split('/').pop() : null;
  const sep = (
    <span aria-hidden className="text-muted-foreground">
      ·
    </span>
  );
  return (
    <>
      <span className={cn('truncate', model && 'font-mono')}>
        {model ?? tI18nComplete.raw('text3840d9d29421')}
      </span>
      {sep}
      <span className="tabular-nums">
        {triggerCount} {triggerCount === 1 ? 'trigger' : 'triggers'}
      </span>
      {peopleCount !== null ? (
        <>
          {sep}
          <span className="tabular-nums">
            {peopleCount === 0
              ? tI18nComplete.raw('textb6c70926c1aa')
              : `${peopleCount} ${peopleCount === 1 ? 'grant' : 'grants'}`}
          </span>
        </>
      ) : null}
    </>
  );
}

/**
 * Card badges — "also a subagent", the default-agent star, disabled.
 *
 * The section already says primary or subagent, so a mode chip only marks the
 * both-ways `all` agent: it sits with the primaries but other agents call it
 * too.
 */
function AgentCardBadges({ agent, isDefault }: { agent: Agent; isDefault: boolean }) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const mode = agent.mode?.toLowerCase();
  return (
    <>
      {mode === 'all' ? (
        <Badge variant="muted" size="xs">
          {tI18nComplete.raw('agentsListAlsoSubagent')}
        </Badge>
      ) : null}
      {isDefault ? (
        <StarSolid
          weight="fill"
          aria-label={tI18nComplete.raw('text94da52ecd6c5')}
          className="text-kortix-orange size-3.5 shrink-0"
        />
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
      <span className="text-muted-foreground hidden text-xs sm:block">
        {tI18nComplete.raw('text21b111cbfe6e')}
      </span>
      {mutation.isPending ? <Loading className="size-4 shrink-0" /> : null}
      <Select
        value={current}
        onValueChange={(agentName) => mutation.mutate(agentName)}
        disabled={!canWrite || mutation.isPending}
      >
        <SelectTrigger
          aria-label={tI18nComplete.raw('text94da52ecd6c5')}
          className="w-44 shrink-0"
          size="sm"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {availableAgents.map((agent) => (
            <SelectItem key={agent.name} value={agent.name}>
              {isMetaAgentName(agent.name) ? META_AGENT_DISPLAY_NAME : capitalizeWords(agent.name)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
