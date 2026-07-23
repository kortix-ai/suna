import { CATALOG, type CatalogModel } from '@kortix/llm-catalog';
import {
  HARNESSES,
  HARNESS_IDS,
  type HarnessId,
  compatibleHarnessesFor,
} from '@kortix/shared/harnesses';

import {
  authProviderRefForKind,
  resolveCredentialStatusCached,
} from '../../llm-gateway/auth/credential-status';
import type { CredentialStatus } from '../../llm-gateway/auth/resolve-credential-status';
import { projectLlmGatewayEnabled } from '../../llm-gateway/enablement';
import {
  type HarnessModelResolutionState,
  isCredentialConfigured,
  resolveHarnessModels,
} from '../../llm-gateway/resolution/harness-models';
import { listRepoFiles } from '../git/files';
import type { GitBackedProject } from '../git/types';
import { listProjectSecretsSnapshotForUser } from '../secrets';
import {
  type LogicalAgentLaunchPlan,
  resolveCompiledRuntimeConfigForSession,
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
  // Typed credential HEALTH (docs/specs/2026-07-22-unified-auth-gateway.md
  // §4/§8) — distinct from `configured` (presence-only). Populated only for a
  // configured connection that maps to an auth-provider registry entry
  // (`managed_gateway`/`native_config` have none); `null` when unknown/
  // un-probed or the live check failed (fail-open — a probe error never sinks
  // the listing). Lets the UI render healthy/expired/invalid/unverified
  // instead of a bare "Connected".
  status?: CredentialStatus | null;
  status_reason?: string | null;
  status_expires_at?: number | null;
};

export type ComposerModelPreset = {
  id: string;
  name: string;
  source: string;
  // Additive (phase 1 of the model-resolution refactor, docs/specs/2026-07-
  // 21-model-resolution-refactor-plan.md): the REAL upstream provider id for
  // this model (e.g. 'anthropic', 'kortix', 'codex', 'custom') — sourced
  // directly from `resolveHarnessModels`'s provider-tagged `ResolvedModel`
  // for every catalog-driven harness, so no client ever needs to guess a
  // model's provider by parsing the wire id.
  provider: string;
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
    // Additive: the closed resolution state this capability payload was
    // computed from (`llm-gateway/resolution/harness-models.ts`'s
    // `HarnessModelResolutionState`). `default_allowed`/`can_start` are both
    // renderings of `state === 'ready'` — this field is the authoritative
    // one a client should switch on for the five UI renderings the refactor
    // plan's §3.1 describes; the booleans stay for back-compat.
    state: HarnessModelResolutionState;
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
// story (managed gateway, BYOK, custom endpoints, native config).
//
// `compatible_harnesses` is NOT authored here (2026-07-21 model-resolution
// refactor, docs/specs/2026-07-21-model-resolution-refactor-plan.md §4.2):
// it used to be a hand-maintained array that had to be kept in exact sync
// with `packages/shared/src/harnesses.ts`'s `authKinds` — two arrays that
// must always agree are one authored fact wearing two costumes. It is now a
// pure derivation (`compatibleHarnessesFor`) over that ONE authored table,
// computed per entry below — `label`/`source` are the only real per-kind
// data this table still carries.
const CONNECTION_LABELS: Record<HarnessAuthKind, Pick<HarnessConnection, 'label' | 'source'>> = {
  managed_gateway: { label: 'Kortix managed gateway', source: 'kortix' },
  claude_subscription: { label: 'Claude subscription', source: 'project_secret' },
  anthropic_api_key: { label: 'Anthropic API key', source: 'project_secret' },
  codex_subscription: { label: 'ChatGPT/Codex subscription', source: 'project_secret' },
  openai_api_key: { label: 'OpenAI API key', source: 'project_secret' },
  openai_compatible: { label: 'OpenAI-compatible REST', source: 'project_secret' },
  // Deliberate capability decision (2026-07-15): a custom Anthropic-protocol
  // endpoint had exactly one consumer — Claude Code custom routing — and that
  // routing is cut by the harness-only simplification above. No harness is
  // compatible with this kind (compatibleHarnessesFor('anthropic_compatible')
  // is empty because no harness's authKinds lists it) — the form/route
  // plumbing stays intact (cheap to bring back) but it is unreachable from
  // any UI surface.
  anthropic_compatible: { label: 'Anthropic-compatible REST', source: 'project_secret' },
  native_config: { label: 'Harness-native config', source: 'native_config' },
};

const CONNECTIONS: Record<
  HarnessAuthKind,
  Pick<HarnessConnection, 'label' | 'compatible_harnesses' | 'source'>
> = Object.fromEntries(
  (Object.keys(CONNECTION_LABELS) as HarnessAuthKind[]).map((kind) => [
    kind,
    { ...CONNECTION_LABELS[kind], compatible_harnesses: compatibleHarnessesFor(kind) },
  ]),
) as Record<HarnessAuthKind, Pick<HarnessConnection, 'label' | 'compatible_harnesses' | 'source'>>;

const ACTIVE_ROUTES_METADATA_KEY = 'harness_auth_routes';

function isHarnessAuthKind(value: unknown): value is HarnessAuthKind {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CONNECTIONS, value);
}

export function readHarnessAuthRoutes(
  metadata: unknown,
): Partial<Record<HarnessId, HarnessAuthKind>> {
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
  const current =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? { ...(metadata as Record<string, unknown>) }
      : {};
  const routes = { ...readHarnessAuthRoutes(current) };
  if (connectionId) routes[harness] = connectionId;
  else delete routes[harness];
  return { ...current, [ACTIVE_ROUTES_METADATA_KEY]: routes };
}

// `buildHarnessConnections` backs the `/harness-connections` LISTING route
// (and the PUT active-route selector's own configured/ready check) — a
// connections-catalog UI concern, distinct from session-start authority.
// Credential PRESENCE (`isCredentialConfigured`) is concept 1.1, gateway-
// owned (docs/specs/2026-07-21-model-resolution-refactor-plan.md §2) —
// imported, not re-derived here. The AUTHORITATIVE "can a session actually
// start" answer comes exclusively from `resolveHarnessModels`
// (`capabilities()` below); this listing's `ready` field stays a
// presence/flag signal for the connections UI, same as before.
export function buildHarnessConnections(input: {
  env: Record<string, string>;
  gatewayEnabled: boolean;
  nativeConfigReady?: boolean;
  activeRoutes?: Partial<Record<HarnessId, HarnessAuthKind>>;
}): HarnessConnection[] {
  const explicit = input.activeRoutes ?? {};
  return (Object.keys(CONNECTIONS) as HarnessAuthKind[]).map((kind) => {
    const definition = CONNECTIONS[kind];
    const configured = isCredentialConfigured(
      kind,
      input.env,
      input.gatewayEnabled,
      input.nativeConfigReady === true,
    );
    const activeFor = definition.compatible_harnesses.filter(
      (harness) => explicit[harness] === kind,
    );
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

/**
 * Layers typed credential HEALTH onto a built connection listing (docs/specs/
 * 2026-07-22-unified-auth-gateway.md §4/§8). Probes only CONFIGURED
 * connections that map to an auth-provider registry entry, in parallel, via
 * the 30s-memoized `resolveCredentialStatusCached` (so a polled listing route
 * cannot hammer upstreams). Fail-open per connection: any probe error leaves
 * `status: null` and never breaks the listing. Mutates `connections` in place.
 */
async function enrichConnectionsWithStatus(
  connections: HarnessConnection[],
  projectId: string,
  userId: string | null,
): Promise<void> {
  await Promise.all(
    connections.map(async (connection) => {
      if (!connection.configured) return;
      const ref = authProviderRefForKind(connection.kind);
      if (!ref) return;
      try {
        const record = await resolveCredentialStatusCached(
          projectId,
          userId,
          ref.providerId,
          ref.door,
        );
        connection.status = record.status;
        connection.status_reason = record.reason;
        connection.status_expires_at = record.expiresAt;
      } catch {
        connection.status = null;
      }
    }),
  );
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
    connection.compatible_harnesses.includes(input.harness),
  );
  if (input.explicit) {
    const selected = compatible.find((connection) => connection.id === input.explicit) ?? null;
    if (!selected)
      return { active: null, reason: `${input.explicit} is not compatible with ${input.harness}.` };
    if (!selected.ready) return { active: null, reason: selected.reason };
    return { active: selected, reason: null };
  }

  // Deterministic compatibility path: a configured managed route is the
  // platform default. With no managed route, exactly one configured native/BYOK
  // route may be adopted; two or more require an explicit choice.
  const managed = compatible.find(
    (connection) => connection.id === 'managed_gateway' && connection.ready,
  );
  if (managed) return { active: managed, reason: null };
  const ready = compatible.filter(
    (connection) => connection.ready && connection.id !== 'native_config',
  );
  if (ready.length === 1) return { active: ready[0]!, reason: null };
  if (ready.length > 1) {
    return {
      active: null,
      reason: `Choose which ${input.harness} authentication connection to use.`,
    };
  }
  const native = compatible.find(
    (connection) => connection.id === 'native_config' && connection.ready,
  );
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
      const released =
        (Date.parse(b.released ?? '') || Number.NEGATIVE_INFINITY) -
        (Date.parse(a.released ?? '') || Number.NEGATIVE_INFINITY);
      return released !== 0 ? released : a.id.localeCompare(b.id);
    })
    .slice(0, limit);
}

/**
 * The small, curated preset list for a harness-native connection kind —
 * NEVER the unconditioned gateway catalog dump. `managed_gateway`'s branch
 * (2026-07-21 refactor's kill target — it used to call `gatewayModelCatalog`
 * directly, gated only by `Boolean(projectId)`, the entire root cause of
 * "Pi/OpenCode show 4,941 models") is gone: for every catalog-driven harness
 * (`ownsDefaultModel: false` — OpenCode, and per the same refactor's Pi
 * decision, Pi), `resolveHarnessModels`'s credential-conditioned, provider-
 * tagged `models` IS the presets source now — see `capabilities()` below.
 * This function only remains for the genuinely separate, already-narrow
 * cases: a harness-native curated preset list (top-N Anthropic/OpenAI models
 * for Claude/Codex when authenticated via a bare API key, not their
 * subscription) and a project's own custom-endpoint/native-config
 * declarations, neither of which the gateway's runtime catalog knows about.
 */
export function modelPresets(
  kind: HarnessAuthKind,
  env: Record<string, string>,
  _projectId: string,
): ComposerModelPreset[] {
  const providerId =
    kind === 'anthropic_api_key' ? 'anthropic' : kind === 'openai_api_key' ? 'openai' : null;
  if (providerId) {
    const provider = CATALOG.providers.find((entry) => entry.id === providerId);
    const models = newestCatalogModels(provider?.models ?? [], NATIVE_MODEL_PRESET_LIMIT);
    return models.map((model) => ({
      id: model.id,
      name: model.name || model.id,
      source: 'models.dev',
      provider: providerId,
    }));
  }
  if (kind === 'openai_compatible' || kind === 'anthropic_compatible') {
    const id = env.CUSTOM_LLM_MODEL_ID?.trim();
    return id ? [{ id, name: id, source: 'project', provider: 'custom' }] : [];
  }
  if (kind === 'native_config') {
    return CATALOG.providers.flatMap((provider) => {
      const names = provider.env ?? [];
      if (!names.length || !names.every((name) => Boolean(env[name]?.trim()))) return [];
      return provider.models.map((model) => ({
        id: `${provider.id}/${model.id}`,
        name: model.name || model.id,
        source: 'models.dev',
        provider: provider.id,
      }));
    });
  }
  // Subscription access is owned by the authenticated harness. Never fabricate
  // its model list from models.dev.
  return [];
}

/**
 * Which repo-committed files under a harness's config directory actually
 * constitute a `native_config` AUTH route — the harness reading its own
 * configuration (and, through it, its own credentials) out of the repo.
 *
 * Deliberately narrow, and deliberately NOT "anything under `configDir`".
 * `@kortix/starter`'s `addNativeHarnessSkillLinks` commits `.claude/skills`,
 * `.codex/skills` and `.pi/skills` as symlinks into OpenCode's canonical
 * skills tree, so every project made from the default template carries all
 * four config directories from its first commit. A presence-only check made
 * `native_config` read as configured for every harness with zero credentials,
 * and because Claude/Codex own their default model (`ownsDefaultModel`),
 * `resolveHarnessModels` short-circuited to `ready` before it ever looked for
 * one — handing the user a sendable composer with nothing behind it and no
 * connect gate. Agent skills, commands, and subagent definitions are shared
 * CONTENT; they say nothing about how the harness authenticates.
 */
const NATIVE_CONFIG_FILES: Record<HarnessId, readonly string[]> = {
  claude: ['settings.json', 'settings.local.json', '.credentials.json'],
  codex: ['config.toml', 'auth.json'],
  opencode: ['opencode.json', 'opencode.jsonc', 'auth.json'],
  pi: ['config.json', 'config.toml', 'auth.json'],
};

/**
 * Whether `files` carries a real harness-native config for `harness` — a
 * recognised config file sitting at the ROOT of its config directory (that is
 * where every harness reads its own config from; a `settings.json` nested
 * inside a skill is that skill's data, not the harness's configuration).
 *
 * Pure over a repo tree slice, so the seeded-project regression is unit
 * testable without a git mirror — see
 * `composer-capabilities-native-config.test.ts`.
 */
export function harnessNativeConfigPresent(input: {
  harness: HarnessId;
  configDir: string;
  files: readonly { path: string }[];
}): boolean {
  const prefix = input.configDir.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!prefix) return false;
  const recognised = NATIVE_CONFIG_FILES[input.harness];
  return input.files.some((file) => {
    if (!file.path.startsWith(`${prefix}/`)) return false;
    const relative = file.path.slice(prefix.length + 1);
    return !relative.includes('/') && recognised.includes(relative);
  });
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
  /**
   * The project's owning account — passed straight through to
   * `resolveHarnessModels` (`llm-gateway/resolution/harness-models.ts`) for
   * its real per-account managed-route servability probe and free-tier gate.
   * Optional for backward compatibility with callers/tests that don't have
   * an account context yet — without it, the probe degrades to "assume
   * servable" (the historical behavior), since there's no account to
   * evaluate entitlement/credentials against. Every real HTTP call site has
   * this on hand (`project.accountId`) and should pass it.
   */
  accountId?: string;
}): Promise<{
  agents: ComposerCapabilities['agent'][];
  connections: HarnessConnection[];
  providers: ConfiguredModelProvider[];
  capabilities(
    agentName: string,
    connectionId?: HarnessAuthKind | null,
  ): Promise<ComposerCapabilities>;
}> {
  const [compiled, secrets, repoFiles] = await Promise.all([
    resolveCompiledRuntimeConfigForSession(input.project),
    listProjectSecretsSnapshotForUser(input.project.projectId, input.userId, 'all'),
    // Capability discovery must fail closed for native config without taking
    // managed/BYOK routes down when the git mirror is briefly unavailable.
    listRepoFiles(input.project, input.project.defaultBranch).catch(() => []),
  ]);
  const hasNativeConfig = (harness: HarnessId, configDir: string): boolean =>
    harnessNativeConfigPresent({ harness, configDir, files: repoFiles });
  const anyNativeConfig = compiled
    ? Object.values(compiled.runtimes).some((runtime) =>
        hasNativeConfig(runtime.harness as HarnessId, runtime.configDir),
      )
    : false;
  const routes = readHarnessAuthRoutes(input.metadata);
  const connections = buildHarnessConnections({
    env: secrets.env,
    gatewayEnabled: projectLlmGatewayEnabled(input.metadata),
    nativeConfigReady: anyNativeConfig,
    activeRoutes: routes,
  });
  await enrichConnectionsWithStatus(connections, input.project.projectId, input.userId);
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
      const explicit = connectionId ?? routes[agent.harness] ?? null;

      // THE resolution call — everything below is rendering, not computation
      // (docs/specs/2026-07-21-model-resolution-refactor-plan.md §1.4/§2).
      // Nothing in this closure re-derives credential health, catalog
      // reachability, or a usable-default boolean; `resolution.state` is the
      // one fact `can_start`/`auth.ready`/`model.default_allowed` all render.
      const resolution = await resolveHarnessModels({
        harness: agent.harness,
        projectId: input.project.projectId,
        accountId: input.accountId,
        userId: input.userId,
        env: agentSecrets.env,
        gatewayEnabled: projectLlmGatewayEnabled(input.metadata),
        nativeConfigReady: Boolean(runtime && hasNativeConfig(agent.harness, runtime.configDir)),
        explicit,
      });

      const active = resolution.credentialRef?.kind ?? null;
      // The narrowed, provider-tagged catalog IS the presets for a catalog-
      // driven harness (OpenCode, and per the 2026-07-21 Pi decision, Pi) —
      // `modelPresets` is never called for them anymore. `ownsDefaultModel`
      // harnesses (Claude, Codex) keep their existing small curated-preset
      // feature (an override suggestion list, genuinely separate from — and
      // never the unconditioned dump behind — the resolution module's own
      // no-catalog `ready` shape for them).
      const presets: ComposerModelPreset[] = resolution.ownsDefaultModel
        ? active
          ? modelPresets(active, agentSecrets.env, input.project.projectId)
          : []
        : resolution.models.map((model) => ({
            id: model.id,
            name: model.name,
            source: resolution.upstreamKind === 'gateway' ? 'kortix-gateway' : 'project',
            provider: model.provider,
          }));
      const policy =
        active === 'managed_gateway'
          ? 'gateway-catalog'
          : active === 'native_config' ||
              active === 'claude_subscription' ||
              active === 'codex_subscription'
            ? 'harness-catalog'
            : 'launch-override';
      return {
        agent,
        auth: {
          compatible: HARNESSES[agent.harness].authKinds,
          active,
          ready: resolution.state === 'ready',
          reason: resolution.reason,
        },
        model: {
          policy,
          default_allowed: resolution.state === 'ready',
          custom_allowed: true,
          live_change: HARNESSES[agent.harness].liveModelChange,
          presets,
          state: resolution.state,
        },
        can_start: resolution.state === 'ready',
        blocking_reason: resolution.reason,
      };
    },
  };
}
