'use client';

import { NewEntityMenu } from '@/features/workspace/capabilities/shared/new-entity-menu';
import { useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import Loading from '@/components/ui/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { detectManifestVersion } from '@/features/workspace/customize/migrate-to-v2/manifest-version';
import { formatMode, toArray } from '@/features/workspace/customize/shared/utils';
import {
  newConfigPrompt,
  useConfigureThread,
} from '@/features/workspace/customize/use-configure-thread';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import {
  getProjectDetail,
  listProjectResourceGrants,
  listProjectTriggers,
  type ProjectConfigSummary,
  updateProjectDefaultAgent,
} from '@kortix/sdk';
import { contract, qk, useProjectAccountId } from '@kortix/sdk/react';
import { capitalizeWords } from '@kortix/shared';
import {
  CaretRightIcon,
  MagnifyingGlassIcon,
  RobotIcon,
  StarIcon as StarSolid,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { CapabilityPageShell } from '@/features/workspace/capabilities/shared/capability-page-shell';
import { agentHref } from '@/features/workspace/capabilities/shared/capability-tab-routes';
import { CatalogCard } from '@/features/workspace/capabilities/shared/catalog/catalog-card';
import { catalogEmptyKind } from '@/features/workspace/capabilities/shared/catalog/catalog-empty';
import { CatalogNoMatch } from '@/features/workspace/capabilities/shared/catalog/catalog-empty-state';
import { CatalogGrid } from '@/features/workspace/capabilities/shared/catalog/catalog-grid';

import { filterAgents } from './agent-filter';

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

  const [query, setQuery] = useState('');

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
    const fallback = config?.open_code_default_agent ?? null;
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

  // No mode filter (Marko, 2026-09-03): the list is the manifest's `agents:`
  // map, and whether one is a subagent is a chip on its card, not a lens on
  // the list — three agents do not need a tab bar.
  const filtered = useMemo(() => filterAgents(agents, { mode: null, query }), [agents, query]);

  // `null` = render the grid. Otherwise which "nothing to show" copy applies:
  // genuinely zero agents vs. agents exist but this filter/search hid all of
  // them. Telling the user "No agents yet" in the second case is false and
  // points at the wrong fix (clear the filter, not create an agent).
  const emptyKind = catalogEmptyKind(agents.length, filtered.length);
  const defaultAgent = config?.open_code_default_agent ?? null;

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
          description: 'Add an agents entry to kortix.yaml in Files.',
          href: `/projects/${projectId}/files`,
        }}
      />
    ) : null;

  return (
    <CapabilityPageShell
      title="Agents"
      description="Each agent is what a person gets access to. Configure what it knows, what it can reach, and when it runs."
      action={createButton('New')}
      search={
        <InputGroupSearch>
          <InputGroupSearchIcon>
            <MagnifyingGlassIcon />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            placeholder="Search agents"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            variant="popover"
            size="sm"
          />
          <InputGroupSearchClear onClick={() => setQuery('')} />
        </InputGroupSearch>
      }
      filters={
        config ? (
          <>
            <p className="text-muted-foreground text-xs">
              {agents.length} {agents.length === 1 ? 'agent' : 'agents'} in{' '}
              <span className="font-mono">kortix.yaml</span>
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
              title="No agents yet"
              description="Create an agent to customize how sessions run."
              action={createButton('Create an agent')}
              secondaryAction={
                <Button asChild variant="ghost" size="sm" className="gap-1.5">
                  <a
                    href="https://opencode.ai/docs/agents/"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Docs
                  </a>
                </Button>
              }
            />
          )
        }
      >
        {filtered.map((agent) => (
          <CatalogCard
            key={agent.path}
            href={agentHref(projectId, agent.name)}
            title={capitalizeWords(agent.name)}
            description={agent.description}
            badges={<AgentCardBadges agent={agent} isDefault={defaultAgent === agent.name} />}
            meta={
              <AgentCardFacts
                agent={agent}
                triggerCount={triggerCounts.get(agent.name) ?? 0}
                peopleCount={canManageMembers ? (grantCounts.get(agent.name) ?? 0) : null}
              />
            }
            trailing={
              <CaretRightIcon
                aria-hidden
                className="text-muted-foreground/40 group-hover:text-muted-foreground mt-0.5 size-4 transition-colors"
              />
            }
          />
        ))}
      </CatalogGrid>
    </CapabilityPageShell>
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
  const model = agent.model ? agent.model.split('/').pop() : null;
  const sep = (
    <span aria-hidden className="text-muted-foreground/40">
      ·
    </span>
  );
  return (
    <>
      <span className={cn('truncate', model && 'font-mono')}>{model ?? 'Default model'}</span>
      {sep}
      <span className="tabular-nums">
        {triggerCount} {triggerCount === 1 ? 'trigger' : 'triggers'}
      </span>
      {peopleCount !== null ? (
        <>
          {sep}
          <span className="tabular-nums">
            {peopleCount === 0
              ? 'Admins only'
              : `${peopleCount} ${peopleCount === 1 ? 'grant' : 'grants'}`}
          </span>
        </>
      ) : null}
    </>
  );
}

/**
 * Card badges — mode, the default-agent star, disabled.
 *
 * `mode` is omitted when it is the implicit `primary`: every agent would
 * otherwise carry the same badge, which distinguishes nothing and just adds
 * noise to a grid. A subagent (or an explicit both-ways `all`) is the case
 * worth marking.
 */
function AgentCardBadges({ agent, isDefault }: { agent: Agent; isDefault: boolean }) {
  const mode = agent.mode?.toLowerCase();
  return (
    <>
      {mode && mode !== 'primary' ? (
        <Badge variant="muted" size="xs">
          {formatMode(agent.mode ?? '')}
        </Badge>
      ) : null}
      {isDefault ? (
        <StarSolid
          weight="fill"
          aria-label="Default agent"
          className="text-kortix-orange size-3.5 shrink-0"
        />
      ) : null}
      {agent.enabled === false ? (
        <Badge variant="muted" size="xs">
          Disabled
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
  const queryClient = useQueryClient();
  const isV2 = detectManifestVersion(config.manifest_raw) === 2;
  const availableAgents = toArray(config.agents).filter((agent) => agent.enabled !== false);
  const current = config.open_code_default_agent;
  const mutation = useMutation({
    mutationFn: (agentName: string) => updateProjectDefaultAgent(projectId, agentName),
    onSuccess: async (result) => {
      successToast(`${capitalizeWords(result.default_agent)} is now the project default`);
      // One invalidation, not two: the project CONFIG is a `select` projection
      // over this same `qk.project.detail(id)` entry (`useProjectConfig`), not
      // its own fetch. The retired standalone `['project-config', id]` slot no
      // longer exists, so a second call for it would invalidate nothing.
      await queryClient.invalidateQueries({ queryKey: qk.project.detail(projectId) });
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to update default agent'),
  });

  if (!isV2 || availableAgents.length === 0 || !current) return null;

  return (
    <div className="flex shrink-0 items-center gap-2">
      <span className="text-muted-foreground hidden text-xs sm:block">Default</span>
      {mutation.isPending ? <Loading className="size-4 shrink-0" /> : null}
      <Select
        value={current}
        onValueChange={(agentName) => mutation.mutate(agentName)}
        disabled={!canWrite || mutation.isPending}
      >
        <SelectTrigger aria-label="Default agent" className="w-44 shrink-0" size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {availableAgents.map((agent) => (
            <SelectItem key={agent.name} value={agent.name}>
              {capitalizeWords(agent.name)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
