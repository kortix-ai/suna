'use client';

/**
 * An agent's manifest allowlist (`agents:` in kortix.yaml, or the legacy
 * `[[agents]]` in kortix.toml) — which secrets it receives in $ENV, which
 * connectors it may call, which Kortix-CLI powers it has. Editors EDIT
 * secrets + connectors here (persisted straight to the manifest); everyone
 * else sees the read-only mirror. `kortix_cli` stays read-only (a sharper
 * escalation, manifest-only). Absent for OpenCode-discovered agents, which
 * aren't governed by the manifest.
 *
 * Rendered inside the detail pane's single "Advanced" disclosure — it is the
 * v1 half of the governance surface, mounted as AgentConfigEditor's fallback.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  type ManifestVersion,
  useProjectManifestVersion,
} from '@/features/workspace/customize/migrate-to-v2/manifest-version';
import { cn } from '@/lib/utils';
import {
  type AgentGrantSet,
  type ProjectConfigSummary,
  listConnectors,
  listProjectAccess,
  listProjectSecrets,
  setAgentScope,
} from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

type Agent = ProjectConfigSummary['agents'][number];
export type AgentScopeValue = NonNullable<Agent['scope']>;

export function AgentScope({
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

export function AgentScopeCard({
  projectId,
  agentName,
  scope,
}: {
  projectId: string;
  agentName: string;
  scope: AgentScopeValue;
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
  // `agentName` is a deliberate extra dep: two agents can hold structurally
  // identical grant sets, and dropping it would leave a half-typed edit on the
  // screen after a switch if the pane were ever rendered unkeyed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
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
          <span className="font-mono">{manifestVersion === 2 ? 'kortix.yaml' : 'kortix.toml'}</span>
          .
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
export function grantSetEqual(a: AgentGrantSet, b: AgentGrantSet): boolean {
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
export function ScopeEditor({
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

export function ScopeRow({ label, value }: { label: string; value: string[] | 'all' }) {
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

export default AgentScope;
