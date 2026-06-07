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
export type ExperimentalFeatureKey = 'apps' | 'agent_tunnel';

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
 * TODO(agent_tunnel → connector): the Agent Computer Tunnel is wired as its
 * own account-scoped surface today. The intended end state is to expose it
 * THROUGH the executor connectors system as an MCP-style connector, so it flows
 * through the single `connectors`/`discover`/`describe`/`call` execution path
 * like every other integration (one auth model, one audit trail, one policy
 * engine). See docs/specs/experimental-features.md. Until then this flag gates
 * the dedicated tunnel surface.
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
];

const FEATURE_BY_KEY: Record<ExperimentalFeatureKey, ExperimentalFeatureDef> =
  Object.fromEntries(FEATURES.map((f) => [f.key, f])) as Record<
    ExperimentalFeatureKey,
    ExperimentalFeatureDef
  >;

export const EXPERIMENTAL_FEATURE_KEYS: readonly ExperimentalFeatureKey[] =
  FEATURES.map((f) => f.key);

export function isExperimentalFeatureKey(
  value: unknown,
): value is ExperimentalFeatureKey {
  return (
    typeof value === 'string' &&
    (EXPERIMENTAL_FEATURE_KEYS as readonly string[]).includes(value)
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
function explicitOverride(
  metadata: unknown,
  key: ExperimentalFeatureKey,
): boolean | undefined {
  const fromMap = overridesOf(metadata)[key];
  if (typeof fromMap === 'boolean') return fromMap;
  if (key === 'apps') {
    const legacy = (metadata as Record<string, unknown> | null | undefined)
      ?.apps_enabled;
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
export function buildExperimentalCatalog(
  metadata: unknown,
): ExperimentalFeatureView[] {
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
  const exp = { ...overridesOf(meta) };
  if (enabled === null) {
    delete exp[key];
  } else {
    exp[key] = enabled;
  }
  if (Object.keys(exp).length > 0) {
    meta.experimental = exp;
  } else {
    delete meta.experimental;
  }
  // Retire the legacy top-level mirror so it can't shadow the registry value.
  if (key === 'apps') delete meta.apps_enabled;
  return meta;
}
