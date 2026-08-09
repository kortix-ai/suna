/**
 * Unified feature-flag registry.
 *
 * We ship fast and we ship a lot. Any surface — experimental, beta, or fully
 * stable — can ship dark behind a per-project flag and be turned on from
 * Settings → Feature flags. "Experimental" is a stability badge on a flag,
 * not the system's name.
 *
 * Each flag has two gates:
 *   • available  — does the PLATFORM support it at all (operator env)? When a
 *                  flag is unavailable, the per-project toggle is hidden and
 *                  the surface stays dark no matter what a project has chosen.
 *   • enabled    — the EFFECTIVE per-project state: the project's explicit
 *                  choice (projects.metadata.experimental[key]) over the
 *                  operator default. `enabled` always implies `available`.
 *
 * Per-project state is DB-only (projects.metadata) — never in kortix.yaml.
 * The `experimental` metadata key is a stable storage detail; do not rename it.
 *
 * To add a flag:
 *   1. Add the key to FeatureFlagMapSchema in @kortix/api-contract (typecheck
 *      forces this) and to the SDK's runtime key list.
 *   2. Append an entry below, DECLARING its enforcement mode.
 *   3. Gate its routes with `requireFeatureFlag` (enforcement: 'routes'), or
 *      its runtime behavior on `resolveFeatureFlag` (enforcement: 'behavioral').
 * The UI renders straight from {@link buildFeatureFlagCatalog}, so a new entry
 * lights up in Settings automatically. `unit-feature-flags.test.ts` pins the
 * catalog to the contract key list and requires every entry to declare its
 * enforcement.
 */
import { config } from '../config';
import type { FeatureFlagKey, FeatureFlagStability } from '@kortix/api-contract';

export type { FeatureFlagKey, FeatureFlagStability } from '@kortix/api-contract';

/**
 * How the flag is actually enforced server-side. This is a declaration the
 * tests read — it makes "the switch does nothing on the server" an explicit,
 * reviewed decision instead of silent drift.
 *
 *  • 'routes'     — HTTP surface rejects with 403 `feature_disabled` when off
 *                   (via `requireFeatureFlag`).
 *  • 'behavioral' — no dedicated routes; the flag changes what the platform
 *                   does (connector materialization, env injection, agent
 *                   list). Off ⇒ the behavior does not occur.
 *  • 'ui-only'    — the server deliberately does NOT enforce; the flag only
 *                   hides client surface. Requires `enforcementNote` naming
 *                   the decision. Use sparingly.
 */
export type FeatureFlagEnforcement = 'routes' | 'behavioral' | 'ui-only';

export interface FeatureFlagDef {
  key: FeatureFlagKey;
  /** Short human label (Title Case). */
  name: string;
  /** One sentence: what it does and what to expect. */
  description: string;
  stability: FeatureFlagStability;
  /** Platform support gate (operator env). Hidden in UI when false. */
  available: () => boolean;
  /** Per-project default when the project hasn't made an explicit choice. */
  platformDefault: () => boolean;
  enforcement: FeatureFlagEnforcement;
  /** Mandatory for 'ui-only': why the server does not enforce. */
  enforcementNote?: string;
}

/**
 * The registry. Order here is the order shown in Settings → Feature flags.
 *
 * agent_tunnel → connector: paired machines are selectable accounts inside a
 * regular `computer` connector profile. A profile can contain one or more
 * machines and uses the normal connector grant, policy, call, and audit paths.
 * Pairing does not auto-create project access. This flag gates the dedicated
 * fleet surface (Customize → Computers, device auth, and tunnel permissions).
 * Connector profiles remain API-managed because tunnel ids do not belong in
 * repository configuration. See docs/specs/computer-connector.md.
 */
const FLAGS: readonly FeatureFlagDef[] = [
  {
    key: 'marketplace',
    name: 'Marketplace',
    description:
      'Browse and 1-click install skills from a marketplace of community & vendor registries (any SKILL.md repo). Sources, updates, and team scopes are still in flux.',
    stability: 'beta',
    available: () => true,
    // On by default for every project — no longer gated behind an opt-in toggle.
    platformDefault: () => true,
    enforcement: 'routes',
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
    enforcement: 'ui-only',
    enforcementNote:
      'Tunnel state is account-scoped (device auth, machines) and the computer ' +
      'connector deliberately materializes independent of this flag — see the ' +
      'registry header. The platform-wide TUNNEL_ENABLED env is the hard gate.',
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
    enforcement: 'routes',
  },
  {
    key: 'agentmail_email',
    name: 'AgentMail Email',
    description:
      'Assign AgentMail inbox connections to the agent so inbound email threads can start and continue Kortix sessions. Native email channels are still experimental.',
    stability: 'experimental',
    available: () => true,
    // Explicit opt-in: hidden unless a project enables it in Settings.
    platformDefault: () => false,
    enforcement: 'routes',
  },
  {
    key: 'teams',
    name: 'Microsoft Teams',
    description:
      'Connect a Microsoft Teams bot so chats and channels can start and continue Kortix sessions. The install flow, org-catalog publishing, and bring-your-own-bot setup are still experimental.',
    stability: 'experimental',
    // Always listable. Server-side bot credentials (MICROSOFT_APP_ID /
    // MICROSOFT_APP_PASSWORD) only decide whether the MANAGED install path is
    // offered — `teamsMode().available` reports that separately, and a project
    // can always bring its own bot app. Gating availability on the credentials
    // would hide the bring-your-own flow on exactly the deployments that need
    // it (self-host).
    available: () => true,
    // Explicit opt-in: a project turns Teams on in Settings.
    platformDefault: () => false,
    enforcement: 'routes',
  },
  {
    key: 'voice',
    name: 'Voice',
    description:
      'Give the agent a live voice call it can start and hold a real spoken conversation in: it listens continuously, answers in its own voice, and hands work off to itself in the background while the call continues. The agent spawns the call and shares a join link with whoever should be on it — it does not join a meeting itself.',
    stability: 'experimental',
    // Always listable; a project turns it on in Settings like any other flag.
    // Credentials (LIVEKIT_*) are still resolved server-side per project and a
    // missing one surfaces as an error at spawn time — which is the right place
    // to find out, rather than the feature silently not existing.
    available: () => true,
    // Explicit opt-in: a project enables voice in Settings.
    platformDefault: () => false,
    enforcement: 'behavioral',
    enforcementNote:
      'Voice has no HTTP routes of its own; the flag IS the registration — it ' +
      'decides whether the kortix_voice channel connector materializes ' +
      '(connectors/channel-materialize.ts).',
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
    enforcement: 'behavioral',
    enforcementNote:
      'Enablement decides KORTIX_LLM_* env injection at sandbox provision plus ' +
      'the gated llm-catalog/model-picker routes; toggling propagates to active ' +
      'sandboxes via propagateLlmGatewayModeToActiveSandboxes.',
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
    enforcement: 'routes',
  },
  {
    key: 'meta_agent',
    name: 'Meta Agent',
    description:
      'A reserved coordinator agent that spawns and manages specialized sessions, transfers files between them, and orchestrates multi-step work across the project. Adds a platform-owned meta agent to the project and changes the default agent for new sessions without an explicit --agent flag.',
    stability: 'experimental',
    available: () => true,
    platformDefault: () => false,
    enforcement: 'behavioral',
    enforcementNote:
      'Off ⇒ the platform meta agent is not added to the agent list and is not ' +
      'the default for new sessions (projects/lib/platform-meta-agent.ts).',
  },
  {
    key: 'apps',
    name: 'Apps',
    description:
      'Deploy static sites, JavaScript bundles, Dockerfiles, and OCI images to stable serverless URLs. The deployment contract is still experimental.',
    stability: 'experimental',
    available: () => true,
    platformDefault: () => false,
    enforcement: 'routes',
  },
];

const FLAG_BY_KEY: Record<FeatureFlagKey, FeatureFlagDef> = Object.fromEntries(
  FLAGS.map((f) => [f.key, f]),
) as Record<FeatureFlagKey, FeatureFlagDef>;

/** Registry order, for tests and iteration. Same members as the contract's
 *  FEATURE_FLAG_KEYS — unit-feature-flags.test.ts pins the equality. */
export const REGISTERED_FEATURE_FLAGS: readonly FeatureFlagDef[] = FLAGS;

export function isFeatureFlagKey(value: unknown): value is FeatureFlagKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(FLAG_BY_KEY, value);
}

export function featureFlagDef(key: FeatureFlagKey): FeatureFlagDef {
  return FLAG_BY_KEY[key];
}

/** Read the per-project explicit override map from a project's metadata. */
function overridesOf(metadata: unknown): Record<string, unknown> {
  const meta = (metadata as Record<string, unknown> | null | undefined) ?? {};
  const exp = meta.experimental;
  return exp && typeof exp === 'object' ? (exp as Record<string, unknown>) : {};
}

/** Read a single project's explicit override for a flag. Non-boolean garbage
 *  in the stored map is treated as "no override". */
function explicitOverride(metadata: unknown, key: FeatureFlagKey): boolean | undefined {
  const fromMap = overridesOf(metadata)[key];
  if (typeof fromMap === 'boolean') return fromMap;
  return undefined;
}

/**
 * Effective enablement for one flag: the project's explicit choice over the
 * operator default, AND-gated by platform availability. An unavailable flag
 * is never enabled regardless of what a project chose.
 */
export function resolveFeatureFlag(metadata: unknown, key: FeatureFlagKey): boolean {
  const def = FLAG_BY_KEY[key];
  if (!def || !def.available()) return false;
  return explicitOverride(metadata, key) ?? def.platformDefault();
}

/** Effective enablement for every flag, keyed by flag id. */
export function resolveFeatureFlags(metadata: unknown): Record<FeatureFlagKey, boolean> {
  return Object.fromEntries(
    FLAGS.map((f) => [f.key, resolveFeatureFlag(metadata, f.key)]),
  ) as Record<FeatureFlagKey, boolean>;
}

/** Serialized catalog entry for the client (drives Settings → Feature flags). */
export interface FeatureFlagView {
  key: FeatureFlagKey;
  name: string;
  description: string;
  stability: FeatureFlagStability;
  /** Platform supports it (operator env). When false the UI hides the toggle. */
  available: boolean;
  /** Effective per-project state (the switch position). */
  enabled: boolean;
  /** True when this project set an explicit choice (vs inheriting the default). */
  overridden: boolean;
}

/**
 * Build the full per-project catalog the clients render. Self-contained so the
 * UI never hard-codes the flag list — add to FLAGS and it appears.
 */
export function buildFeatureFlagCatalog(metadata: unknown): FeatureFlagView[] {
  return FLAGS.map((f) => ({
    key: f.key,
    name: f.name,
    description: f.description,
    stability: f.stability,
    available: f.available(),
    enabled: resolveFeatureFlag(metadata, f.key),
    overridden: explicitOverride(metadata, f.key) !== undefined,
  }));
}
