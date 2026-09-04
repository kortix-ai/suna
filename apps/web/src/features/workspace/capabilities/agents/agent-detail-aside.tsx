'use client';

/**
 * The v1 fallback cards of the agent page, plus the scope-checklist helpers
 * the v2 editor shares with them.
 *
 * `AgentModel` and `AgentScope` are what a project on the legacy manifest
 * (kortix.toml, kortix_version 1) gets in place of the full editor — the
 * per-agent gateway model pin and the read-only/editable scope mirror. We
 * degrade, never blank the column. The v2 page
 * (`capabilities/agents/agent-page.tsx`) renders neither; its Model and Access
 * sections write the manifest block directly.
 *
 * Historically this file was the whole right-hand aside of the agent detail
 * MODAL (assignments + configuration summary). The modal is gone — an agent
 * is a routed page now, Customize being agent-centric (Marko, 2026-09-01) —
 * and the assignments moved to `agent-people-section.tsx`.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import { ModelSelector } from '@/features/session/model-selector';
import { flattenModels } from '@/features/session/session-chat-input';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import {
  type AgentGrantSet,
  getProjectDetail,
  listConnectors,
  listProjectSecrets,
  type ProjectConfigSummary,
  setAgentScope,
} from '@kortix/sdk';
import { isLlmGatewayEnabled } from '@/lib/llm-gateway';
import { contract, qk, useModelDefaults, useRuntimeProviders } from '@kortix/sdk/react';
import { CheckIcon as Check } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

type Agent = ProjectConfigSummary['agents'][number];

/**
 * Which model this agent runs on. Sets the per-agent gateway default (scope=agent,
 * DB-backed, instant — no git commit). When unset, the agent falls back to the
 * project → account → platform default. Manager-gated; everyone else sees the
 * read-only resolved model.
 */
export function AgentModel({ projectId, agentName }: { projectId: string; agentName: string }) {
  // Pinning an agent's model is a customize write, which is what the route
  // asserts — not "is this person a manager".
  const canManage =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE).allowed === true;
  // Per-agent model pins live in the GATEWAY model-defaults chain. A native
  // project (llm_gateway off) has no such chain — the agent's model comes
  // from its own frontmatter/manifest and OpenCode resolves it in the
  // sandbox — and the write route 404s, so the card hides entirely.
  const detailQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
  });
  const llmGatewayEnabled = isLlmGatewayEnabled(detailQuery.data?.project);
  const { data: providers } = useRuntimeProviders();
  const models = useMemo(() => flattenModels(providers), [providers]);
  const defaults = useModelDefaults(projectId);
  if (!llmGatewayEnabled) return null;
  const explicit = defaults.agentDefaults[agentName] ?? null;
  const resolved = defaults.resolveDefaultFor(agentName) ?? null;

  const nameOf = (m: { providerID: string; modelID: string } | null) =>
    m
      ? (models.find((x) => x.providerID === m.providerID && x.modelID === m.modelID)?.modelName ??
        `${m.providerID}/${m.modelID}`)
      : null;

  return (
    <div className="bg-popover space-y-3 rounded-md border px-4 py-4">
      <div className="flex items-center gap-2">
        <Label>Model</Label>
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
          {nameOf(resolved) ?? 'No model configured'}
        </Badge>
      )}

      <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
        {explicit ? (
          <>
            Every session run by this agent uses{' '}
            <span className="text-foreground font-medium">{nameOf(explicit)}</span>.
          </>
        ) : (
          <>
            Follows the project default
            {resolved ? (
              <>
                {' '}
                (<span className="text-foreground font-medium">{nameOf(resolved)}</span>)
              </>
            ) : null}
            . Pick a model to pin it.
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
  // `PUT /projects/:id/agents/:name/scope` asserts `project.customize.write`
  // (docs/sdk/reference: "the route answers 403 otherwise"). Ask for that.
  const canManage =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE).allowed === true;

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
    queryKey: qk.project.secrets(projectId),
    queryFn: () => listProjectSecrets(projectId),
    enabled: canManage,
    ...contract('config'),
  });
  const connectorsQuery = useQuery({
    queryKey: qk.project.connectors(projectId),
    queryFn: () => listConnectors(projectId),
    enabled: canManage,
    ...contract('config'),
  });

  const secretOptions = useMemo(
    () => buildSecretScopeOptions(secretsQuery.data?.items ?? []),
    [secretsQuery.data],
  );
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
      queryClient.invalidateQueries({ queryKey: qk.project.detail(projectId) });
    },
    onError: (e: Error) => errorToast(e.message || 'Failed to update scope'),
  });

  // Non-managers get the read-only mirror (the old presentation).
  if (!canManage) {
    return (
      <div className="bg-popover space-y-3 rounded-md border px-4 py-4">
        <Label>Access</Label>
        <dl className="space-y-2">
          <ScopeRow label="Secrets" value={scope.env} />
          <ScopeRow label="Connectors" value={scope.connectors} />
          <ScopeRow label="CLI" value={scope.kortix_cli} />
        </dl>
        <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
          All = everything the person launching the session can see. None = fully scoped out.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-popover space-y-4 rounded-md border px-4 py-4">
      <Label>Access</Label>
      <ScopeEditor
        key={`env-${editorNonce}`}
        label="Secrets"
        allLabel="All the launcher can see"
        emptyLabel="No secrets in this project yet."
        value={env}
        options={secretOptions}
        match="case-insensitive"
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
      <dl>
        <ScopeRow label="CLI" value={scope.kortix_cli} />
      </dl>
      {/* The save bar only exists once there is something to save — an always-on
          disabled pair of buttons is chrome that never earns its row. */}
      {dirty ? (
        <div className="border-border/50 flex items-center justify-end gap-2 border-t pt-3">
          <Button
            variant="ghost"
            size="sm"
            disabled={save.isPending}
            onClick={() => {
              setEnv(scope.env);
              setConnectors(scope.connectors);
              setEditorNonce((n) => n + 1);
            }}
          >
            Reset
          </Button>
          <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending && <Loading className="size-3.5 shrink-0" />}
            Save
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** One row of a `ScopeEditor` checklist. `id` is the exact string written into
 *  the manifest grant; `hint` is context that helps a human recognise the row
 *  and is never part of the grant. */
export interface ScopeOption {
  id: string;
  label: string;
  hint?: string;
}

/**
 * The Secrets checklist, built from the project's secrets.
 *
 * Keyed on IDENTIFIER, never on `name`. Every consumer of the grant matches by
 * identifier — `listAdmits` in the delivery rule and `agentMayUseEnv` in the
 * agent-scope gate — and `name` is the env var KEY, which is NOT unique. Keying
 * on the key wrote a grant nothing matched, and collapsed two secrets that share
 * one key into a single row that could not be granted separately. The key is
 * still what the user reads on the sandbox side, so it stays visible as a hint
 * whenever it differs from the identifier.
 */
export function buildSecretScopeOptions(
  items: readonly { identifier: string; name: string }[],
): ScopeOption[] {
  return items
    .map((s) => ({
      id: s.identifier,
      label: s.identifier,
      hint: s.name === s.identifier ? undefined : s.name,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * How a manifest grant entry is paired with a checklist option. It must mirror
 * the server gate for that resource: secrets are case-insensitive
 * (`agentMayUseEnv`, and `listAdmits` in the delivery rule), connector slugs are
 * exact (`agentMayUseConnector`).
 */
export type ScopeMatch = 'exact' | 'case-insensitive';

export interface ScopeChecklistRow extends ScopeOption {
  selected: boolean;
  /** Declared in the manifest but not a resource in this project — a deleted
   *  secret, or a typo. Shown so it can be removed. */
  orphan: boolean;
}

const scopeMatchKey = (id: string, match: ScopeMatch) =>
  match === 'exact' ? id : id.toUpperCase();

/**
 * The checklist rows for one grant: every project resource, plus any declared
 * entry that no longer maps to one.
 *
 * With one exact rule for both resource kinds, a hand-written lowercase
 * `secrets:` entry that the server DOES honour rendered as an unticked row plus
 * a second row flagged "missing" — the editor calling a working grant broken.
 */
export function buildScopeChecklist(
  value: AgentGrantSet,
  options: ScopeOption[],
  match: ScopeMatch = 'exact',
): ScopeChecklistRow[] {
  const declared = value === 'all' ? [] : value;
  const declaredKeys = new Set(declared.map((id) => scopeMatchKey(id, match)));
  const optionKeys = new Set(options.map((o) => scopeMatchKey(o.id, match)));
  const orphans = declared.filter((id) => !optionKeys.has(scopeMatchKey(id, match)));
  return [
    ...options.map((o) => ({
      ...o,
      selected: declaredKeys.has(scopeMatchKey(o.id, match)),
      orphan: false,
    })),
    ...orphans.map((id) => ({ id, label: id, selected: true, orphan: true })),
  ];
}

/**
 * The grant after ticking or unticking one row.
 *
 * Unticking drops every entry that MATCHES, not just the byte-identical one: the
 * row shows the option's id while the manifest may spell the same grant in
 * another case, and leaving that spelling behind keeps the grant live under a
 * checkbox that now reads as off.
 */
export function toggleScopeSelection(
  value: AgentGrantSet,
  id: string,
  match: ScopeMatch = 'exact',
): string[] {
  const declared = value === 'all' ? [] : value;
  const key = scopeMatchKey(id, match);
  const next = declared.filter((entry) => scopeMatchKey(entry, match) !== key);
  if (next.length === declared.length) next.push(id);
  return next;
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
 * checklist of the project's secrets/connectors; a declared id that no longer
 * exists as a resource still shows (flagged) so it can be removed. Rows and
 * toggles come from `buildScopeChecklist` / `toggleScopeSelection`, which own
 * the per-resource `ScopeMatch` rule.
 */
function ScopeEditor({
  label,
  allLabel,
  emptyLabel,
  value,
  options,
  match = 'exact',
  onChange,
}: {
  label: string;
  allLabel: string;
  emptyLabel: string;
  value: AgentGrantSet;
  options: ScopeOption[];
  match?: ScopeMatch;
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
  const rows = buildScopeChecklist(value, options, match);

  const pick = (m: 'all' | 'specific' | 'none') => {
    setWantSpecific(m === 'specific');
    if (m === 'all') return onChange('all');
    if (m === 'none') return onChange([]);
    // → specific: keep the current concrete list ('all' starts empty). The latch
    // above keeps us in specific mode even while the list is empty.
    onChange(value === 'all' ? [] : value);
  };
  const toggle = (id: string) => onChange(toggleScopeSelection(value, id, match));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">{label}</span>
        <div className="border-border/70 inline-flex shrink-0 overflow-hidden rounded-md border">
          {(['all', 'specific', 'none'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => pick(m)}
              className={cn(
                'px-2.5 py-1 text-xs capitalize',
                'transition-[color,background-color] active:scale-[0.96]',
                mode === m
                  ? 'bg-secondary text-foreground font-medium'
                  : 'text-muted-foreground hover:bg-muted/50',
              )}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
      {mode === 'all' ? (
        <p className="text-muted-foreground text-xs text-pretty">{allLabel}</p>
      ) : null}

      {mode === 'specific' &&
        (rows.length === 0 ? (
          <p className="text-muted-foreground text-xs">{emptyLabel}</p>
        ) : (
          <div className="border-border/60 max-h-44 overflow-y-auto rounded-md border p-1">
            {rows.map((o) => (
              <button
                key={o.id}
                type="button"
                aria-pressed={o.selected}
                onClick={() => toggle(o.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs transition-colors',
                  o.selected ? 'bg-secondary' : 'hover:bg-muted/50',
                )}
              >
                <span
                  className={cn(
                    'flex size-4 shrink-0 items-center justify-center rounded border',
                    o.selected
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-border/70',
                  )}
                >
                  {o.selected && <Check className="size-3" />}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono">{o.label}</span>
                {/* The env var KEY, shown only when it differs from the id the
                    grant is written with — the sandbox side of the same secret. */}
                {o.hint ? (
                  <span className="text-muted-foreground max-w-[40%] shrink-0 truncate font-mono">
                    {o.hint}
                  </span>
                ) : null}
                {o.orphan && <span className="text-kortix-orange">missing</span>}
              </button>
            ))}
          </div>
        ))}
    </div>
  );
}

/**
 * One label/value line, matching the Configuration card's spec-sheet rhythm.
 * `all` and `none` render as plain words, not chips — a chip on every row
 * signals "notice this", and when every row has one, none of them read.
 * A concrete allowlist still gets chips: there the individual names ARE the
 * data, and chips are what separates them.
 */
function ScopeRow({ label, value }: { label: string; value: string[] | 'all' }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground shrink-0 text-xs">{label}</dt>
      <dd className="flex min-w-0 flex-wrap justify-end gap-1">
        {value === 'all' || value.length === 0 ? (
          <span className="text-foreground text-xs font-medium">
            {value === 'all' ? 'All' : 'None'}
          </span>
        ) : (
          value.map((key) => (
            <Badge key={key} variant="outline" size="xs" className="font-mono">
              {key}
            </Badge>
          ))
        )}
      </dd>
    </div>
  );
}
