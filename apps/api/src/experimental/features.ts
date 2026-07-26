/**
 * Unified experimental-feature registry.
 *
 * We ship fast and we ship a lot. Some surfaces are real and usable but still
 * moving — they may change shape or break between versions. Rather than block
 * them behind a release or scatter one-off env flags, we expose them as
 * EXPERIMENTAL features that a project can opt into. This lets us soft-release:
 * push versions, dogfood, and let users try them per project — without treating
 * them as committed "prod" surface.
 *
 * Each feature has two gates:
 *   • available  — does the PLATFORM support it at all (operator env)? When a
 *                  feature is unavailable, the per-project toggle is hidden and
 *                  the surface stays dark no matter what a project has chosen.
 *   • enabled    — the EFFECTIVE per-project state: the project's explicit
 *                  choice (projects.metadata.experimental[key]) over the
 *                  operator default. `enabled` always implies `available`.
 *
 * Per-project state is DB-only (projects.metadata) — never in kortix.yaml. To
 * add a feature: append an entry below and gate its surface on
 * `resolveExperimentalFeature(metadata, key)`. The UI renders straight from
 * {@link buildExperimentalCatalog}, so a new entry lights up everywhere.
 */
import { config } from '../config';
import type { ExperimentalFeatureKey } from '@kortix/api-contract';

/** Stable identifiers for experimental features — wire contract is the SoT.
 *  `review_center` is added to the contract map (ExperimentalFeatureMapSchema). */
export type { ExperimentalFeatureKey } from '@kortix/api-contract';

/** How settled a feature is — surfaced as a badge so users know what to expect. */
type ExperimentalStability = 'experimental' | 'beta';

interface ExperimentalFeatureDef {
  key: ExperimentalFeatureKey;
  /** Short human label (Title Case). */
  name: string;
  /** One sentence: what it does + that it's a moving target. */
  description: string;
  stability: ExperimentalStability;
  /** Platform support gate (operator env). Hidden in UI when false. */
  available: () => boolean;
  /** Per-project default when the project hasn't made an explicit choice. */
  platformDefault: () => boolean;
}

/**
 * The registry. Order here is the order shown in Customize → Settings →
 * Experimental.
 *
 * agent_tunnel → connector: connected machines flow through the Executor as a
 * regular `computer` connector (one connector fronts all the account's machines;
 * `connectors`/`discover`/`describe`/`call`, one audit + policy path). That
 * connector is NO LONGER gated by this flag — it auto-materializes whenever the
 * account has a connected machine, exactly like the Slack channel connector
 * (see executor/computer-materialize.ts). This flag now only gates the dedicated
 * tunnel surface (Customize → Computers, the device-auth / permissions UI).
 * See docs/specs/computer-connector.md.
 */
const FEATURES: readonly ExperimentalFeatureDef[] = [
  {
    key: 'marketplace',
    name: 'Marketplace',
    description:
      'Browse and 1-click install skills from a marketplace of community & vendor registries (any SKILL.md repo). Sources, updates, and team scopes are still in flux.',
    stability: 'beta',
    available: () => true,
    // On by default for every project — no longer gated behind an opt-in toggle.
    platformDefault: () => true,
  },
  {
    key: 'agent_tunnel',
    name: 'Agent Computer Tunnel',
    description:
      'Let agents securely reach a local machine — files, shell, and desktop control — over a permissioned reverse tunnel. Connect a computer, then grant access per capability.',
    stability: 'experimental',
    // The backend service must be running platform-wide for the surface to work.
    available: () => config.TUNNEL_ENABLED,
    // Explicit opt-in: off by default even where the service is available.
    platformDefault: () => false,
  },
  {
    key: 'connectors_api_discover',
    name: 'Connectors API Discover',
    description:
      'Browse direct API, MCP, GraphQL, CLI, and Postman surfaces alongside optional Pipedream OAuth apps. The catalog and setup experience are still experimental.',
    stability: 'experimental',
    available: () => true,
    // Explicit opt-in: Easy Connect remains the default connector marketplace.
    platformDefault: () => false,
  },
  {
    key: 'agentmail_email',
    name: 'AgentMail Email',
    description:
      'Assign AgentMail inbox profiles to the agent so inbound email threads can start and continue Kortix sessions. Native email channels are still experimental.',
    stability: 'experimental',
    available: () => true,
    // Explicit opt-in: hidden unless a project enables it in Settings.
    platformDefault: () => false,
  },
  {
    key: 'voice',
    name: 'Voice',
    description:
      'Let the agent join your calls — Google Meet, Zoom, or Microsoft Teams — and hold a real spoken conversation: it listens continuously, answers in its own voice, and hands work off to itself in the background while you keep talking. Powered by Recall.ai for the call and a realtime speech model for the conversation.',
    stability: 'experimental',
    // Always listable; a project turns it on in Settings like any other
    // experiment. Credentials (RECALL_API_KEY, LIVEKIT_*) are still resolved
    // server-side per project and a missing one surfaces as a connector error
    // at spawn time — which is the right place to find out, rather than the
    // feature silently not existing.
    available: () => true,
    // Explicit opt-in: a project enables voice in Settings.
    platformDefault: () => false,
  },
  {
    key: 'llm_gateway',
    name: 'LLM Gateway',
    description:
      'Route this project through the managed Kortix LLM gateway. Toggling it refreshes active sandboxes so provider mode follows the project setting.',
    stability: 'experimental',
    // Master kill switch: when off, the feature disappears and every project
    // falls back to native OpenCode provider behavior.
    available: () => config.LLM_GATEWAY_ENABLED,
    // Fleet rollout switch. Operators can default the gateway on for every
    // project, while explicit project overrides still win and the master
    // availability gate above remains the emergency kill switch.
    platformDefault: () => config.LLM_GATEWAY_DEFAULT_ENABLED,
  },
  {
    key: 'acp_runtime',
    name: 'ACP Runtime',
    description:
      'Use the Agent Client Protocol for this project session interface. Disable this experiment to use the compatibility transport.',
    stability: 'experimental',
    available: () => true,
    platformDefault: () => false,
  },
  {
    key: 'review_center',
    name: 'Review Center',
    description:
      'A friendly inbox for change requests, approvals, and agent outputs — review and act (approve, reject, ask for changes) from one place, on the web or from Slack. The surface and what feeds it are still expanding.',
    stability: 'experimental',
    // Pure web/DB surface — the routes + table ship with the app, so no operator
    // env gates it. Always available; a project opts in per Settings.
    available: () => true,
    // Explicit opt-in: hidden unless a project enables it in Settings.
    platformDefault: () => false,
  },
];

const FEATURE_BY_KEY: Record<ExperimentalFeatureKey, ExperimentalFeatureDef> = Object.fromEntries(
  FEATURES.map((f) => [f.key, f]),
) as Record<ExperimentalFeatureKey, ExperimentalFeatureDef>;

const EXPERIMENTAL_FEATURE_KEYS: readonly ExperimentalFeatureKey[] = FEATURES.map((f) => f.key);

export function isExperimentalFeatureKey(value: unknown): value is ExperimentalFeatureKey {
  return (
    typeof value === 'string' && (EXPERIMENTAL_FEATURE_KEYS as readonly string[]).includes(value)
  );
}

/** Read the per-project explicit override map from a project's metadata. */
function overridesOf(metadata: unknown): Record<string, unknown> {
  const meta = (metadata as Record<string, unknown> | null | undefined) ?? {};
  const exp = meta.experimental;
  return exp && typeof exp === 'object' ? (exp as Record<string, unknown>) : {};
}

/** Read a single project's explicit override for a feature. */
function explicitOverride(metadata: unknown, key: ExperimentalFeatureKey): boolean | undefined {
  const fromMap = overridesOf(metadata)[key];
  if (typeof fromMap === 'boolean') return fromMap;
  return undefined;
}

/**
 * Effective enablement for one feature: the project's explicit choice over the
 * operator default, AND-gated by platform availability. An unavailable feature
 * is never enabled regardless of what a project chose.
 */
export function resolveExperimentalFeature(
  metadata: unknown,
  key: ExperimentalFeatureKey,
): boolean {
  const def = FEATURE_BY_KEY[key];
  if (!def || !def.available()) return false;
  return explicitOverride(metadata, key) ?? def.platformDefault();
}

/** Effective enablement for every feature, keyed by feature id. */
export function resolveExperimentalFeatures(
  metadata: unknown,
): Record<ExperimentalFeatureKey, boolean> {
  return Object.fromEntries(
    FEATURES.map((f) => [f.key, resolveExperimentalFeature(metadata, f.key)]),
  ) as Record<ExperimentalFeatureKey, boolean>;
}

/** Select the SDK client transport for one project.
 *  `KORTIX_OPENCODE_TRANSPORT=acp` is the operator-wide rollout override.
 *  The normal rollout remains an explicit project `acp_runtime` opt-in. */
export function resolveProjectRuntimeTransport(metadata: unknown): 'acp' | 'rest' {
  if (config.KORTIX_OPENCODE_TRANSPORT === 'acp') return 'acp';
  return resolveExperimentalFeature(metadata, 'acp_runtime') ? 'acp' : 'rest';
}

/** Serialized catalog entry for the client (drives the Customize UI). */
export interface ExperimentalFeatureView {
  key: ExperimentalFeatureKey;
  name: string;
  description: string;
  stability: ExperimentalStability;
  /** Platform supports it (operator env). When false the UI hides the toggle. */
  available: boolean;
  /** Effective per-project state (the switch position). */
  enabled: boolean;
  /** True when this project set an explicit choice (vs inheriting the default). */
  overridden: boolean;
}

/**
 * Build the full per-project catalog the web client renders. Self-contained so
 * the UI never hard-codes the feature list — add to FEATURES and it appears.
 */
export function buildExperimentalCatalog(metadata: unknown): ExperimentalFeatureView[] {
  return FEATURES.map((f) => ({
    key: f.key,
    name: f.name,
    description: f.description,
    stability: f.stability,
    available: f.available(),
    enabled: resolveExperimentalFeature(metadata, f.key),
    overridden: explicitOverride(metadata, f.key) !== undefined,
  }));
}

/**
 * Apply a per-project override to a metadata object, returning the next
 * metadata. `enabled: null` clears the override (falls back to the operator
 * default). Writes into `metadata.experimental[key]`.
 */
export function applyExperimentalOverride(
  metadata: unknown,
  key: ExperimentalFeatureKey,
  enabled: boolean | null,
): Record<string, unknown> {
  const meta = { ...((metadata as Record<string, unknown> | null) ?? {}) };
  const exp = Object.fromEntries(
    Object.entries(overridesOf(meta)).filter(([candidate]) => candidate !== key),
  );
  if (enabled !== null) {
    exp[key] = enabled;
  }
  if (Object.keys(exp).length > 0) {
    return { ...meta, experimental: exp };
  }
  const { experimental: _experimental, ...rest } = meta;
  return rest;
}
