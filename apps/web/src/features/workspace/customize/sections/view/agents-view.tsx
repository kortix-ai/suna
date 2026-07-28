'use client';

/**
 * Agents — one ProjectSectionPage, one search, one list, one detail.
 *
 * What this replaces: the generic customize-section shell in `split` layout,
 * which drew its OWN search inside a left rail, its own "Default agent" strip
 * above that rail, and then a THIRD fixed rail on the right holding four
 * always-expanded cards (assignments, governance, model, access scope). Three
 * rails and two search fields for one screen — see
 * the design references.
 *
 * Now:
 *   - The shell is the shared project-section page: one h1, ONE line of
 *     description, search top-right, "New agent" as the single primary action.
 *   - The default-agent picker is a compact labelled Select in that same header
 *     cluster, so it is always visible instead of scrolling away with the list.
 *   - The master-detail split stays (list left, editor right) — that is a split,
 *     not a rail-inside-rail. The third rail is gone; its cards moved into the
 *     detail column.
 *   - Everything that is not "which model does this agent run on" sits behind
 *     ONE collapsed Advanced disclosure. Nothing was removed.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { errorToast, successToast } from '@/components/ui/toast';
import { AgentAdvanced } from '@/features/workspace/agents/agent-advanced';
import { AgentAssignments } from '@/features/workspace/agents/agent-assignments';
import { AgentDetail } from '@/features/workspace/agents/agent-detail';
import { AgentList } from '@/features/workspace/agents/agent-list';
import { AgentModel } from '@/features/workspace/agents/agent-model';
import { AgentScope } from '@/features/workspace/agents/agent-scope';
import Link from 'next/link';

import { useMarketplaceEnabled } from '@/components/projects/marketplace/marketplace-nav';
import { detectManifestVersion } from '@/features/workspace/customize/migrate-to-v2/manifest-version';
import { AgentConfigEditor } from '@/features/workspace/customize/sections/view/agent-editor';
import { formatMode, toArray } from '@/features/workspace/customize/shared/utils';
import {
  newConfigPrompt,
  useConfigureThread,
} from '@/features/workspace/customize/use-configure-thread';
import {
  ProjectSectionPage,
  type ProjectSectionState,
} from '@/features/workspace/project-section/project-section-page';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import {
  type ProjectConfigSummary,
  getProjectDetail,
  updateProjectDefaultAgent,
} from '@kortix/sdk';
import { StarSolid } from '@mynaui/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Plus, Store } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';

type Agent = ProjectConfigSummary['agents'][number];

const AGENT_DOCS = 'https://opencode.ai/docs/agents/';

function agentMatches(agent: Agent, q: string) {
  return (
    agent.name.toLowerCase().includes(q) || (agent.description?.toLowerCase().includes(q) ?? false)
  );
}

export function AgentsView({
  projectId,
  navTabs,
}: {
  projectId: string;
  /** The persistent section tab strip, when this renders as a route. */
  navTabs?: ReactNode;
}) {
  const canWrite = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_AGENT_WRITE).allowed === true;
  const configure = useConfigureThread(projectId);

  const detailQuery = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    staleTime: 10_000,
  });
  const config = detailQuery.data?.config ?? null;
  // `config.agents` is typed as a required array but the API can return it as
  // `undefined` (or a non-array) for repo-less / capability-gated / config-build
  // failure states — see chunk22256-guard.test.ts. Never call .filter/.map raw.
  const agents = useMemo(() => (config ? toArray(config.agents) : []), [config]);

  const [query, setQuery] = useState('');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter((agent) => agentMatches(agent, q));
  }, [agents, query]);

  // The detail column follows this; falls back to the first visible agent so
  // there is always something previewed.
  const selected = filtered.find((a) => a.path === selectedPath) ?? filtered[0] ?? null;

  const errorMessage = (detailQuery.error as Error)?.message ?? '';
  const isForbidden = detailQuery.isError && /403|forbidden/i.test(errorMessage);

  const state: ProjectSectionState = detailQuery.isLoading
    ? 'loading'
    : isForbidden
      ? 'forbidden'
      : detailQuery.isError
        ? 'error'
        : agents.length === 0
          ? 'empty'
          : filtered.length === 0
            ? 'no-results'
            : 'ready';

  // The old header used MarketplaceSectionButton, whose entire onClick is
  // customizeStore.setSection('marketplace') — it never sets `open`, so on this
  // route it was a dead click that also silently repointed where the overlay
  // would next open. Marketplace is a real route; link to it.
  const marketplaceLink = useMarketplaceEnabled(projectId) ? (
    <Button asChild size="sm" variant="secondary">
      <Link href={`/projects/${projectId}/marketplace`}>
        <Store className="size-3 shrink-0" />
        Marketplace
      </Link>
    </Button>
  ) : null;

  const newAgentButton = canWrite ? (
    <Button
      type="button"
      size="sm"
      onClick={() => configure.start(newConfigPrompt('agent'))}
      disabled={configure.pending}
    >
      {configure.pending ? <Loading className="size-4 shrink-0" /> : <Plus className="size-4" />}
      New agent
    </Button>
  ) : null;

  return (
    <ProjectSectionPage
      navTabs={navTabs}
      title="Agents"
      description="Reusable personas that run your sessions, each with its own prompt and model."
      docsHref={AGENT_DOCS}
      search={{ value: query, onChange: setQuery, placeholder: 'Search agents' }}
      action={
        <>
          {config ? (
            <DefaultAgentSelector projectId={projectId} config={config} canWrite={canWrite} />
          ) : null}
          {marketplaceLink}
          {newAgentButton}
        </>
      }
      state={state}
      // The split needs the full frame; the ladder states read better narrow.
      width={state === 'ready' ? 'full' : 'default'}
      errorProps={{
        title: 'Failed to load agents',
        description: errorMessage || 'Failed to load agents',
        action: (
          <Button variant="outline" size="sm" onClick={() => detailQuery.refetch()}>
            Retry
          </Button>
        ),
      }}
      forbiddenMessage="You don't have permission to read this repository."
      emptyProps={{
        icon: Bot,
        title: 'No agents yet',
        description: 'Create an agent to customize how sessions run.',
        action: newAgentButton ?? undefined,
        secondaryAction: (
          <Button asChild variant="ghost" size="sm">
            <a href={AGENT_DOCS} target="_blank" rel="noopener noreferrer">
              Docs
            </a>
          </Button>
        ),
      }}
      noResultsMessage="No agents match that search."
    >
      {config && selected ? (
        <div className="flex min-h-0 flex-col lg:h-full lg:flex-row">
          <AgentList
            agents={filtered}
            selectedPath={selected.path}
            defaultAgentName={config.open_code_default_agent}
            onSelect={setSelectedPath}
          />
          <AgentDetail
            key={selected.path}
            projectId={projectId}
            agent={selected}
            canWrite={canWrite}
            emptyBodyLabel="Agent body is empty. Add prompt content below the frontmatter."
            meta={<AgentMeta agent={selected} config={config} />}
          >
            {/* Visible: the one control people actually reach for. */}
            <AgentModel projectId={projectId} agentName={selected.name} />
            {/* Everything else, collapsed — nothing removed, one disclosure. */}
            <AgentAdvanced>
              <AgentAssignments projectId={projectId} agentName={selected.name} />
              <AgentConfigEditor
                projectId={projectId}
                agent={selected}
                skillsOptions={toArray(config.skills).map((s) => ({ id: s.name, label: s.name }))}
                fallback={
                  <AgentScope
                    projectId={projectId}
                    agentName={selected.name}
                    scope={selected.scope}
                  />
                }
              />
            </AgentAdvanced>
          </AgentDetail>
        </div>
      ) : null}
    </ProjectSectionPage>
  );
}

/** Mode / source / default / disabled badges above the agent's name. */
function AgentMeta({ agent, config }: { agent: Agent; config: ProjectConfigSummary }) {
  return (
    <>
      {agent.mode ? (
        <Badge variant="outline" size="sm" className="text-muted-foreground font-medium">
          {formatMode(agent.mode)}
        </Badge>
      ) : null}
      {agent.source ? (
        <Badge variant="outline" size="sm" className="text-muted-foreground font-mono">
          {agent.source === 'opencode'
            ? 'OpenCode'
            : detectManifestVersion(config.manifest_raw) === 2
              ? 'kortix.yaml'
              : 'kortix.toml'}
        </Badge>
      ) : null}
      {config.open_code_default_agent === agent.name ? (
        <Badge variant="outline" size="sm" className="text-muted-foreground gap-1 font-medium">
          <StarSolid className="text-kortix-orange size-3.5 shrink-0" />
          Default
        </Badge>
      ) : null}
      {agent.enabled === false ? (
        <Badge variant="muted" size="sm">
          Disabled
        </Badge>
      ) : null}
    </>
  );
}

/**
 * The project default agent, as a compact labelled Select in the page header's
 * right cluster. It used to be a two-line explainer strip pinned above the
 * list, which scrolled out of reach on a long project; the explanation now
 * lives in the Hint so the control itself stays one field wide and always
 * visible.
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
      successToast(`${result.default_agent} is now the project default`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['project-detail', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['project-config', projectId] }),
      ]);
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to update default agent'),
  });

  if (!isV2 || availableAgents.length === 0 || !current) return null;

  return (
    <Hint label="New chats in this project start with this agent selected." side="bottom">
      <div className="flex shrink-0 items-center gap-1.5">
        <span className="text-muted-foreground hidden text-xs font-medium sm:inline">Default</span>
        {mutation.isPending ? <Loading className="size-4 shrink-0" /> : null}
        <Select
          value={current}
          onValueChange={(agentName) => mutation.mutate(agentName)}
          disabled={!canWrite || mutation.isPending}
        >
          <SelectTrigger aria-label="Default agent" className="h-8 w-36 shrink-0" variant="popover">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {availableAgents.map((agent) => (
              <SelectItem key={agent.name} value={agent.name}>
                {agent.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </Hint>
  );
}

export default AgentsView;
