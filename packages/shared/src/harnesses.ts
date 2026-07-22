/**
 * Canonical harness descriptor.
 *
 * See `packages/shared/README.md` for the full field guide, the harness
 * matrix, the founder auth decisions, and "how to add a harness".
 *
 * The single source of truth for harness identity, capability, and stability
 * across the platform. `manifest-schema`, `apps/api`, `apps/web`, and the
 * sandbox agent-server all derive their harness knowledge from this module —
 * do not redeclare the harness tuple, labels, config directories, adapter
 * package names, or auth-kind matrix anywhere else.
 *
 * `packages/sdk` mirrors this descriptor (it cannot depend on `@kortix/shared`
 * directly) and carries a drift-guard test asserting the mirror stays in sync.
 *
 * Dependency-free and node-free: no `node:` imports, no `process.env`. This
 * module must stay browser-safe and RN-safe, consumed by web and mobile.
 */

/** Ordered harness ids. Order is stable and meaningful for UI presentation. */
export const HARNESS_IDS = ['claude', 'codex', 'opencode', 'pi'] as const;

export type HarnessId = (typeof HARNESS_IDS)[number];

/**
 * How a harness is authenticated. Mirrors the API's `HarnessAuthKind`
 * (`apps/api/src/projects/lib/composer-capabilities.ts`) exactly — keep the
 * two unions in sync.
 */
export type HarnessAuthKind =
  | 'managed_gateway'
  | 'claude_subscription'
  | 'anthropic_api_key'
  | 'codex_subscription'
  | 'openai_api_key'
  | 'openai_compatible'
  | 'anthropic_compatible'
  | 'native_config';

export interface HarnessDescriptor {
  id: HarnessId;
  /** Display label, e.g. "Claude Code". */
  label: string;
  /** Harness-native config directory, relative to the project root. */
  configDir: string;
  /** npm package name for the harness's ACP adapter (or the harness itself). */
  adapterPkg: string;
  /**
   * Maturity signal only — does NOT gate selection/start (multi-harness
   * selection/start gating was removed 2026-07-22; every declared harness is
   * selectable regardless of this value). Its one remaining consumer is
   * `apps/api/src/projects/lib/harness-config-validate.ts`'s `severityFor()`,
   * which caps a native-config lint issue at `warning` (never `error`) for a
   * non-`stable` harness so a rougher-edged harness's config quirks never
   * hard-block a project.
   */
  stability: 'stable' | 'experimental';
  modelNamespacing: 'gateway-prefixed' | 'bare';
  /** Whether the harness supplies its own default model without an explicit launch override. */
  ownsDefaultModel: boolean;
  /** Whether the model can be changed live, mid-session. */
  liveModelChange: boolean;
  /** Auth kinds this harness is compatible with, in the founder decision matrix's order. */
  authKinds: HarnessAuthKind[];
  /** Subscription auth flow, if the harness supports one. */
  subscriptionAuth?: 'oauth-device' | 'oauth-token' | null;
}

/**
 * The canonical harness descriptor table. Keyed by `HarnessId`, one entry per
 * `HARNESS_IDS` member.
 */
export const HARNESSES: Record<HarnessId, HarnessDescriptor> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    configDir: '.claude',
    adapterPkg: '@agentclientprotocol/claude-agent-acp',
    stability: 'experimental',
    modelNamespacing: 'bare',
    ownsDefaultModel: true,
    liveModelChange: false,
    authKinds: ['claude_subscription', 'anthropic_api_key', 'native_config'],
    subscriptionAuth: 'oauth-token',
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    configDir: '.codex',
    adapterPkg: '@agentclientprotocol/codex-acp',
    stability: 'experimental',
    modelNamespacing: 'bare',
    ownsDefaultModel: true,
    liveModelChange: false,
    authKinds: ['codex_subscription', 'openai_api_key', 'native_config'],
    subscriptionAuth: 'oauth-device',
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    configDir: '.opencode',
    adapterPkg: 'opencode-ai',
    stability: 'stable',
    modelNamespacing: 'gateway-prefixed',
    ownsDefaultModel: false,
    liveModelChange: true,
    authKinds: [
      'managed_gateway',
      'anthropic_api_key',
      'openai_api_key',
      'openai_compatible',
      'native_config',
    ],
    subscriptionAuth: null,
  },
  pi: {
    id: 'pi',
    label: 'Pi',
    configDir: '.pi',
    adapterPkg: 'pi-acp',
    stability: 'experimental',
    modelNamespacing: 'bare',
    // 2026-07-21 model-resolution refactor decision (docs/specs/2026-07-21-
    // model-resolution-refactor-plan.md §6/§9): Pi is gateway/catalog-driven,
    // NOT harness-owned. This was `true` before today, contradicting Pi's
    // actual launch behavior (`harness-registry.ts`'s `id === 'pi'` branch
    // builds a full gateway-catalog-shaped config, the same shape as
    // OpenCode's — never a harness-native default the way Claude/Codex
    // genuinely work). Flipping this one authored fact is what makes Pi
    // resolve through the SAME credential-conditioned catalog path as
    // OpenCode (`llm-gateway/resolution/harness-models.ts`) instead of the
    // no-catalog `harness_default` shape. Known fallout (out of this
    // change's lane): `apps/cli/src/commands/agents.ts`'s
    // `ownsDefaultModelHarness` guard and its test
    // (`apps/cli/src/__tests__/agents-model.test.ts`) still assert the old
    // `true` value for 'pi' — that CLI copy/behavior is now stale and needs
    // its own fast-follow, tracked separately.
    ownsDefaultModel: false,
    liveModelChange: false,
    // 2026-07-22 Codex-subscription widening (docs/specs/2026-07-21-llm-
    // credential-and-model-management.md D1, verdict: SAFE for Codex only).
    // `codex_subscription` is added here — beyond its origin harness `codex` —
    // because Pi speaks OpenAI Responses natively (the same wire shape the
    // Codex subscription relay speaks) and the credential never reaches the
    // sandbox: the user's OAuth token is resolved + refreshed entirely
    // server-side and relayed through `/v1/router/codex-subscription`
    // (`billingMode:'none'`, fail-closed, no Kortix-key fallback), exactly as
    // it already is for the `codex` harness (`resolveAcpHarnessLaunchEnv`'s
    // `codex_subscription` branch). This is a pure `authKinds` edit — every
    // fan-out (the API's `compatibleHarnessesFor` projection, the web two-door
    // modal's `METHOD_COMPATIBLE_HARNESSES`, `/auth-providers`'
    // `compatibleHarnesses`, `composer-capabilities`' `CONNECTIONS`) derives
    // from this one table, so Pi now appears wherever Codex does for this
    // kind, automatically. `claude_subscription` stays pinned to `claude`
    // only: Anthropic's ToS forbids relaying that token and it is handed
    // verbatim to the harness process (`CREDENTIAL_CUSTODY.claude_subscription
    // === 'direct-only'`), so the same widening is NOT safe there.
    authKinds: [
      'managed_gateway',
      'anthropic_api_key',
      'codex_subscription',
      'openai_api_key',
      'openai_compatible',
      'native_config',
    ],
    subscriptionAuth: null,
  },
};

/**
 * The inverse of `HARNESSES[*].authKinds` — which harnesses accept a given
 * credential kind — computed once, from the one authored direction, never a
 * second hand-maintained table. Per docs/specs/2026-07-21-model-resolution-
 * refactor-plan.md §4.2: `composer-capabilities.ts`'s `CONNECTIONS` table
 * used to hand-author this same fact a second time (`compatible_harnesses`
 * per entry) — two arrays that must always agree are one authored fact
 * wearing two costumes. This function is the single source; every consumer
 * (the API's harness-connections listing, the resolution module, web/CLI/
 * mobile) reads it or the API's projection of it, never a parallel table.
 */
export function compatibleHarnessesFor(kind: HarnessAuthKind): HarnessId[] {
  return HARNESS_IDS.filter((id) => HARNESSES[id].authKinds.includes(kind));
}

/**
 * Whether a credential kind's raw material may ever be handed to a process
 * Kortix operates on the credential owner's behalf (relayed through a Kortix-
 * run endpoint — the gateway, a `/router/*` proxy), or must only ever be
 * given directly to the owner's own already-running harness process.
 *
 * Hardcoded, authored ONCE, per kind — never derived, never a per-project
 * override. `claude_subscription` is `direct-only` because Anthropic's own
 * written policy forbids a third party relaying a Free/Pro/Max-plan
 * credential on the user's behalf, regardless of which downstream process
 * ends up consuming it (docs/specs/2026-07-21-claude-subscription-parity.md
 * §2, primary-source policy page). `native_config` is `direct-only` by
 * definition — a committed config file, never a Kortix-held secret to relay
 * in the first place. Every other kind is `relay-eligible` (`codex_subscription`
 * specifically because the credential never leaves Kortix's server today by
 * construction — `harness-registry.ts` never forwards `CODEX_AUTH_JSON` to
 * the sandbox, verified safe by the parity doc).
 *
 * Enforcement lives in `llm-gateway/resolution/harness-models.ts`
 * (`assertRelayEligible`/`upstreamKindForCredential`), the one place allowed
 * to turn a resolved credential into an upstream shape — this table is data,
 * not the check itself.
 */
export type CredentialCustody = 'direct-only' | 'relay-eligible';

export const CREDENTIAL_CUSTODY: Record<HarnessAuthKind, CredentialCustody> = {
  managed_gateway: 'relay-eligible', // it IS the relay
  claude_subscription: 'direct-only',
  anthropic_api_key: 'relay-eligible',
  codex_subscription: 'relay-eligible',
  openai_api_key: 'relay-eligible',
  openai_compatible: 'relay-eligible',
  anthropic_compatible: 'relay-eligible',
  native_config: 'direct-only',
};
