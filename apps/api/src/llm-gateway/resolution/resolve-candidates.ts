import {
  type AuthedPrincipal,
  type UpstreamDescriptor,
  resolveCatalogUpstream,
} from '@kortix/llm-gateway';
import { getManagedModel } from '@kortix/shared/llm-catalog';
import { config } from '../../config';
import { getProjectSecretValue } from '../../projects/secrets';
import { resolveCodexCredential } from '../credentials/codex';
import { codexDescriptor, livePricing, managedCandidates } from './descriptors';

const PLATFORM_FEE_MARKUP = 0.1;

// A managed model to fall over to when a BYOK key hits a limit (429/402/403).
// Gated on the managed gateway being on + a configured, resolvable fallback
// model. managedCandidates() is itself empty when no managed key is set, so a
// self-host with no Bedrock/OpenRouter key naturally has no fallback.
function byokFallbackCandidates(): UpstreamDescriptor[] {
  if (!config.LLM_GATEWAY_ENABLED) return [];
  const fallbackId = config.LLM_GATEWAY_BYOK_FALLBACK_MODEL;
  if (!fallbackId) return [];
  const managed = getManagedModel(fallbackId);
  return managed ? managedCandidates(managed) : [];
}

export async function resolveCandidates(
  principal: AuthedPrincipal,
  model: string,
): Promise<UpstreamDescriptor[]> {
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
      const byokDescriptor: UpstreamDescriptor = {
        provider,
        kind: byok.kind,
        baseUrl: byok.baseUrl,
        apiKey: key,
        billingMode: config.KORTIX_BILLING_INTERNAL_ENABLED ? 'platform-fee' : 'none',
        markup: PLATFORM_FEE_MARKUP,
        resolvedModel: model.slice(provider.length + 1),
        pricing: livePricing(model.slice(provider.length + 1)),
      };
      // Queue a managed model behind the BYOK key: if the user's key hits a
      // rate-limit / quota / billing error, the failover loop falls over to it
      // (billed as Kortix credits) so the turn doesn't die.
      return [byokDescriptor, ...byokFallbackCandidates()];
    }
  }

  // The platform's MANAGED route, for the curated single-segment model set
  // (Bedrock on Kortix-cloud, OpenRouter on self-host — decided inside
  // managedDescriptor by which key is configured). A BYOK catalog model (bare
  // `provider/model`) is handled above and requires the user's own key; it never
  // falls through here. A non-managed, non-connected model yields no candidate →
  // clear "model not available" error.
  const managed = getManagedModel(model);
  if (managed && config.LLM_GATEWAY_ENABLED) {
    return managedCandidates(managed);
  }
  return [];
}
