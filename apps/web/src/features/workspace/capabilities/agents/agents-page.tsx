'use client';

import { useEffect, useMemo, useState } from 'react';

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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { detectManifestVersion } from '@/features/workspace/customize/migrate-to-v2/manifest-version';
import { AgentEditorPanel } from '@/features/workspace/customize/sections/view/agent-editor';
import { formatMode, toArray } from '@/features/workspace/customize/shared/utils';
import {
  newConfigPrompt,
  useConfigureThread,
} from '@/features/workspace/customize/use-configure-thread';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import {
  getProjectDetail,
  type ProjectConfigSummary,
  updateProjectDefaultAgent,
} from '@kortix/sdk';
import { contract, qk, useProjectAccountId } from '@kortix/sdk/react';
import { capitalizeWords } from '@kortix/shared';
import {
  MagnifyingGlassIcon,
  PlusIcon,
  RobotIcon,
  StarIcon as StarSolid,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { CapabilityPageShell } from '@/features/workspace/capabilities/shared/capability-page-shell';
import { CatalogCard } from '@/features/workspace/capabilities/shared/catalog/catalog-card';
import { catalogEmptyKind } from '@/features/workspace/capabilities/shared/catalog/catalog-empty';
import {
  CatalogEmptyNote,
  CatalogNoMatch,
} from '@/features/workspace/capabilities/shared/catalog/catalog-empty-state';
import { CatalogGrid } from '@/features/workspace/capabilities/shared/catalog/catalog-grid';
import { detailSelection } from '@/features/workspace/capabilities/shared/detail-selection';
import { EntityDetailModal } from '@/features/workspace/capabilities/shared/entity/entity-modal';

import { AgentDetailAside } from './agent-detail-aside';
import { type AgentMode, filterAgents } from './agent-filter';

type Agent = ProjectConfigSummary['agents'][number];
type ModeFilter = AgentMode | 'all';

const MODE_FILTERS: ReadonlyArray<{ value: ModeFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'primary', label: 'Primary' },
  { value: 'subagent', label: 'Subagents' },
];

/**
 * /projects/[id]/agent — the standalone Agents catalog, and the same page body
 * shape as Skills: header + search + filter tabs, a card grid, and a detail
 * modal. It replaces the Customize overlay's master-detail Agents section,
 * which packed a list, a source pane and a settings aside into one fixed
 * three-column shell.
 *
 * Reads `config.agents` off the shared `['project-detail', projectId]` query,
 * so this page and everything else showing a project's agents cannot disagree
 * about what they are. `toArray` because the API can return the field as
 * `undefined` for a repo-less / capability-gated / config-build-failure
 * project, and `.filter` on that throws into prod Sentry.
 *
 * Card click opens `EntityDetailModal` on that agent: its markdown source in
 * the middle, its assignments + configuration cards in the aside.
 * `selectedPath` is looked up against the unfiltered `agents` list, not
 * `filtered` — so typing into search while the modal is open cannot yank it
 * shut. See `shared/detail-selection.ts` for why `open` follows the selection
 * alone.
 */
export function AgentsPage({ projectId }: { projectId: string }) {
  // `accountId` skips useProjectCan's own getProject and lets the IAM probe
  // run on the first render instead of waiting a round-trip for it.
  const accountId = useProjectAccountId(projectId);
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_AGENT_WRITE, { accountId }).allowed === true;
  const configure = useConfigureThread(projectId);

  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<ModeFilter>('all');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // When set, the detail modal's source pane is swapped for the agent
  // configuration editor (`paneOverride`) — a pane, not a modal on a modal.
  const [editorOpen, setEditorOpen] = useState(false);

  const detailQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
  });
  const config = detailQuery.data?.config ?? null;

  const agents = useMemo(() => toArray(config?.agents), [config]);

  const modeArg = mode === 'all' ? null : mode;
  const filtered = useMemo(
    () => filterAgents(agents, { mode: modeArg, query }),
    [agents, modeArg, query],
  );

  // Unfiltered lookup (see the component doc comment above) — deliberately not
  // `filtered.find(...)`.
  const detail = detailSelection({
    selection: selectedPath,
    record: agents.find((agent) => agent.path === selectedPath),
    isSuccess: detailQuery.isSuccess,
  });

  // The one honest auto-close: the config came back and this agent is not in
  // it, so it really was deleted or renamed.
  useEffect(() => {
    if (detail.isMissing) setSelectedPath(null);
  }, [detail.isMissing]);

  // Switching agents (or closing the modal) always drops back to the source
  // pane — an editor left open for agent A must never frame agent B's files.
  // Adjusted during render: React's documented alternative to a
  // setState-in-effect reset (same trick, no cascading render).
  const [prevPath, setPrevPath] = useState(selectedPath);
  if (prevPath !== selectedPath) {
    setPrevPath(selectedPath);
    setEditorOpen(false);
  }

  // `null` = render the grid. Otherwise which "nothing to show" copy applies:
  // genuinely zero agents vs. agents exist but this filter/search hid all of
  // them. Telling the user "No agents yet" in the second case is false and
  // points at the wrong fix (clear the filter, not create an agent).
  const emptyKind = catalogEmptyKind(agents.length, filtered.length);
  const modeLabel = MODE_FILTERS.find((filter) => filter.value === mode)?.label ?? 'All';
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
      <Button
        variant="secondary"
        size="sm"
        onClick={() => configure.start(newConfigPrompt('agent'))}
        disabled={configure.pending}
      >
        {configure.pending ? (
          <Loading className="size-4 shrink-0" />
        ) : (
          <PlusIcon className="size-4" />
        )}
        {label}
      </Button>
    ) : null;

  return (
    <CapabilityPageShell
      title="Agents"
      description="Who does the work — each one's instructions, model, and access."
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
        <>
          <Tabs value={mode} onValueChange={(value) => setMode(value as ModeFilter)}>
            <TabsList>
              {MODE_FILTERS.map((filter) => (
                <TabsTrigger key={filter.value} value={filter.value}>
                  {filter.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {config ? (
            <DefaultAgentSelector projectId={projectId} config={config} canWrite={canWrite} />
          ) : null}
        </>
      }
    >
      <CatalogGrid
        isLoading={detailQuery.isLoading}
        isError={detailQuery.isError}
        onRetry={() => detailQuery.refetch()}
        isEmpty={emptyKind !== null}
        empty={
          emptyKind === 'no-match' ? (
            query.trim() ? (
              <CatalogNoMatch query={query} />
            ) : (
              <CatalogEmptyNote>No matches in {modeLabel}.</CatalogEmptyNote>
            )
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
            title={capitalizeWords(agent.name)}
            description={agent.description}
            badges={<AgentCardBadges agent={agent} isDefault={defaultAgent === agent.name} />}
            onClick={() => setSelectedPath(agent.path)}
          />
        ))}
      </CatalogGrid>
      <EntityDetailModal
        projectId={projectId}
        entity={detail.record}
        kind="agent"
        open={detail.open}
        isResolving={detail.isResolving}
        meta={
          detail.record && config ? <AgentDetailMeta agent={detail.record} config={config} /> : null
        }
        aside={
          detail.record && config ? (
            <AgentDetailAside
              projectId={projectId}
              agent={detail.record}
              config={config}
              onEditConfig={() => setEditorOpen(true)}
            />
          ) : null
        }
        paneOverride={
          editorOpen && detail.record && config ? (
            <AgentEditorPanel
              projectId={projectId}
              agentName={detail.record.name}
              skillsOptions={toArray(config.skills).map((skill) => ({
                id: skill.name,
                label: skill.name,
              }))}
              onClose={() => setEditorOpen(false)}
            />
          ) : null
        }
        onOpenChange={(next) => {
          if (!next) setSelectedPath(null);
        }}
      />
    </CapabilityPageShell>
  );
}

/**
 * Card badges — mode, and the default-agent star.
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
 * Status chips beside the modal title. Only states worth flagging:
 *
 *  - mode, when it is NOT the implicit `primary` — a "Primary" chip on every
 *    agent distinguishes nothing.
 *  - default, disabled — both are exceptions by definition.
 *
 * The declaring file is deliberately absent. It was a `kortix.yaml` chip, but
 * a file is a value, not a status, and the modal now prints the real source
 * path under the title — which says the same thing and is clickable-accurate.
 */
function AgentDetailMeta({ agent, config }: { agent: Agent; config: ProjectConfigSummary }) {
  const mode = agent.mode?.toLowerCase();
  return (
    <>
      {mode && mode !== 'primary' ? (
        <Badge variant="outline" size="sm" className="text-muted-foreground font-medium">
          {formatMode(agent.mode ?? '')}
        </Badge>
      ) : null}
      {config.open_code_default_agent === agent.name ? (
        <Badge variant="outline" size="sm" className="text-muted-foreground gap-1 font-medium">
          <StarSolid weight="fill" className="text-kortix-orange size-3.5 shrink-0" />
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
