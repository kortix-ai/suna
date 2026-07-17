/**
 * Kortix-owned provider auth requirements.
 *
 * *** THE PROBLEM THIS FIXES ***
 * `CatalogProvider.env` (models.dev's `env` field, in catalog.generated.json)
 * lists EVERY env var the upstream's OFFICIAL SDK recognizes across ALL of
 * that SDK's supported auth methods — not what KORTIX's own gateway
 * transport actually reads. Most providers have exactly one implemented auth
 * method, so `env` happens to be the right requirement as-is. A few don't:
 *
 *   - `amazon-bedrock`: models.dev lists BOTH the SigV4 access-key pair
 *     (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY) AND the bearer-token var
 *     (AWS_BEARER_TOKEN_BEDROCK) plus AWS_REGION — because the AWS SDK
 *     supports both. Kortix's bedrock transport
 *     (packages/llm-gateway/src/transports/bedrock/request.ts) authenticates
 *     ONLY with the bearer token; the BYOK resolver
 *     (apps/api/src/llm-gateway/resolution/resolve-candidates.ts +
 *     models/provider-registry.ts) reads ONLY AWS_BEARER_TOKEN_BEDROCK +
 *     AWS_REGION. SigV4 signing is unimplemented (explicit
 *     TODO(bedrock-sigv4) in request.ts). Treating all 4 vars as one AND-of-
 *     everything requirement made a fully-working Bedrock connection show as
 *     "not connected" and made the connect form demand 2 dead fields.
 *
 *   - `google`: models.dev lists three ALIASES for the same single credential
 *     (GOOGLE_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY / GEMINI_API_KEY — all
 *     three are recognized interchangeably by @ai-sdk/google). Requiring all
 *     three together (the old AND-of-`env` behavior) made Google
 *     unconnectable through the modal — nobody sets three key aliases to the
 *     same value. Any ONE of them is sufficient.
 *
 * Providers NOT listed in the override map below have exactly one
 * implemented method, taken straight from the catalog's `env` — this map
 * only holds CORRECTIONS, so it stays small, and every entry must cite the
 * transport code that justifies it (grep-able so it doesn't silently rot).
 *
 * *** THE MODEL ***
 * A provider's real requirement is one or more independent auth METHODS
 * (`ProviderAuthRequirement.methods`); a provider is "connected" when ANY
 * method's env vars are ALL present (`isProviderAuthSatisfied`). This is
 * deliberately more general than a flat env-var list so a provider can gain
 * a second method later (e.g. Bedrock SigV4) without breaking existing
 * connections on the first one — see the amazon-bedrock entry's comment.
 *
 * *** WHO USES THIS ***
 * The single source of truth for BOTH "what fields does the connect form
 * ask for" (always `methods[0]`, via `primaryAuthEnvVars`) and "is this
 * provider connected" (`isProviderAuthSatisfied` over the FULL requirement)
 * — in the web provider modal (apps/web/src/lib/llm-providers.ts,
 * apps/web/src/hooks/opencode/provider-selection.ts), the SDK's native-mode
 * provider merge (packages/sdk/src/react/provider-selection.ts), and the CLI
 * (apps/cli/src/commands/providers.ts). All three derive from this module so
 * they can't drift from each other or from what the gateway/transports
 * actually read.
 *
 * *** AUDIT (2026-07-17) ***
 * Checked every catalog provider with more than one `env` var against
 * `packages/llm-gateway/src/catalog/compatibility.ts` (providerKindForNpm)
 * and `apps/api/src/llm-gateway/resolution/*`. Besides bedrock/google above:
 * azure, azure-cognitive-services, cloudflare-ai-gateway,
 * cloudflare-workers-ai, databricks, google-vertex,
 * google-vertex-anthropic, neon, privatemode-ai, and snowflake-cortex all
 * list multiple env vars that are genuinely DIFFERENT-PURPOSE fields of one
 * method (e.g. Vertex's project + location + credentials path) — real AND
 * requirements, not alias/extra-method lists — and none of them has a
 * gateway BYOK transport at all yet (providerKindForNpm returns null), so
 * they're only ever used in native mode, where every listed var is read
 * directly by the upstream SDK. No mismatch there; no override needed.
 */

export interface ProviderAuthMethod {
  /** Optional label, surfaced only if a provider ever exposes >1 method in the UI (none do today — the connect form always uses methods[0]). */
  label?: string;
  /** Every one of these project-secret env vars must be set for this method to count as satisfied. */
  envVars: string[];
}

export interface ProviderAuthRequirement {
  /**
   * One or more independent ways to authenticate. A provider is CONNECTED if
   * ANY method's envVars are all present — see `isProviderAuthSatisfied`.
   */
  methods: ProviderAuthMethod[];
}

interface CatalogProviderLike {
  id: string;
  env?: string[];
}

const PROVIDER_AUTH_REQUIREMENT_OVERRIDES: Record<string, ProviderAuthRequirement> = {
  'amazon-bedrock': {
    methods: [
      {
        label: 'Bearer token',
        // See the module doc comment above for the full trail. When SigV4
        // signing lands, ADD a second method here (e.g. `{ label: 'IAM
        // access key', envVars: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
        // 'AWS_REGION'] }`) — do not replace this one; existing bearer-token
        // connections must keep working.
        envVars: ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION'],
      },
    ],
  },
  google: {
    methods: [
      // GOOGLE_GENERATIVE_AI_API_KEY first: the name @ai-sdk/google's own
      // docs lead with, and what Kortix's CLI/UI have always written when
      // connecting Google — kept as the connect form's primary field.
      { envVars: ['GOOGLE_GENERATIVE_AI_API_KEY'] },
      { envVars: ['GOOGLE_API_KEY'] },
      { envVars: ['GEMINI_API_KEY'] },
    ],
  },
};

/**
 * The auth requirement Kortix actually enforces for a catalog provider.
 * Falls back to a single method requiring every var in `provider.env`
 * (unchanged behavior) unless an override above corrects it.
 */
export function providerAuthRequirement(provider: CatalogProviderLike): ProviderAuthRequirement {
  const override = PROVIDER_AUTH_REQUIREMENT_OVERRIDES[provider.id];
  if (override) return override;
  const env = provider.env ?? [];
  return { methods: env.length > 0 ? [{ envVars: env }] : [] };
}

/**
 * The env vars the connect form should collect for a provider — always the
 * first (primary) auth method. Every provider has exactly one usable method
 * today; this is the field list `ApiKeyConnectForm` renders and writes.
 */
export function primaryAuthEnvVars(provider: CatalogProviderLike): string[] {
  return providerAuthRequirement(provider).methods[0]?.envVars ?? [];
}

/**
 * True when at least one of the requirement's auth methods has every one of
 * its env vars present, per `hasEnvVar`. ANY-OF-methods, ALL-OF-vars-within-
 * a-method — the one predicate every "is this provider connected" check
 * (web connect modal, model-selector gating, native-mode provider merge, CLI
 * `providers ls`) should use instead of hand-rolling `envVars.every(...)`
 * over the raw catalog list.
 */
export function isProviderAuthSatisfied(
  requirement: ProviderAuthRequirement,
  hasEnvVar: (envVar: string) => boolean,
): boolean {
  return requirement.methods.some(
    (method) => method.envVars.length > 0 && method.envVars.every(hasEnvVar),
  );
}
