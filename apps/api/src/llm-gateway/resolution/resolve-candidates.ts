import { resolveCatalogUpstream, type AuthedPrincipal, type UpstreamDescriptor } from '@kortix/llm-gateway';
import { config } from '../../config';
import { getProjectSecretValue } from '../../projects/secrets';
import { resolveCodexCredential } from '../credentials/codex';
import { codexDescriptor, managedDescriptor } from './descriptors';

const PLATFORM_FEE_MARKUP = 0.1;

export async function resolveCandidates(principal: AuthedPrincipal, model: string): Promise<UpstreamDescriptor[]> {
  const provider = model.includes('/') ? model.split('/')[0] : '';

  if (provider === 'codex') {
    if (!principal.projectId) return [];
    const credential = await resolveCodexCredential(principal.projectId, principal.userId);
    return credential ? [codexDescriptor(credential, model)] : [];
  }

  const byok = resolveCatalogUpstream(provider);

  if (byok && principal.projectId) {
    const key = await getProjectSecretValue(principal.projectId, byok.envVar);
    if (key) {
      return [
        {
          provider,
          kind: 'openai-compat',
          baseUrl: byok.baseUrl,
          apiKey: key,
          billingMode: config.KORTIX_BILLING_INTERNAL_ENABLED ? 'platform-fee' : 'none',
          markup: PLATFORM_FEE_MARKUP,
          resolvedModel: model.slice(provider.length + 1),
        },
      ];
    }
  }

  if (config.LLM_GATEWAY_ENABLED && config.OPENROUTER_API_KEY) {
    return [managedDescriptor(model)];
  }
  return [];
}
