import { CATALOG, type CatalogModel } from '@kortix/llm-catalog';
import { HARNESS_IDS, HARNESSES, harnessesByStability, type HarnessId } from '@kortix/shared/harnesses';

import { resolveExperimentalFeature } from '../../experimental/features';
import { projectLlmGatewayEnabled } from '../../llm-gateway/enablement';
import { gatewayModelCatalog } from '../../llm-gateway/models/catalog-models';
import type { GitBackedProject } from '../git/types';
import { listRepoFiles } from '../git/files';
import { listProjectSecretsSnapshotForUser } from '../secrets';
import {
  resolveCompiledRuntimeConfigForSession,
  type LogicalAgentLaunchPlan,
} from './compile-runtime-config';

export type { HarnessId };
export type HarnessAuthKind =
  | 'managed_gateway'
  | 'claude_subscription'
  | 'anthropic_api_key'
  | 'codex_subscription'
  | 'openai_api_key'
  | 'openai_compatible'
  | 'anthropic_compatible'
  | 'native_config';

export type HarnessConnection = {
  id: HarnessAuthKind;
  kind: HarnessAuthKind;
  label: string;
  compatible_harnesses: HarnessId[];
  configured: boolean;
  ready: boolean;
  active_for: HarnessId[];
  reason: string | null;
  source: 'kortix' | 'project_secret' | 'native_config';
};

export type ComposerModelPreset = {
  id: string;
  name: string;
  source: string;
};

export type ComposerCapabilities = {
  agent: {
    name: string;
    runtime: string;
    harness: HarnessId;
    native_agent: string | null;
    enabled: boolean;
  };
  auth: {
    compatible: HarnessAuthKind[];
    active: HarnessAuthKind | null;
    ready: boolean;
    reason: string | null;
  };
  model: {
    policy: 'gateway-catalog' | 'harness-catalog' | 'launch-override';
    default_allowed: boolean;
    custom_allowed: boolean;
    live_change: boolean;
    presets: ComposerModelPreset[];
  };
  can_start: boolean;
  blocking_reason: string | null;
};

export type ConfiguredModelProvider = {
  provider_id: string;
  label: string;
};

// 2026-07-15 simplification (founder decision): Claude Code and Codex are
// harness-only — their subscription, their own provider API key, or the
// repo's committed native config. They NEVER ride the Kortix managed gateway
// and NEVER take a custom endpoint. OpenCode and Pi keep the full gateway
// story (managed gateway, BYOK, custom endpoints, native config). This table
// is the single source of truth for that matrix — every other place that
// needs to know what's compatible with what (web connect modal, SDK
// projection, route validation) reads it from here, directly or via the
// `/harness-connections` response's `compatible_harnesses`.
const CONNECTIONS: Record<
  HarnessAuthKind,
  Pick<HarnessConnection, 'label' | 'compatible_harnesses' | 'source'>
> = {
  managed_gateway: {
    label: 'Kortix managed gateway',
    compatible_harnesses: ['opencode', 'pi'],
    source: 'kortix',
  },
  claude_subscription: {
    label: 'Claude subscription',
    compatible_harnesses: ['claude'],
    source: 'project_secret',
  },
  anthropic_api_key: {
    label: 'Anthropic API key',
    compatible_harnesses: ['claude', 'opencode', 'pi'],
    source: 'project_secret',
  },
  codex_subscription: {
    label: 'ChatGPT/Codex subscription',
    compatible_harnesses: ['codex'],
    source: 'project_secret',
  },
  openai_api_key: {
    label: 'OpenAI API key',
    compatible_harnesses: ['codex', 'opencode', 'pi'],
    source: 'project_secret',
  },
  openai_compatible: {
    label: 'OpenAI-compatible REST',
    compatible_harnesses: ['opencode', 'pi'],
    source: 'project_secret',
  },
  // Deliberate capability decision (2026-07-15): a custom Anthropic-protocol
  // endpoint had exactly one consumer — Claude Code custom routing — and that
  // routing is cut by the harness-only simplification above. No harness is
  // compatible with this kind for now; the form/route plumbing stays intact
  // (cheap to bring back) but it is unreachable from any UI surface.
  anthropic_compatible: {
    label: 'Anthropic-compatible REST',
    compatible_harnesses: [],
    source: 'project_secret',
  },
  native_config: {
    label: 'Harness-native config',
    compatible_harnesses: [...HARNESS_IDS],
    source: 'native_config',
  },
};

const ACTIVE_ROUTES_METADATA_KEY = 'harness_auth_routes';

function isHarnessAuthKind(value: unknown): value is HarnessAuthKind {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CONNECTIONS, value);
}

export function readHarnessAuthRoutes(metadata: unknown): Partial<Record<HarnessId, HarnessAuthKind>> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const raw = (metadata as Record<string, unknown>)[ACTIVE_ROUTES_METADATA_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const routes: Partial<Record<HarnessId, HarnessAuthKind>> = {};
  for (const harness of HARNESS_IDS) {
    const value = (raw as Record<string, unknown>)[harness];
    if (isHarnessAuthKind(value)) routes[harness] = value;
  }
  return routes;
}

export function writeHarnessAuthRoute(
  metadata: unknown,
  harness: HarnessId,
  connectionId: HarnessAuthKind | null,
): Record<string, unknown> {
  const current = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? { ...(metadata as Record<string, unknown>) }
    : {};
  const routes = { ...readHarnessAuthRoutes(current) };
  if (connectionId) routes[harness] = connectionId;
  else delete routes[harness];
  return { ...current, [ACTIVE_ROUTES_METADATA_KEY]: routes };
}

function connectionConfigured(
  kind: HarnessAuthKind,
  env: Record<string, string>,
  gateway: boolean,
  nativeConfigReady: boolean,
): boolean {
  switch (kind) {
    case 'managed_gateway': return gateway;
    case 'claude_subscription': return Boolean(env.CLAUDE_CODE_OAUTH_TOKEN?.trim());
    case 'anthropic_api_key': return Boolean(env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim());
    case 'codex_subscription': return Boolean(env.CODEX_AUTH_JSON?.trim() || env.OPENCODE_AUTH_JSON?.trim());
    case 'openai_api_key': return Boolean(env.OPENAI_API_KEY?.trim() || env.CODEX_API_KEY?.trim());
    case 'openai_compatible':
      return env.CUSTOM_LLM_PROTOCOL?.trim().toLowerCase() === 'openai' && Boolean(env.CUSTOM_LLM_BASE_URL?.trim());
    case 'anthropic_compatible':
      return env.CUSTOM_LLM_PROTOCOL?.trim().toLowerCase() === 'anthropic' && Boolean(env.CUSTOM_LLM_BASE_URL?.trim());
    // A profile's conventional/default directory is not itself configuration.
    // Only expose this route when that selected runtime profile actually owns
    // at least one file in its config subtree at the project's launch ref.
    case 'native_config': return nativeConfigReady;
  }
}

export function buildHarnessConnections(input: {
  env: Record<string, string>;
  gatewayEnabled: boolean;
  nativeConfigReady?: boolean;
  activeRoutes?: Partial<Record<HarnessId, HarnessAuthKind>>;
}): HarnessConnection[] {
  const explicit = input.activeRoutes ?? {};
  return (Object.keys(CONNECTIONS) as HarnessAuthKind[]).map((kind) => {
    const definition = CONNECTIONS[kind];
    const configured = connectionConfigured(
      kind,
      input.env,
      input.gatewayEnabled,
      input.nativeConfigReady === true,
    );
    const activeFor = definition.compatible_harnesses.filter((harness) => explicit[harness] === kind);
    return {
      id: kind,
      kind,
      ...definition,
      configured,
      ready: configured,
      active_for: activeFor,
      reason: configured ? null : `Connect ${definition.label} before selecting it.`,
    };
  });
}

export function configuredModelProviders(env: Record<string, string>): ConfiguredModelProvider[] {
  return CATALOG.providers
    .filter((provider) => {
      const names = provider.env ?? [];
      return names.length > 0 && names.every((name) => Boolean(env[name]?.trim()));
    })
    .map((provider) => ({ provider_id: provider.id, label: provider.name }));
}

export function resolveActiveHarnessConnection(input: {
  harness: HarnessId;
  connections: HarnessConnection[];
  explicit?: HarnessAuthKind | null;
}): { active: HarnessConnection | null; reason: string | null } {
  const compatible = input.connections.filter((connection) =>
    connection.compatible_harnesses.includes(input.harness));
  if (input.explicit) {
    const selected = compatible.find((connection) => connection.id === input.explicit) ?? null;
    if (!selected) return { active: null, reason: `${input.explicit} is not compatible with ${input.harness}.` };
    if (!selected.ready) return { active: null, reason: selected.reason };
    return { active: selected, reason: null };
  }

  // Deterministic compatibility path: a configured managed route is the
  // platform default. With no managed route, exactly one configured native/BYOK
  // route may be adopted; two or more require an explicit choice.
  const managed = compatible.find((connection) => connection.id === 'managed_gateway' && connection.ready);
  if (managed) return { active: managed, reason: null };
  const ready = compatible.filter((connection) => connection.ready && connection.id !== 'native_config');
  if (ready.length === 1) return { active: ready[0]!, reason: null };
  if (ready.length > 1) {
    return { active: null, reason: `Choose which ${input.harness} authentication connection to use.` };
  }
  const native = compatible.find((connection) => connection.id === 'native_config' && connection.ready);
  if (native) return { active: native, reason: null };
  return { active: null, reason: `Connect a compatible ${input.harness} authentication route.` };
}

// Founder decision (2026-07-15): the raw models.dev catalog for Anthropic/
// OpenAI is 25-50+ entries deep (dated snapshots, minor point releases) —
// that's the noise the Claude/Codex pickers must never show. Their native
// preset lists are capped to the newest models by release date; the full
// catalog stays reachable through OpenCode/Pi's gateway-backed picker, which
// does not go through this cap.
const NATIVE_MODEL_PRESET_LIMIT = 6;

/** Newest-first, capped, deterministic on ties (release date, then id) — pure
 *  so the cap is unit-testable without a compiled runtime config. */
export function newestCatalogModels(models: CatalogModel[], limit: number): CatalogModel[] {
  return [...models]
    .sort((a, b) => {
      const released = (Date.parse(b.released ?? '') || -Infinity) - (Date.parse(a.released ?? '') || -Infinity);
      return released !== 0 ? released : a.id.localeCompare(b.id);
    })
    .slice(0, limit);
}

export function modelPresets(kind: HarnessAuthKind, env: Record<string, string>, projectId: string): ComposerModelPreset[] {
  if (kind === 'managed_gateway') {
    return Object.entries(gatewayModelCatalog(projectId)).map(([id, model]) => ({
      id: `kortix/${id}`,
      name: model.name || id,
      source: 'kortix-gateway',
    }));
  }
  const providerId = kind === 'anthropic_api_key' ? 'anthropic' : kind === 'openai_api_key' ? 'openai' : null;
  if (providerId) {
    const provider = CATALOG.providers.find((entry) => entry.id === providerId);
    const models = newestCatalogModels(provider?.models ?? [], NATIVE_MODEL_PRESET_LIMIT);
    return models.map((model) => ({ id: model.id, name: model.name || model.id, source: 'models.dev' }));
  }
  if (kind === 'openai_compatible' || kind === 'anthropic_compatible') {
    const id = env.CUSTOM_LLM_MODEL_ID?.trim();
    return id ? [{ id, name: id, source: 'project' }] : [];
  }
  if (kind === 'native_config') {
    return CATALOG.providers.flatMap((provider) => {
      const names = provider.env ?? [];
      if (!names.length || !names.every((name) => Boolean(env[name]?.trim()))) return [];
      return provider.models.map((model) => ({
        id: `${provider.id}/${model.id}`,
        name: model.name || model.id,
        source: 'models.dev',
      }));
    });
  }
  // Subscription access is owned by the authenticated harness. Never fabricate
  // its model list from models.dev.
  return [];
}

/**
 * Whether a resolved connection has a usable default model with no explicit
 * choice needed (§9 "A valid harness default does not require the user to
 * select a model", docs/specs/2026-07-14-provider-auth-model-management.md).
 * A harness with `HARNESSES[id].ownsDefaultModel === true` (Claude/Codex/Pi)
 * always owns its default natively. A harness with `ownsDefaultModel ===
 * false` (OpenCode is the only one today) consumes an explicit launch model —
 * but a preset catalog OR a ready managed-gateway route (managed-auto) is
 * itself a usable default; only a genuinely empty, non-managed catalog (e.g.
 * a custom endpoint with no configured default model) requires the user to
 * pick one. Exported (and kept pure) so this rule is unit-testable without a
 * compiled runtime config.
 */
export function computeDefaultAllowed(input: {
  active: HarnessAuthKind | null;
  harness: HarnessId;
  presetsLength: number;
}): boolean {
  if (!input.active) return false;
  if (HARNESSES[input.harness].ownsDefaultModel) return true;
  return input.presetsLength > 0 || input.active === 'native_config' || input.active === 'managed_gateway';
}

// Founder posture (WS2-P1-b): OpenCode is the only non-experimental harness —
// `HARNESSES.opencode.stability === 'stable'`, the sole entry never in this
// set. Claude/Codex/Pi (`harnessesByStability('experimental')`, zero
// hardcoded harness lists) are selectable ONLY once a project opts into the
// `experimental_harnesses` feature (`experimental/features.ts`). This gates
// SELECTION/START only — parsing/compiling a manifest that declares all four
// runtimes (the shipped base template) is never gated, see
// `compile-runtime-config.ts` and `agent-config-v2.ts`'s `migrateManifestV2ToV3`.
const EXPERIMENTAL_HARNESSES = new Set<HarnessId>(harnessesByStability('experimental'));

/** Whether `harness` may currently be SELECTED to start a session under
 *  `metadata`'s project. Pure so the predicate is unit-testable without a
 *  compiled runtime config. */
export function isExperimentalHarnessGated(harness: HarnessId, metadata: unknown): boolean {
  if (!EXPERIMENTAL_HARNESSES.has(harness)) return false;
  return !resolveExperimentalFeature(metadata, 'experimental_harnesses');
}

function agentView(agent: LogicalAgentLaunchPlan) {
  return {
    name: agent.name,
    runtime: agent.runtime,
    harness: agent.harness as HarnessId,
    native_agent: agent.nativeAgent,
    enabled: agent.enabled,
  };
}

export async function resolveProjectComposerState(input: {
  project: GitBackedProject;
  userId: string | null;
  metadata?: unknown;
}): Promise<{
  agents: ComposerCapabilities['agent'][];
  connections: HarnessConnection[];
  providers: ConfiguredModelProvider[];
  capabilities(agentName: string, connectionId?: HarnessAuthKind | null): Promise<ComposerCapabilities>;
}> {
  const [compiled, secrets, repoFiles] = await Promise.all([
    resolveCompiledRuntimeConfigForSession(input.project),
    listProjectSecretsSnapshotForUser(input.project.projectId, input.userId, 'all'),
    // Capability discovery must fail closed for native config without taking
    // managed/BYOK routes down when the git mirror is briefly unavailable.
    listRepoFiles(input.project, input.project.defaultBranch).catch(() => []),
  ]);
  const hasNativeConfig = (configDir: string): boolean => {
    const prefix = configDir.replace(/^\.\//, '').replace(/\/+$/, '');
    return Boolean(prefix) && repoFiles.some((file) => file.path === prefix || file.path.startsWith(`${prefix}/`));
  };
  const anyNativeConfig = compiled
    ? Object.values(compiled.runtimes).some((runtime) => hasNativeConfig(runtime.configDir))
    : false;
  const routes = readHarnessAuthRoutes(input.metadata);
  const connections = buildHarnessConnections({
    env: secrets.env,
    gatewayEnabled: projectLlmGatewayEnabled(input.metadata),
    nativeConfigReady: anyNativeConfig,
    activeRoutes: routes,
  });
  const agents = compiled ? Object.values(compiled.agents).map(agentView) : [];

  return {
    agents,
    connections,
    providers: configuredModelProviders(secrets.env),
    async capabilities(agentName, connectionId) {
      // The 'default' sentinel resolves to the compiled default agent — legacy
      // callers (UI without an explicit agent, triggers, channels) never name
      // a concrete agent, and the synthetic legacy plan only declares one.
      if (!compiled) {
        throw new Error(
          'The project runtime configuration could not be read — check that the project repository is reachable and kortix.yaml parses.',
        );
      }
      const launch =
        compiled.agents[agentName] ??
        (agentName === 'default' ? compiled.agents[compiled.defaultAgent] : undefined);
      if (!launch) throw new Error(`Agent "${agentName}" is not declared in kortix.yaml.`);
      const agent = agentView(launch);
      if (!agent.enabled) throw new Error(`Agent "${agentName}" is disabled.`);
      const agentSecrets = await listProjectSecretsSnapshotForUser(
        input.project.projectId,
        input.userId,
        launch.secrets === 'none' ? [] : launch.secrets,
      );
      const runtime = compiled?.runtimes[launch.runtime];
      const agentConnections = buildHarnessConnections({
        env: agentSecrets.env,
        gatewayEnabled: projectLlmGatewayEnabled(input.metadata),
        nativeConfigReady: Boolean(runtime && hasNativeConfig(runtime.configDir)),
        activeRoutes: routes,
      });
      const explicit = connectionId ?? routes[agent.harness] ?? null;
      const resolved = resolveActiveHarnessConnection({ harness: agent.harness, connections: agentConnections, explicit });
      const compatible = agentConnections
        .filter((connection) => connection.compatible_harnesses.includes(agent.harness))
        .map((connection) => connection.kind);
      const active = resolved.active?.kind ?? null;
      const presets = active ? modelPresets(active, agentSecrets.env, input.project.projectId) : [];
      const policy = active === 'managed_gateway'
        ? 'gateway-catalog'
        : active === 'native_config' || active === 'claude_subscription' || active === 'codex_subscription'
          ? 'harness-catalog'
          : 'launch-override';
      const defaultAllowed = computeDefaultAllowed({ active, harness: agent.harness, presetsLength: presets.length });
      const harnessGated = isExperimentalHarnessGated(agent.harness, input.metadata);
      const blockingReason = harnessGated
        ? `${HARNESSES[agent.harness].label} is an experimental harness — enable "Experimental harnesses" for this project in Settings → Experimental before selecting it.`
        : (resolved.reason ?? (!defaultAllowed ? `No usable model is available for ${agent.harness}.` : null));
      return {
        agent,
        auth: {
          compatible,
          active,
          ready: Boolean(resolved.active),
          reason: resolved.reason,
        },
        model: {
          policy,
          default_allowed: defaultAllowed,
          custom_allowed: true,
          live_change: HARNESSES[agent.harness].liveModelChange,
          presets,
        },
        can_start: !harnessGated && Boolean(resolved.active) && defaultAllowed,
        blocking_reason: blockingReason,
      };
    },
  };
}
