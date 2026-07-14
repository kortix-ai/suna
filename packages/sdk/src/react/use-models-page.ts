'use client';

import { useQuery } from '@tanstack/react-query';
import { CATALOG, DEFAULT_MANAGED_MODEL_IDS } from '@kortix/llm-catalog';

import {
  getProjectLlmCatalog,
  type ConfiguredModelProvider,
  type HarnessAuthKind,
  type HarnessConnection,
  type HarnessId,
} from '../core/rest/projects-client';
import type { Agent } from '../core/runtime/wire-types';
import { agentHarness } from './harness-capabilities';
import { useHarnessConnections } from './use-composer-capabilities';
import { useRuntimeAgents } from './use-runtime-sessions';

/**
 * Models page projection — see docs/specs/2026-07-14-models-page-ui-handoff.md
 * §11 and docs/specs/2026-07-14-ux-ui-completion-plan.md §0/Workstream B.
 *
 * This is the ONE query the host consumes to render the Models page. It is
 * built on TODAY's data layer (auth-kind "connections" from
 * `/harness-connections`, one singleton per kind) — not the future
 * `ModelConnection` backend. `apps/web` must not re-derive compatibility,
 * resolution order, or presentation copy from connection ids/labels; every
 * rule lives here so the page shape survives the eventual backend swap.
 */

const HARNESS_ORDER: HarnessId[] = ['claude', 'codex', 'opencode', 'pi'];

const HARNESS_LABEL: Record<HarnessId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
};

/** Locked product language (handoff §2) — never surface backend kind ids,
 *  `managed_gateway`, `native_config`, or protocol names in the UI. The
 *  managed gateway is named plainly "Kortix" (never "Kortix managed" or
 *  "managed gateway") — see {@link connectionExplainer} for its subtitle. */
const CONNECTION_NAME: Record<HarnessAuthKind, string> = {
  managed_gateway: 'Kortix',
  claude_subscription: 'Claude subscription',
  codex_subscription: 'ChatGPT subscription',
  anthropic_api_key: 'Anthropic',
  openai_api_key: 'OpenAI',
  openai_compatible: 'Custom endpoint',
  anthropic_compatible: 'Custom endpoint',
  native_config: 'Harness-native configuration',
};

/** One-line explainer shown under the "Kortix" connection name — it is
 *  built in and requires no setup, unlike every other connection kind. */
const KORTIX_INCLUDED_EXPLAINER = 'Included — no setup needed';

/** Subtitle copy for a connection kind, or `null` when the kind has none.
 *  Currently only the managed gateway ("Kortix") carries one. */
export function connectionExplainer(kind: HarnessAuthKind): string | null {
  return kind === 'managed_gateway' ? KORTIX_INCLUDED_EXPLAINER : null;
}

/** Kinds whose model list is owned by the authenticated harness itself — a
 *  subscription (or a harness's own native config) never renders "0 models". */
const NOT_EXPOSED_KINDS = new Set<HarnessAuthKind>([
  'claude_subscription',
  'codex_subscription',
  'native_config',
]);

const MANAGED_MODEL_ID_SET = new Set<string>(DEFAULT_MANAGED_MODEL_IDS);

export function harnessLabel(harness: HarnessId): string {
  return HARNESS_LABEL[harness];
}

export function connectionDisplayName(kind: HarnessAuthKind): string {
  return CONNECTION_NAME[kind];
}

export type ModelsPageRuntimeStatus =
  | 'ready'
  | 'checking'
  | 'missing'
  | 'ambiguous'
  | 'needs-attention'
  | 'unavailable';

export interface ModelsPageBlocker {
  code: string;
  message: string;
  action: string | null;
}

export interface ModelsPageRuntime {
  id: string;
  harness: HarnessId;
  label: string;
  status: ModelsPageRuntimeStatus;
  selectedConnectionId: HarnessAuthKind | null;
  modelSummary: string | null;
  compatibleConnectionIds: HarnessAuthKind[];
  blocker: ModelsPageBlocker | null;
}

export type ModelsPageConnectionStatus = 'ready' | 'checking' | 'needs-attention' | 'unavailable';
export type ModelsPageCatalogState = 'available' | 'not-exposed' | 'loading' | 'error';

export interface ModelsPageConnection {
  id: HarnessAuthKind;
  name: string;
  kind: HarnessAuthKind;
  status: ModelsPageConnectionStatus;
  usedBy: HarnessId[];
  catalogState: ModelsPageCatalogState;
  modelCount: number | null;
  statusReason: string | null;
}

export interface ModelsPageState {
  runtimes: ModelsPageRuntime[];
  connections: ModelsPageConnection[];
  canWrite: boolean;
  isLoading: boolean;
  isError: boolean;
}

export interface ModelsPageInputs {
  agents: Agent[] | undefined;
  agentsLoading: boolean;
  connectionsData:
    | { connections: HarnessConnection[]; providers: ConfiguredModelProvider[] }
    | undefined;
  connectionsLoading: boolean;
  connectionsError: boolean;
  /** `getProjectLlmCatalog(projectId).models` — used only for the managed
   *  gateway's model count. */
  managedModels: Record<string, unknown> | undefined;
  managedModelsLoading: boolean;
  canWrite: boolean;
}

function dedupeHarnesses(agents: Agent[]): HarnessId[] {
  const present = new Set<HarnessId>();
  for (const agent of agents) {
    if (agent && (agent as { hidden?: boolean }).hidden) continue;
    const harness = agentHarness(agent);
    if (harness) present.add(harness);
  }
  return HARNESS_ORDER.filter((harness) => present.has(harness));
}

type ResolvedConnection =
  | { status: 'ready'; connection: HarnessConnection }
  | { status: 'ambiguous' | 'missing'; connection: null }
  | { status: 'needs-attention'; connection: HarnessConnection | null };

/**
 * Mirrors the server's `resolveActiveHarnessConnection`
 * (apps/api/src/projects/lib/composer-capabilities.ts) so the row shown here
 * always agrees with what a session actually resolves to: an explicit route
 * wins; otherwise a ready managed gateway is the platform default; otherwise
 * exactly one ready non-native connection is adopted; two or more is
 * ambiguous; a ready native (harness-detected) config is the last resort.
 */
function resolveActiveConnection(
  compatible: HarnessConnection[],
  explicitId: HarnessAuthKind | null,
): ResolvedConnection {
  if (explicitId) {
    const selected = compatible.find((connection) => connection.id === explicitId) ?? null;
    if (!selected || !selected.ready) return { status: 'needs-attention', connection: selected };
    return { status: 'ready', connection: selected };
  }
  const managed = compatible.find((connection) => connection.id === 'managed_gateway' && connection.ready);
  if (managed) return { status: 'ready', connection: managed };
  const readyNonNative = compatible.filter(
    (connection) => connection.ready && connection.id !== 'native_config',
  );
  if (readyNonNative.length === 1) return { status: 'ready', connection: readyNonNative[0]! };
  if (readyNonNative.length > 1) return { status: 'ambiguous', connection: null };
  const native = compatible.find((connection) => connection.id === 'native_config' && connection.ready);
  if (native) return { status: 'ready', connection: native };
  return { status: 'missing', connection: null };
}

function modelPolicySummary(harness: HarnessId, connection: HarnessConnection): string {
  if (harness === 'claude' || harness === 'codex' || harness === 'pi') return 'Harness default';
  return connection.kind === 'managed_gateway' ? 'Automatic' : 'Default model';
}

function buildRuntime(
  harness: HarnessId,
  connections: HarnessConnection[],
  loading: boolean,
): ModelsPageRuntime {
  const label = HARNESS_LABEL[harness];
  const compatible = connections.filter((connection) => connection.compatible_harnesses.includes(harness));
  const compatibleConnectionIds = compatible.filter((connection) => connection.ready).map((c) => c.id);

  if (loading) {
    return {
      id: harness,
      harness,
      label,
      status: 'checking',
      selectedConnectionId: null,
      modelSummary: `Checking ${label}…`,
      compatibleConnectionIds,
      blocker: null,
    };
  }

  const explicitId = compatible.find((connection) => connection.active_for.includes(harness))?.id ?? null;
  const resolved = resolveActiveConnection(compatible, explicitId);

  if (resolved.status === 'ready') {
    const connection = resolved.connection;
    return {
      id: harness,
      harness,
      label,
      status: 'ready',
      selectedConnectionId: connection.id,
      modelSummary: `${CONNECTION_NAME[connection.kind]} · ${modelPolicySummary(harness, connection)}`,
      compatibleConnectionIds,
      blocker: null,
    };
  }

  if (resolved.status === 'needs-attention') {
    const name = explicitId ? CONNECTION_NAME[explicitId] : label;
    return {
      id: harness,
      harness,
      label,
      status: 'needs-attention',
      selectedConnectionId: explicitId,
      modelSummary: `${name} needs to be reconnected`,
      compatibleConnectionIds,
      blocker: { code: 'needs_attention', message: `${name} needs to be reconnected`, action: 'fix' },
    };
  }

  if (resolved.status === 'ambiguous') {
    const message = `Select one of ${compatibleConnectionIds.length} connected options`;
    return {
      id: harness,
      harness,
      label,
      status: 'ambiguous',
      selectedConnectionId: null,
      modelSummary: message,
      compatibleConnectionIds,
      blocker: { code: 'ambiguous', message, action: 'choose' },
    };
  }

  const message = `Choose how ${label} accesses models`;
  return {
    id: harness,
    harness,
    label,
    status: 'missing',
    selectedConnectionId: null,
    modelSummary: message,
    compatibleConnectionIds,
    blocker: { code: 'no_connection', message, action: 'connect' },
  };
}

function managedModelCount(models: Record<string, unknown> | undefined): number {
  if (!models) return 0;
  return Object.keys(models).filter((id) => MANAGED_MODEL_ID_SET.has(id)).length;
}

function connectionCatalog(
  connection: HarnessConnection,
  ctx: { managedCount: number; managedLoading: boolean },
): { catalogState: ModelsPageCatalogState; modelCount: number | null } {
  if (NOT_EXPOSED_KINDS.has(connection.kind)) {
    return { catalogState: 'not-exposed', modelCount: null };
  }
  if (connection.kind === 'managed_gateway') {
    if (ctx.managedLoading) return { catalogState: 'loading', modelCount: null };
    return { catalogState: 'available', modelCount: ctx.managedCount };
  }
  if (connection.kind === 'anthropic_api_key' || connection.kind === 'openai_api_key') {
    const providerId = connection.kind === 'anthropic_api_key' ? 'anthropic' : 'openai';
    const provider = CATALOG.providers.find((entry) => entry.id === providerId);
    return { catalogState: 'available', modelCount: provider?.models.length ?? 0 };
  }
  // openai_compatible / anthropic_compatible — today's data layer keeps one
  // singleton custom endpoint with exactly one configured model id.
  if (!connection.ready) return { catalogState: 'not-exposed', modelCount: null };
  return { catalogState: 'available', modelCount: 1 };
}

function buildConnection(
  connection: HarnessConnection,
  ctx: { managedCount: number; managedLoading: boolean; usedBy: HarnessId[] },
): ModelsPageConnection {
  const { catalogState, modelCount } = connectionCatalog(connection, ctx);
  return {
    id: connection.id,
    name: CONNECTION_NAME[connection.kind] ?? connection.label,
    kind: connection.kind,
    status: connection.ready ? 'ready' : ctx.usedBy.length > 0 ? 'needs-attention' : 'checking',
    usedBy: ctx.usedBy,
    catalogState,
    modelCount,
    statusReason: connection.ready ? null : connection.reason,
  };
}

/** needs-attention first, then in-use, then unused ready — stable otherwise
 *  (today's data layer has no created-at to order "newest first" by). */
function connectionRank(connection: ModelsPageConnection): number {
  if (connection.status === 'needs-attention') return 0;
  if (connection.usedBy.length > 0) return 1;
  return 2;
}

function sortConnections(a: ModelsPageConnection, b: ModelsPageConnection): number {
  return connectionRank(a) - connectionRank(b);
}

/** Pure projection — no React, no query client. Exported so the derivation
 *  can be fixture-tested without mocking `@tanstack/react-query`. */
export function projectModelsPageState(input: ModelsPageInputs): ModelsPageState {
  const connections = input.connectionsData?.connections ?? [];
  const loading = input.agentsLoading || input.connectionsLoading;

  const harnesses = dedupeHarnesses(input.agents ?? []);
  const runtimes = harnesses.map((harness) => buildRuntime(harness, connections, loading));

  // "Used by" is the EFFECTIVE resolution (what a session actually adopts),
  // not just an explicit route — a runtime that auto-resolves to the managed
  // gateway or the sole ready BYOK connection still counts as using it.
  const usedByMap = new Map<HarnessAuthKind, HarnessId[]>();
  for (const runtime of runtimes) {
    if (!runtime.selectedConnectionId) continue;
    const list = usedByMap.get(runtime.selectedConnectionId) ?? [];
    list.push(runtime.harness);
    usedByMap.set(runtime.selectedConnectionId, list);
  }

  const managedCount = managedModelCount(input.managedModels);
  const connectionRows = connections
    .filter(
      (connection) =>
        connection.configured || connection.ready || connection.active_for.length > 0,
    )
    .map((connection) =>
      buildConnection(connection, {
        managedCount,
        managedLoading: input.managedModelsLoading,
        usedBy: usedByMap.get(connection.id) ?? [],
      }),
    )
    .sort(sortConnections);

  return {
    runtimes,
    connections: connectionRows,
    canWrite: input.canWrite,
    isLoading: loading,
    isError: input.connectionsError,
  };
}

/**
 * The one query the Models page host consumes. Wraps today's
 * `useRuntimeAgents` + `useHarnessConnections` + the project llm-catalog
 * (only needed for the managed gateway's model count) into the
 * `ModelsPageState` shape above.
 */
export function useModelsPage(
  projectId: string | null | undefined,
  canWrite = false,
): ModelsPageState {
  const agentsQuery = useRuntimeAgents({ projectId });
  const connectionsQuery = useHarnessConnections(projectId);
  const catalogQuery = useQuery({
    queryKey: ['project-llm-catalog', projectId],
    queryFn: () => getProjectLlmCatalog(projectId as string),
    enabled: Boolean(projectId),
    staleTime: 30_000,
  });

  return projectModelsPageState({
    agents: agentsQuery.data,
    agentsLoading: agentsQuery.isLoading,
    connectionsData: connectionsQuery.data,
    connectionsLoading: connectionsQuery.isLoading,
    connectionsError: connectionsQuery.isError,
    managedModels: catalogQuery.data?.models,
    managedModelsLoading: catalogQuery.isLoading,
    canWrite,
  });
}
