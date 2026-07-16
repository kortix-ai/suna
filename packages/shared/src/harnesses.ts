/**
 * Canonical harness descriptor.
 *
 * See `packages/shared/README.md` for the full field guide, the harness
 * matrix, the founder auth decisions, the experimental gating rules, and
 * "how to add a harness".
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
    configDir: '.kortix/opencode',
    adapterPkg: 'opencode-ai',
    stability: 'stable',
    modelNamespacing: 'gateway-prefixed',
    ownsDefaultModel: false,
    liveModelChange: true,
    authKinds: ['managed_gateway', 'anthropic_api_key', 'openai_api_key', 'openai_compatible', 'native_config'],
    subscriptionAuth: null,
  },
  pi: {
    id: 'pi',
    label: 'Pi',
    configDir: '.pi',
    adapterPkg: 'pi-acp',
    stability: 'experimental',
    modelNamespacing: 'bare',
    ownsDefaultModel: true,
    liveModelChange: false,
    authKinds: ['managed_gateway', 'anthropic_api_key', 'openai_api_key', 'openai_compatible', 'native_config'],
    subscriptionAuth: null,
  },
};

/** Harness ids matching the given stability tier, in `HARNESS_IDS` order. */
export function harnessesByStability(stability: 'stable' | 'experimental'): HarnessId[] {
  return HARNESS_IDS.filter((id) => HARNESSES[id].stability === stability);
}
