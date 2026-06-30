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
 * Per-project state is DB-only (projects.metadata) — never in kortix.toml. To
 * add a feature: append an entry below and gate its surface on
 * `resolveExperimentalFeature(metadata, key)`. The UI renders straight from
 * {@link buildExperimentalCatalog}, so a new entry lights up everywhere.
 */
import { config } from '../config';

/** Stable identifiers for experimental features. */
export type ExperimentalFeatureKey =
  | 'apps'
  | 'agent_tunnel'
  | 'marketplace'
  | 'agentmail_email'
  | 'meet'
  | 'llm_gateway'
  | 'review_center';

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
    key: 'apps',
    name: 'Apps',
    description:
      "Deploy this project's repo as live apps. Adds the Apps shortcut and auto-deploys apps declared in kortix.toml.",
    stability: 'experimental',
    available: () => true,
    // Operator-wide default; flip KORTIX_APPS_EXPERIMENTAL to default the fleet on.
    platformDefault: () => config.KORTIX_APPS_EXPERIMENTAL,
  },
  {
    key: 'marketplace',
    name: 'Marketplace',
    description:
      'Browse and 1-click install skills from a marketplace of community & vendor registries (any SKILL.md repo). Sources, updates, and team scopes are still in flux.',
    stability: 'experimental',
    available: () => true,
    // Off by default — experimental / WIP.
    platformDefault: () => false,
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
    key: 'meet',
    name: 'Meetings',
    description:
      'Send a notetaker bot to your calls — Google Meet, Zoom, or Microsoft Teams — to record, transcribe with speaker labels, answer when addressed, and speak back in a voice you choose. Powered by Recall.ai; the agent drives it through the `meet` channel CLI.',
    stability: 'experimental',
    // Master kill switch (the global gate): when off, Meet disappears platform-wide
    // and every project falls back to no meeting bot — mirrors LLM Gateway.
    available: () => config.MEET_ENABLED,
    // Explicit opt-in: a project enables Meet in Settings.
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

/**
 * Read a single project's explicit override for a feature, honoring legacy
 * storage. Returns `undefined` when the project hasn't chosen.
 *
 * Back-compat: `apps` used to live at the top level as `metadata.apps_enabled`
 * before the registry existed. Honor it so existing opt-ins survive.
 */
function explicitOverride(metadata: unknown, key: ExperimentalFeatureKey): boolean | undefined {
  const fromMap = overridesOf(metadata)[key];
  if (typeof fromMap === 'boolean') return fromMap;
  if (key === 'apps') {
    const legacy = (metadata as Record<string, unknown> | null | undefined)?.apps_enabled;
    if (typeof legacy === 'boolean') return legacy;
  }
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
 * default). Writes into `metadata.experimental[key]`; also clears the legacy
 * top-level `apps_enabled` so the two never disagree.
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
  const base =
    key === 'apps'
      ? (() => {
          const { apps_enabled: _appsEnabled, ...rest } = meta;
          return rest;
        })()
      : meta;
  if (Object.keys(exp).length > 0) {
    return { ...base, experimental: exp };
  }
  const { experimental: _experimental, ...rest } = base;
  return rest;
}
