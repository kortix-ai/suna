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
 *   rg -l "meta_agent" --glob '!node_modules' . | xargs rg -l "pi_worker"
 *
 * The UI renders straight from {@link buildFeatureFlagCatalog}, so a new entry
 * lights up in Settings automatically. `unit-feature-flags.test.ts` pins the
 * catalog to the contract key list and requires every entry to declare its
 * enforcement.
 *
 * ## Hidden flags (`catalogHidden`)
 *
 * A flag that has become THE behavior is no longer a choice we present, but it
 * is not yet safe to delete: support still needs one lever to put a single
 * project back on the old behavior while that project migrates.
 * `catalogHidden: true` is exactly that state — RESOLVABLE but UNADVERTISED:
 *
 *   • `resolveFeatureFlag` / `resolveFeatureFlags` — UNCHANGED. The platform
 *     default still applies and an explicit project override still wins.
 *   • `buildFeatureFlagCatalog` — OMITS the entry, so Settings → Feature flags
 *     does not list it and no UI presents it as a toggle.
 *   • `isFeatureFlagKey` — UNCHANGED, so `PATCH /projects/:id/features` keeps
 *     accepting the key. That is the support escape hatch, and it is the whole
 *     reason this is not `available: () => false` (which would force the flag
 *     OFF for every project — the opposite of what a hidden default means).
 *
 * A hidden flag is a DATED state, not a parking spot: hide it in the release
 * that makes it the default, delete it in the next one. The comment on the
 * entry names the release and the spec section that ends it.
 */
import { config } from '../config';
import { platinumUsRegion } from '../shared/platinum-region';
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
  /**
   * Omit this flag from the serialized catalog ({@link buildFeatureFlagCatalog})
   * so no UI lists it as a toggle. Resolution and `PATCH /projects/:id/features`
   * are untouched — see "Hidden flags" in this file's header. Set it only on a
   * flag whose value is now the product behavior, and delete the flag in the
   * next release.
   */
  catalogHidden?: true;
}

/**
 * The registry. Order here is the order shown in Settings → Feature flags.
 *
 * Computers need no flag: a paired machine is an account on the project's
 * `computer` connector. The platform-wide `TUNNEL_ENABLED` env is the only gate.
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
    key: 'connectors_api_discover',
    name: 'Connectors API Discover',
    description:
      'Browse direct API, MCP, GraphQL, CLI, and Postman surfaces without requiring a managed provider.',
    stability: 'beta',
    available: () => true,
    // The direct catalogue is available even when no managed provider is configured.
    // Explicit project overrides still provide a rollback path.
    platformDefault: () => true,
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
    // deliberate lever for deployments (e.g. SampleCo) that bring their own
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
      'Run 24/7 watchers from your repo that observe anything — logs, feeds, APIs — and fire trigger events into agent sessions. Runs on a persistent per-project monitor box. The contract is still experimental.',
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
    key: 'reminders',
    name: 'Reminders',
    description:
      'Let agents and people schedule check-ins on a session — "in 24 hours, check whether the vendor replied", once or on repeat. Each fire re-prompts that session. Adds the Reminders page, the session reminder chip, and `kortix remind` in the CLI.',
    stability: 'beta',
    available: () => true,
    // Per-project opt-in while the surface settles.
    platformDefault: () => false,
    // Routes 403 `feature_disabled`; the scheduler also skips reminder rows of
    // a project with the flag off (trigger-execution-store claimDueScheduleSlots).
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
      'No dedicated routes. The secret write paths (POST /secrets in ' +
      'projects/routes/secrets.ts, PUT /secrets/:id/strategy in ' +
      'projects/routes/secret-delivery.ts) reject a request that ' +
      'moves a secret INTO egress delivery when the flag is off. A secret that ' +
      'is already egress keeps serving and stays editable, so turning the flag ' +
      'off never strands an existing enforced secret.',
  },
  {
    key: 'pooled_provider_secrets',
    name: 'Pooled Provider Secrets',
    description: 'Members connect their own ChatGPT subscriptions and provider keys, share them when needed, and choose which ones each session uses.',
    stability: 'experimental',
    available: () => true,
    platformDefault: () => false,
    enforcement: 'behavioral',
    enforcementNote: 'Session selection and provider credential resolution reject or ignore resource secrets while disabled.',
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
    key: 'pi_harness',
    name: 'Pi Harness (in-sandbox)',
    description:
      'Run sessions on the pi agent harness inside the ordinary session sandbox instead of OpenCode (KORTIX_HARNESS=pi in kortixd). Same repo layout, same agents and skills, same wire to the UI; pi starts in-process in ~100 ms after the checkout. On ⇒ every new or restarted session of this project boots pi. Off ⇒ the manifest decides: `runtime: pi` still boots pi, anything else boots OpenCode. pi calls models only through the LLM gateway: with `llm_gateway` off, sessions boot OpenCode. Distinct from `pi_worker`, which is the split worker/environment topology.',
    stability: 'experimental',
    available: () => true,
    platformDefault: () => false,
    enforcement: 'behavioral',
    enforcementNote:
      'Read at session provisioning (projects/lib/sessions.ts buildSessionSandboxEnvVars → ' +
      'selectSessionHarness). A running session keeps its harness until it is restarted or resumed.',
  },
  {
    key: 'config_releases',
    name: 'Config Releases',
    description:
      "Sessions run the base branch's current config. Kortix loads the project's latest agent config from a read-only copy instead of the session's workspace checkout, so a merged agent, skill, or tool reaches every running session, on OpenCode and on pi. Off ⇒ the session reads its config from its workspace checkout, as it did before config releases.",
    stability: 'experimental',
    available: () => true,
    // OFF by default until this is proven on real projects (Marko, 2026-09-24:
    // "its off for now, as its untested"). The behaviour it gates is the
    // intended one; the default is a rollout decision, not a design opinion.
    // Turn it on per project in Settings, watch it, then widen. Flip this to
    // `true` when the rollout is done.
    platformDefault: () => false,
    enforcement: 'routes',
    enforcementNote:
      'Mixed, and both halves are enforced. ROUTES: the descriptor route ' +
      '(POST /projects/:id/sessions/:id/config-release) and the archive route ' +
      '(GET /projects/:id/config-archives/:tree) answer 403 `feature_disabled` ' +
      'when off — config-releases/routes.ts. BEHAVIORAL: convergeSessionConfig ' +
      'returns `disabled` without reaching the box (session-config-convergence.ts), ' +
      'reloadSessionConfig takes the pre-release legacy path (session-reload.ts), ' +
      'and GET /config omits the `release` block (routes/session-config.ts). Off ⇒ ' +
      'no release is built, no archive is stored, and no kortix.config_releases ' +
      'row is written.',
  },
  {
    key: 'agent_principal',
    name: 'Agents as Principals',
    description:
      'A governed agent session acts as the agent itself, not as the person who started it. Its authority is its kortix_permissions list, capped by the IAM role bound to the agent and never including member management, project deletion, or credential issue. Running an agent, firing its trigger, or starting it from another agent requires permission to run that agent.',
    stability: 'experimental',
    available: () => true,
    // Default ON. An agent's authority is a property of the AGENT, not of
    // whoever pressed start: the launcher-∩-grant model gave the same agent
    // different power per person, let an owner-launched agent ignore its own
    // grant entirely (super-admin short-circuit), and ran every unattended
    // trigger as the account owner. Switching a project OFF restores that old
    // model as an escape hatch for one release; the switch is then deleted.
    platformDefault: () => true,
    // Not listed in Settings → Feature flags. An agent acting as itself is how
    // Kortix works, not a choice we offer, so presenting a switch would invite
    // a project to turn the governance model off. Support can still put ONE
    // project back with `PATCH /projects/:id/features {agent_principal:false}`
    // while it migrates. Delete the flag — and this line — in the release after
    // the one that shipped the default (spec §5).
    catalogHidden: true,
    enforcement: 'behavioral',
    enforcementNote:
      'Read by the authorization engine for every agent-session credential ' +
      '(iam/agent-principal.ts agentPrincipalModeFor → iam/actor.ts actingPrincipal, ' +
      'iam/authorize.ts), the manual trigger fire and child-session run gates, and ' +
      'the change-request merge governance guard.',
  },
  {
    key: 'us_region',
    name: 'US Region',
    description:
      "Run this project's new sessions in Platinum's US East region instead of EU West. A running session keeps its region until it restarts. The first session after a new sandbox image waits while the image is copied to the region.",
    stability: 'experimental',
    // Two operator gates: Platinum must be the configured provider, and the
    // environment must name the region (KORTIX_PLATINUM_US_REGION), which is
    // also what says the Platinum org holds a grant for it. Unset ⇒ hidden.
    available: () => Boolean(config.PLATINUM_API_KEY) && platinumUsRegion() !== null,
    platformDefault: () => false,
    // Read at provisioning (platform/services/session-sandbox.ts
    // resolveSessionSandboxRegion) and sent as `region` on the Platinum
    // create. Off ⇒ no region is sent and Platinum places in its home region.
    enforcement: 'behavioral',
  },
  {
    key: 'human_messaging',
    name: 'Human Messaging',
    description:
      'Let agents message people and other sessions. `kortix send alice@example.com "…"` opens a conversation whose first message comes from the agent; it appears under "Asked you" in the recipient\'s sidebar. Several addresses open a group chat, and a message sent to another session says which session sent it.',
    stability: 'experimental',
    available: () => true,
    platformDefault: () => false,
    // POST /sessions refuses `participants` with 403 `feature_disabled`; the
    // prompt route adds the sender envelope only when this is on.
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
 * Build the per-project catalog the clients render. Self-contained so the UI
 * never hard-codes the flag list — add to FLAGS and it appears.
 *
 * `catalogHidden` entries are omitted: they still resolve and are still
 * writable through `PATCH /projects/:id/features`, they are simply not offered
 * as a toggle (see "Hidden flags" in this file's header).
 */
export function buildFeatureFlagCatalog(metadata: unknown): FeatureFlagView[] {
  return FLAGS.filter((f) => !f.catalogHidden).map((f) => ({
    key: f.key,
    name: f.name,
    description: f.description,
    stability: f.stability,
    available: f.available(),
    enabled: resolveFeatureFlag(metadata, f.key),
    overridden: explicitOverride(metadata, f.key) !== undefined,
  }));
}
