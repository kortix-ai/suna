'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { errorToast, successToast } from '@/components/ui/toast';
import { ModelSelector } from '@/features/session/model-selector';
import { flattenModels } from '@/features/session/session-chat-input';
import { AgentConfigEditor } from '@/features/workspace/customize/sections/view/agent-editor';
import { ConfigEntityView } from '@/features/workspace/customize/sections/component/config-entity-view';
import {
  detectManifestVersion,
  type ManifestVersion,
  useProjectManifestVersion,
} from '@/features/workspace/customize/migrate-to-v2/manifest-version';
import { formatMode, toArray } from '@/features/workspace/customize/shared/utils';
import { useModelDefaults } from '@/hooks/opencode/use-model-defaults';
import { useOpenCodeProviders } from '@/hooks/opencode/use-opencode-sessions';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import {
  type AgentGrantSet,
  type ProjectConfigSummary,
  listConnectors,
  listProjectAccess,
  listProjectResourceGrants,
  listProjectSecrets,
  setAgentScope,
  updateProjectDefaultAgent,
} from '@kortix/sdk/projects-client';
import { StarSolid } from '@mynaui/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Check, ShieldCheck, Sparkles, User, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

type Agent = ProjectConfigSummary['agents'][number];

export function AgentsView({ projectId }: { projectId: string }) {
  const canWrite = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_AGENT_WRITE).allowed === true;
  return (
    <ConfigEntityView<Agent>
      projectId={projectId}
      kind="agent"
      noun="agent"
      layout="split"
      canWrite={canWrite}
      title="Agents"
      searchPlaceholder="Search agents"
      emptyIcon={Bot}
      emptyTitle="No agents yet"
      emptyDescription="Create an agent to customize how sessions run."
      emptyDocsHref="https://opencode.ai/docs/agents/"
      emptyBodyLabel="Agent body is empty. Add prompt content below the frontmatter."
      select={(config) => config.agents}
      renderContext={(config) => (
        <DefaultAgentSelector projectId={projectId} config={config} canWrite={canWrite} />
      )}
      renderTriggerLabel={(agent) => agent.name}
      className=' p-4  lg:py-0'
      renderRowTrailing={(agent, config) => (
        <>
          {agent.mode ? (
            <Badge variant="muted" size="xs">
              {formatMode(agent.mode)}
            </Badge>
          ) : null}
          {config.open_code_default_agent === agent.name ? (
            <StarSolid className="text-kortix-orange size-4 shrink-0 fill-current" />
          ) : null}
        </>
      )}
      renderDetailTitle={(agent) => agent.name}
      renderDetailMeta={(agent, config) => (
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
      )}
      renderDetailExtra={(agent, config) => (
        <div className="space-y-3">
          <AgentAssignments projectId={projectId} agentName={agent.name} />
          <AgentConfigEditor
            projectId={projectId}
            agent={agent}
            skillsOptions={toArray(config.skills).map((s) => ({ id: s.name, label: s.name }))}
            fallback={
              <>
                <AgentModel projectId={projectId} agentName={agent.name} />
                <AgentScope projectId={projectId} agentName={agent.name} scope={agent.scope} />
              </>
            }
          />
        </div>
      )}
    />
  );
}

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
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-foreground text-sm font-medium">Default agent</p>
        <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
          New chats in this project start with this agent selected.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {mutation.isPending ? <Loading className="size-4 shrink-0" /> : null}
        <Select
          value={current}
          onValueChange={(agentName) => mutation.mutate(agentName)}
          disabled={!canWrite || mutation.isPending}
        >
          <SelectTrigger
            aria-label="Default agent"
            className="w-48 shrink-0"
            variant="popover"
          >
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
    </div>
  );
}

/**
 * Who inherits this agent — the members/groups assigned to it (Members →
 * Resource access). Each inherits the agent's declared secrets & connectors as
 * their own. Manager-only data: gated on a LIVE can_manage capability so it never
 * fires the manager-only grants endpoint (no 403 / error toast) and never renders
 * stale cached assignments to someone whose manager role was just revoked.
 */
function AgentAssignments({ projectId, agentName }: { projectId: string; agentName: string }) {
  const accessQuery = useQuery({
    queryKey: ['project-access', projectId],
    queryFn: () => listProjectAccess(projectId),
    staleTime: 20_000,
  });
  const canManage = Boolean(accessQuery.data?.can_manage);
  const grantsQuery = useQuery({
    queryKey: ['project-resource-grants', projectId],
    queryFn: () => listProjectResourceGrants(projectId),
    enabled: canManage,
    retry: false,
    staleTime: 30_000,
  });
  // Live capability gate: even if the grants cache still holds data from when the
  // viewer was a manager, a now-non-manager never sees it.
  if (!canManage) return null;
  const assigned = (grantsQuery.data?.grants ?? []).filter(
    (g) => g.resource_type === 'agent' && g.resource_id === agentName,
  );
  if (assigned.length === 0) return null;
  return (
    <div className="border-border/60 bg-muted/20 space-y-2.5 rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <Users className="text-muted-foreground/70 size-3.5 shrink-0" />
        <span className="text-foreground/80 text-xs font-medium">Assigned to</span>
        <Badge variant="muted" size="xs">
          {assigned.length}
        </Badge>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {assigned.map((g) => (
          <Badge key={g.grant_id} variant="outline" size="xs" className="gap-1 font-medium">
            {g.principal_type === 'group' ? (
              <Users className="size-3 shrink-0" />
            ) : (
              <User className="size-3 shrink-0" />
            )}
            {g.principal_label}
            {g.principal_type === 'group' ? ' · group' : ''}
          </Badge>
        ))}
      </div>
      <p className="text-muted-foreground/50 text-[11px] leading-relaxed">
        These members &amp; groups inherit this agent's declared secrets &amp; connectors
        (below) as their own — usable in Secrets, sessions, and connector calls.
      </p>
    </div>
  );
}

/**
 * Which model this agent runs on. Sets the per-agent gateway default (scope=agent,
 * DB-backed, instant — no git commit): a session for this agent that asks for the
 * synthetic `auto` model resolves to this pick. When unset, the agent falls back
 * to the project → account → platform default. Manager-gated (the model-defaults
 * route asserts `manage`); everyone else sees the read-only resolved model.
 */
function AgentModel({ projectId, agentName }: { projectId: string; agentName: string }) {
  const accessQuery = useQuery({
    queryKey: ['project-access', projectId],
    queryFn: () => listProjectAccess(projectId),
    staleTime: 20_000,
  });
  const canManage = Boolean(accessQuery.data?.can_manage);
  const { data: providers } = useOpenCodeProviders();
  const models = useMemo(() => flattenModels(providers), [providers]);
  const defaults = useModelDefaults(projectId);
  const explicit = defaults.agentDefaults[agentName] ?? null;
  const resolved = defaults.resolveDefaultFor(agentName) ?? null;

  const nameOf = (m: { providerID: string; modelID: string } | null) =>
    m
      ? (models.find((x) => x.providerID === m.providerID && x.modelID === m.modelID)?.modelName ??
        `${m.providerID}/${m.modelID}`)
      : null;

  return (
    <div className="border-border/60 bg-muted/20 space-y-2.5 rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <Sparkles className="text-muted-foreground/70 size-3.5 shrink-0" />
        <span className="text-foreground/80 text-xs font-medium">Model</span>
        {explicit ? (
          <Badge variant="muted" size="xs">
            Pinned
          </Badge>
        ) : null}
      </div>

      {canManage ? (
        <div className="flex flex-wrap items-center gap-2">
          <ModelSelector
            models={models}
            providers={providers}
            selectedModel={explicit}
            onSelect={(m) => {
              if (m) {
                void defaults.setAgentDefault(agentName, m);
                successToast(`${agentName} → ${nameOf(m)}`);
              } else {
                void defaults.clearAgentDefault(agentName);
              }
            }}
          />
          {explicit ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => {
                void defaults.clearAgentDefault(agentName);
                successToast(`${agentName} follows the default model again`);
              }}
            >
              Reset to default
            </Button>
          ) : null}
        </div>
      ) : (
        <Badge variant="outline" size="sm" className="font-mono">
          {nameOf(resolved) ?? 'Auto'}
        </Badge>
      )}

      <p className="text-muted-foreground/50 text-[11px] leading-relaxed">
        {explicit ? (
          <>
            Every session run by <span className="font-medium">{agentName}</span> uses{' '}
            <span className="font-medium">{nameOf(explicit)}</span>.
          </>
        ) : (
          <>
            Follows the project / account default
            {resolved ? (
              <>
                {' '}
                (<span className="font-medium">{nameOf(resolved)}</span>)
              </>
            ) : null}
            . Pick a model to pin this agent to it.
          </>
        )}
      </p>
    </div>
  );
}

/**
 * An agent's manifest allowlist (`agents:` in kortix.yaml, or the legacy
 * `[[agents]]` in kortix.toml) — which secrets it receives in $ENV, which
 * connectors it may call, which Kortix-CLI powers it has. Editors EDIT
 * secrets + connectors here (persisted straight to the manifest); everyone
 * else sees the read-only mirror. `kortix_cli` stays read-only (a sharper
 * escalation, manifest-only). Absent for OpenCode-discovered agents, which
 * aren't governed by the manifest.
 */
function AgentScope({
  projectId,
  agentName,
  scope,
}: {
  projectId: string;
  agentName: string;
  scope?: Agent['scope'];
}) {
  // Pure prop-guard (no hooks) so the editable inner component can call hooks
  // unconditionally — an OpenCode agent with no scope simply renders nothing.
  if (!scope) return null;
  return <AgentScopeCard projectId={projectId} agentName={agentName} scope={scope} />;
}

function AgentScopeCard({
  projectId,
  agentName,
  scope,
}: {
  projectId: string;
  agentName: string;
  scope: NonNullable<Agent['scope']>;
}) {
  const queryClient = useQueryClient();
  const { version: manifestVersion } = useProjectManifestVersion(projectId);
  const accessQuery = useQuery({
    queryKey: ['project-access', projectId],
    queryFn: () => listProjectAccess(projectId),
    staleTime: 20_000,
  });
  const canManage = Boolean(accessQuery.data?.can_manage);

  const [env, setEnv] = useState<AgentGrantSet>(scope.env);
  const [connectors, setConnectors] = useState<AgentGrantSet>(scope.connectors);
  // Bumped on Reset to remount the editors so their local "specific" latch reseeds
  // from the restored value (agent switches already remount via the keyed pane).
  const [editorNonce, setEditorNonce] = useState(0);
  // Reset local edits whenever the committed scope changes (agent switch, or a
  // save landed and the config query refetched) so the form tracks the source.
  useEffect(() => {
    setEnv(scope.env);
    setConnectors(scope.connectors);
  }, [agentName, scope.env, scope.connectors]);

  const secretsQuery = useQuery({
    queryKey: ['project-secrets', projectId],
    queryFn: () => listProjectSecrets(projectId),
    enabled: canManage,
    staleTime: 30_000,
  });
  const connectorsQuery = useQuery({
    queryKey: ['project-connectors', projectId],
    queryFn: () => listConnectors(projectId),
    enabled: canManage,
    staleTime: 30_000,
  });

  const secretOptions = useMemo(() => {
    const names = new Set((secretsQuery.data?.items ?? []).map((s) => s.name));
    return [...names].sort().map((name) => ({ id: name, label: name }));
  }, [secretsQuery.data]);
  const connectorOptions = useMemo(
    () =>
      (connectorsQuery.data?.connectors ?? [])
        .map((c) => ({ id: c.slug, label: c.name || c.slug }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [connectorsQuery.data],
  );

  const dirty = !grantSetEqual(env, scope.env) || !grantSetEqual(connectors, scope.connectors);
  const save = useMutation({
    mutationFn: () => setAgentScope(projectId, agentName, { env, connectors }),
    onSuccess: () => {
      successToast(`Scope updated for ${agentName}`);
      // Refetch the project config so the committed scope (this card's source) updates.
      queryClient.invalidateQueries({ queryKey: ['project-detail', projectId] });
    },
    onError: (e: Error) => errorToast(e.message || 'Failed to update scope'),
  });

  // Non-managers get the read-only mirror (the old presentation).
  if (!canManage) {
    return (
      <div className="border-border/60 bg-muted/20 space-y-2.5 rounded-lg border p-4">
        <ScopeHeader manifestVersion={manifestVersion} />
        <ScopeRow label="Secrets" value={scope.env} />
        <ScopeRow label="Connectors" value={scope.connectors} />
        <ScopeRow label="CLI" value={scope.kortix_cli} />
        <p className="text-muted-foreground/50 text-[11px] leading-relaxed">
          “All” = every item the launching user can see; “None” = fully scoped out. Members you
          assign to this agent (Members → Resource access) inherit its declared secrets &amp;
          connectors.
        </p>
      </div>
    );
  }

  return (
    <div className="border-border/60 bg-muted/20 space-y-4 rounded-lg border p-4">
      <ScopeHeader manifestVersion={manifestVersion} />
      <ScopeEditor
        key={`env-${editorNonce}`}
        label="Secrets"
        allLabel="All the launcher can see"
        emptyLabel="No secrets in this project yet."
        value={env}
        options={secretOptions}
        onChange={setEnv}
      />
      <ScopeEditor
        key={`connectors-${editorNonce}`}
        label="Connectors"
        allLabel="Every project connector"
        emptyLabel="No connectors in this project yet."
        value={connectors}
        options={connectorOptions}
        onChange={setConnectors}
      />
      <ScopeRow label="CLI" value={scope.kortix_cli} />
      <div className="border-border/50 flex items-center justify-between gap-3 border-t pt-3">
        <p className="text-muted-foreground/60 text-[11px] leading-relaxed">
          Members assigned to this agent inherit exactly these secrets &amp; connectors. Saved to{' '}
          <span className="font-mono">{manifestVersion === 2 ? 'kortix.yaml' : 'kortix.toml'}</span>.
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {dirty && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={save.isPending}
              onClick={() => {
                setEnv(scope.env);
                setConnectors(scope.connectors);
                setEditorNonce((n) => n + 1);
              }}
            >
              Reset
            </Button>
          )}
          <Button
            size="sm"
            className="h-7 gap-1.5 px-3 text-xs"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending && <Loading className="size-3.5 shrink-0" />}
            Save scope
          </Button>
        </div>
      </div>
    </div>
  );
}

function ScopeHeader({ manifestVersion }: { manifestVersion: ManifestVersion | null }) {
  return (
    <div className="flex items-center gap-2">
      <ShieldCheck className="text-muted-foreground/70 size-3.5 shrink-0" />
      <span className="text-foreground/80 text-xs font-medium">Access scope</span>
      <Badge variant="muted" size="xs" className="font-mono">
        {manifestVersion === 2 ? 'kortix.yaml agents:' : 'kortix.toml [[agents]]'}
      </Badge>
    </div>
  );
}

/** True when two grant sets mean the same thing (order-insensitive). */
function grantSetEqual(a: AgentGrantSet, b: AgentGrantSet): boolean {
  if (a === 'all' || b === 'all') return a === b;
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
}

/**
 * Three-way scope control: All · Specific · None. In "Specific" mode it shows a
 * checklist of the project's secrets/connectors; a declared name that no longer
 * exists as a resource still shows (flagged) so it can be removed.
 */
function ScopeEditor({
  label,
  allLabel,
  emptyLabel,
  value,
  options,
  onChange,
}: {
  label: string;
  allLabel: string;
  emptyLabel: string;
  value: AgentGrantSet;
  options: { id: string; label: string }[];
  onChange: (v: AgentGrantSet) => void;
}) {
  // "Specific" with nothing selected yet is a real UI state the value type can't
  // hold — an empty list is indistinguishable from "None". So we latch the user's
  // choice locally: without this, clicking Specific from All writes `[]`, which
  // re-derives to None and the checklist never opens (the button looks dead). The
  // detail pane is keyed per agent, so this state remounts and never bleeds across
  // agents; picking an item makes the value itself specific and the latch moot.
  const [wantSpecific, setWantSpecific] = useState(value !== 'all' && value.length > 0);
  const mode: 'all' | 'specific' | 'none' =
    value === 'all' ? 'all' : value.length > 0 || wantSpecific ? 'specific' : 'none';
  const selected = value === 'all' ? new Set<string>() : new Set(value);
  const optionIds = new Set(options.map((o) => o.id));
  // Selected names that aren't in the current option list (deleted resource, or
  // typed via kortix.yaml) — keep them visible so they can be unchecked.
  const orphanRows = [...selected]
    .filter((id) => !optionIds.has(id))
    .map((id) => ({ id, label: id }));
  const rows = [...options, ...orphanRows];

  const pick = (m: 'all' | 'specific' | 'none') => {
    setWantSpecific(m === 'specific');
    if (m === 'all') return onChange('all');
    if (m === 'none') return onChange([]);
    // → specific: keep the current concrete list ('all' starts empty). The latch
    // above keeps us in specific mode even while the list is empty.
    onChange(value === 'all' ? [] : value);
  };
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange([...next]);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground/70 w-24 shrink-0 text-[11px] font-medium tracking-wide uppercase">
          {label}
        </span>
        <div className="border-border/70 inline-flex overflow-hidden rounded-md border">
          {(['all', 'specific', 'none'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => pick(m)}
              className={cn(
                'px-2.5 py-1 text-xs capitalize transition-colors',
                mode === m
                  ? 'bg-secondary text-foreground font-medium'
                  : 'text-muted-foreground hover:bg-muted/50',
              )}
            >
              {m}
            </button>
          ))}
        </div>
        {mode === 'all' && <span className="text-muted-foreground/60 text-[11px]">{allLabel}</span>}
      </div>

      {mode === 'specific' &&
        (rows.length === 0 ? (
          <p className="text-muted-foreground/60 pl-[6.5rem] text-[11px]">{emptyLabel}</p>
        ) : (
          <div className="border-border/60 ml-[6.5rem] max-h-44 overflow-y-auto rounded-md border p-1">
            {rows.map((o) => {
              const isSel = selected.has(o.id);
              const isOrphan = !optionIds.has(o.id);
              return (
                <button
                  key={o.id}
                  type="button"
                  aria-pressed={isSel}
                  onClick={() => toggle(o.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs transition-colors',
                    isSel ? 'bg-secondary' : 'hover:bg-muted/50',
                  )}
                >
                  <span
                    className={cn(
                      'flex size-4 shrink-0 items-center justify-center rounded border',
                      isSel
                        ? 'border-foreground bg-foreground text-background'
                        : 'border-border/70',
                    )}
                  >
                    {isSel && <Check className="size-3" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono">{o.label}</span>
                  {isOrphan && <span className="text-kortix-orange">missing</span>}
                </button>
              );
            })}
          </div>
        ))}
    </div>
  );
}

function ScopeRow({ label, value }: { label: string; value: string[] | 'all' }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1.5">
      <span className="text-muted-foreground/70 w-24 shrink-0 text-[11px] font-medium tracking-wide uppercase">
        {label}
      </span>
      {value === 'all' ? (
        <Badge variant="muted" size="xs">
          All
        </Badge>
      ) : value.length === 0 ? (
        <Badge variant="muted" size="xs">
          None
        </Badge>
      ) : (
        value.map((key) => (
          <Badge key={key} variant="outline" size="xs" className="font-mono">
            {key}
          </Badge>
        ))
      )}
    </div>
  );
}
