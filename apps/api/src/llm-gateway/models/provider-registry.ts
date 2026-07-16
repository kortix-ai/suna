import { type ProviderKind, providerKindForNpm } from '@kortix/llm-gateway';
import { config } from '../../config';
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

// The default AWS region for BYOK Bedrock when the deployment doesn't pin one.
// us-east-1 carries the broadest Claude availability + the `us.` cross-region
// inference profiles the served Bedrock model ids use.
const DEFAULT_BEDROCK_REGION = 'us-east-1';

// The project-secret name a BYOK Bedrock user connects their long-lived Bedrock
// API key under. Matches the AWS SDK's own env var (models.dev lists it in the
// amazon-bedrock provider's `env`), and the bedrock transport sends it as
// `Authorization: Bearer <key>`. Deliberately NOT the SigV4 access-key/secret
// pair (env[0]/env[1] on the catalog provider) — the bearer-token API key is
// the single-secret, self-generatable credential this path is built around.
const BEDROCK_BYOK_ENV_VAR = 'AWS_BEARER_TOKEN_BEDROCK';

function bedrockRuntimeBaseUrl(): string {
  const region = config.AWS_BEDROCK_REGION || DEFAULT_BEDROCK_REGION;
  return `https://bedrock-runtime.${region}.amazonaws.com`;
}

export interface CatalogUpstream {
  baseUrl: string;
  envVar: string;
  kind: ProviderKind;
}

/** Resolve provider transport metadata from the API-owned runtime catalog. */
export function resolveCatalogUpstream(providerId: string): CatalogUpstream | null {
  const provider = runtimeModelCatalog
    .snapshot()
    .providers.find((candidate) => candidate.id === providerId);
  if (!provider) return null;

  const kind = providerKindForNpm(provider.npm);
  if (!kind) return null;

  // Bedrock is a standalone BYOK provider (NOT the cloud-only managed/credits
  // path): a project connects its OWN Bedrock API key and calls the regional
  // runtime endpoint directly. models.dev carries no `api` base for it (it's
  // region-derived) and its `env[0]` is the SigV4 access-key id, not the bearer
  // token the transport uses — so resolve both explicitly here rather than
  // falling through to the generic single-key path below.
  if (kind === 'bedrock') {
    return { baseUrl: bedrockRuntimeBaseUrl(), envVar: BEDROCK_BYOK_ENV_VAR, kind };
  }

  const baseUrl =
    kind === 'anthropic' ? ANTHROPIC_BASE_URL : provider.api || BASE_URL_FALLBACKS[providerId];
  const envVar = provider.env?.[0];
  if (!baseUrl || !envVar) return null;

  return { baseUrl, envVar, kind };
}
