import { type ProviderKind, providerKindForNpm } from '@kortix/llm-gateway';
import { runtimeModelCatalog } from './runtime-catalog';

const BASE_URL_FALLBACKS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  'x-ai': 'https://api.x.ai/v1',
  xai: 'https://api.x.ai/v1',
  mistral: 'https://api.mistral.ai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  perplexity: 'https://api.perplexity.ai',
  cerebras: 'https://api.cerebras.ai/v1',
  vercel: 'https://ai-gateway.vercel.sh/v1',
  v0: 'https://api.v0.dev/v1',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  togetherai: 'https://api.together.xyz/v1',
};

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';

// The project-secret name a BYOK Bedrock user connects their long-lived Bedrock
// API key under. Matches the AWS SDK's own env var (models.dev lists it in the
// amazon-bedrock provider's `env`), and the bedrock transport sends it as
// `Authorization: Bearer <key>`. Deliberately NOT the SigV4 access-key/secret
// pair (env[0]/env[1] on the catalog provider) — the bearer-token API key is
// the single-secret, self-generatable credential this path is built around.
const BEDROCK_BYOK_ENV_VAR = 'AWS_BEARER_TOKEN_BEDROCK';

// Bedrock has NO single static baseUrl to publish here: the runtime endpoint
// is region-scoped, and the region is the PROJECT's own AWS_REGION secret —
// never deployment/operator config (config.AWS_BEDROCK_REGION belongs
// exclusively to the CLOUD-ONLY managed/credits path; reading it here would
// silently route every BYOK Bedrock project through the OPERATOR's region
// regardless of which region a project's own bearer token was actually issued
// for, re-introducing the exact managed/BYOK conflation this feature exists to
// remove). So resolveCatalogUpstream — which has no project context — can't
// resolve a final baseUrl for Bedrock; it publishes the envVar/kind only, and
// resolveCandidates.ts (which DOES have `principal.projectId`) resolves the
// project's own AWS_REGION secret and builds the regional endpoint per-request.
// A discriminated union (rather than an optional `baseUrl` on one shape) lets
// every OTHER caller narrow `kind !== 'bedrock'` and use `baseUrl` as a plain
// `string` with no assertion.
// `npm` is the models.dev `npm` field (verbatim) — it selects the AI SDK
// provider package under the 'ai-sdk' transport engine; ignored by the native
// transports.
export type CatalogUpstream =
  | { kind: 'bedrock'; envVar: string; npm?: string }
  | { kind: Exclude<ProviderKind, 'bedrock'>; envVar: string; baseUrl: string; npm?: string };

/** Resolve provider transport metadata from the API-owned runtime catalog. */
export function resolveCatalogUpstream(providerId: string): CatalogUpstream | null {
  const provider = runtimeModelCatalog
    .snapshot()
    .providers.find((candidate) => candidate.id === providerId);
  if (!provider) return null;

  const kind = providerKindForNpm(provider.npm);
  if (!kind) return null;

  // Bedrock is a standalone BYOK provider (NOT the cloud-only managed/credits
  // path): a project connects its OWN Bedrock API key. models.dev carries no
  // `api` base for it (the real endpoint is region-derived, per-project — see
  // the CatalogUpstream doc comment above) and its `env[0]` is the SigV4
  // access-key id, not the bearer token the transport uses — so envVar is
  // resolved explicitly here rather than falling through to the generic
  // single-key path below.
  if (kind === 'bedrock') {
    return { envVar: BEDROCK_BYOK_ENV_VAR, kind, npm: provider.npm ?? undefined };
  }

  const baseUrl =
    kind === 'anthropic' ? ANTHROPIC_BASE_URL : provider.api || BASE_URL_FALLBACKS[providerId];
  const envVar = provider.env?.[0];
  if (!baseUrl || !envVar) return null;

  return { baseUrl, envVar, kind, npm: provider.npm ?? undefined };
}
