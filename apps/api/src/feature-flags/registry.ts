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
 * To add a flag, the key goes in SIX places. Typecheck forces only one of them
 * (the SDK union), so do not rely on a clean build:
 *
 *   1. `FeatureFlagMapSchema` — packages/api-contract/src/index.ts
 *   2. TWO sites in packages/api-contract/src/__tests__/schemas.test.ts: a
 *      project fixture, and a hand-written copy of the key list
 *   3. The `FeatureFlagKey` union AND the `FEATURE_FLAG_KEYS` array —
 *      packages/sdk/.../projects-client/projects.ts. Only the union is
 *      typechecked; a missing array entry compiles fine.
 *   4. Another hand-written copy in that package's projects.test.ts
 *   5. An entry below, DECLARING its enforcement mode
 *   6. One `useFeatureFlag` call + one map entry in
 *      apps/web/src/lib/use-project-feature-flags.ts (and move the trailing
 *      `isLoading:` to the newly-last hook)
 *
 * Then gate its routes with `requireFeatureFlag` (enforcement: 'routes'), or
 * its runtime behavior on `resolveFeatureFlag` (enforcement: 'behavioral').
 *
 * FOUR separate tests guard those six sites, each in its own package, so each
 * one fails only when that package's suite runs — they surface one CI round at
 * a time. `unit-feature-flag-drift.test.ts` compares contract <-> SDK <->
 * registry and catches 1/3/5 only. List every holder before you start:
 *
 *   rg -l "meta_agent" --glob '!node_modules' . | xargs rg -l "review_center"
 *
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
    key: 'llm_gateway',
    name: 'LLM Gateway',
    description:
      'Route this project through the managed Kortix LLM gateway (managed models, metering, budgets). Off, the sandbox runs native OpenCode model management: your provider API keys are injected as ordinary env vars and models are native provider/model refs. Toggling refreshes active sandboxes either way.',
    stability: 'experimental',
    // Master kill switch: when off, the feature disappears and every project
    // falls back to native OpenCode provider behavior.
    available: () => config.LLM_GATEWAY_ENABLED,
    // Fleet rollout switch, default ON (config.ts LLM_GATEWAY_DEFAULT_ENABLED).
    // Turning the flag OFF per project is the first-class native path — the
    // deliberate lever for deployments (e.g. Essentia) that bring their own
    // keys end to end. Explicit project overrides always win, and the master
    // availability gate above remains the emergency kill switch.
    platformDefault: () => config.LLM_GATEWAY_DEFAULT_ENABLED,
    enforcement: 'behavioral',
    enforcementNote:
      'Enablement forks the whole model path: KORTIX_LLM_* env injection at ' +
      'sandbox provision, provider-key secret delivery (withheld when on, ' +
      'plaintext env when off — projects/secrets.ts materializeSecretDelivery), ' +
      'gateway model validation vs native provider/model refs, the gated ' +
      'llm-catalog/model-picker/model-defaults routes, and gateway title ' +
      'generation. Toggling propagates to active sandboxes via ' +
      'propagateLlmGatewayModeToActiveSandboxes.',
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
      'Deploy static sites, JavaScript bundles, Dockerfiles, and OCI images to stable serverless URLs. Apps answer to the same machine limits, account entitlement, and per-account quotas sessions do.',
    stability: 'stable',
    available: () => true,
    platformDefault: () => false,
    enforcement: 'routes',
  },
  {
    key: 'monitors',
    name: 'Monitors',
    description:
      'Run 24/7 watchers from your repo that observe anything — logs, feeds, APIs — and fire trigger events into agent sessions. Runs on a persistent per-project monitor box. The contract is still experimental; see docs/specs/2026-08-12-monitors.md.',
    stability: 'experimental',
    // Monitors need a provider that can run a persistent (never auto-stopped)
    // box. Only Platinum supports autoStop=0 — Daytona clamps auto-stop to
    // ≥1 min and E2B caps runtime at 1 h — so the surface stays dark unless
    // Platinum credentials are configured.
    available: () => Boolean(config.PLATINUM_API_KEY),
    // Explicit opt-in: off by default even where Platinum is available.
    platformDefault: () => false,
    enforcement: 'routes',
  },
  {
    key: 'warm_sessions',
    name: 'Warm Sessions',
    description:
      'Keep one sandbox booted and waiting while you have a project open, so a new session starts instantly instead of waiting for a cold boot. A warm sandbox is billed compute even when idle, and it uses one of your concurrent-session slots until you use it or it expires. Turn this off to trade instant starts for lower cost.',
    // The surface is small and server-owned, but the cost tradeoff is real and
    // the presence model is new. `beta` says "we intend this on for everyone,
    // and we expect to tune the grant".
    stability: 'beta',
    available: () => true,
    // On by default: an instant session start is the point of the product, and
    // the cost is bounded per project by `findWarmProjectSession` (one live
    // warm session per user per project, matched by query, not by a unique
    // index — see projects/routes/warm-sessions.ts) plus the sandbox deadline.
    // A replenish also excludes the session the caller just took
    // (`exclude_session_id`), so it never hands that same session back.
    platformDefault: () => true,
    // NOT 'ui-only'. A flag that only hid client surface would let any other
    // caller keep booting billed sandboxes, which defeats the reason someone
    // turns this off.
    enforcement: 'routes',
  },
  {
    key: 'secrets_egress',
    name: 'Network-Enforced Secrets',
    description:
      'Let a secret be enforced at the network instead of loaded into the sandbox: the sandbox holds a handle and Kortix substitutes the real value only on requests to approved hosts. Off ⇒ every secret loads into the sandbox environment and the "Enforce at the network" option is hidden.',
    stability: 'experimental',
    available: () => true,
    // On by default (Marko, 2026-09-03). The OPTION is available; a new secret
    // still defaults to an environment variable — enforcing at the network is
    // a per-secret choice. A project that turns the flag off hides the option
    // and the write routes refuse to move a secret into egress delivery.
    platformDefault: () => true,
    enforcement: 'behavioral',
    enforcementNote:
      'No dedicated routes. The secret write paths (POST /secrets and PUT ' +
      '/secrets/:id/strategy in projects/routes/r3.ts) reject a request that ' +
      'moves a secret INTO egress delivery when the flag is off. A secret that ' +
      'is already egress keeps serving and stays editable, so turning the flag ' +
      'off never strands an existing enforced secret.',
  },
  {
    key: 'pi_worker',
    name: 'Pi Worker Runtime (compiled)',
    description:
      'Compile boot artifacts for every push: a pi-based worker runtime .mjs per commit (agent config from kortix.yaml baked in at that exact sha, downloadable per ref+sha) plus the OpenCode compiled-boot artifacts for this project even where KORTIX_COMPILED_BOOT_MODE is off. Harness/worker split experiment. Sessions boot ON the worker when the manifest also sets `runtime: pi`; without that manifest line sessions keep the OpenCode path.',
    stability: 'experimental',
    available: () => true,
    // Explicit opt-in per project. Off ⇒ no artifact is compiled on push and
    // the download route answers 403.
    platformDefault: () => false,
    enforcement: 'routes',
  },
  {
    key: 'monitoring',
    name: 'Monitoring',
    description:
      'A stage board (Backlog → Planning → Ready → In progress → Review → Done) over every session you can see, plus per-trigger run lists; agents move their own card with `kortix sessions stage`, and a card parked in Ready with --needs-approval waits for your go-ahead.',
    stability: 'experimental',
    // Pure web/DB surface — no operator env gates it.
    available: () => true,
    // Explicit opt-in per project.
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
