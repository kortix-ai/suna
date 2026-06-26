import {
  type AuthedPrincipal,
  type UpstreamDescriptor,
  resolveCatalogUpstream,
} from '@kortix/llm-gateway';
import { getManagedModel, pickAutoModel } from '@kortix/shared/llm-catalog';
import { getAccountTier } from '../../billing/services/entitlements';
import { tierGrantsAllModels } from '../../billing/services/tiers';
import { config } from '../../config';
import { getProjectSecretValue } from '../../projects/secrets';
import { resolveCodexCredential } from '../credentials/codex';
import { codexDescriptor, livePricing, managedCandidates } from './descriptors';

const PLATFORM_FEE_MARKUP = 0.1;
const TIER_CACHE_TTL_MS = 30_000;

const accountTierCache = new Map<string, { tier: string; expiresAt: number }>();

async function resolveCachedAccountTier(accountId: string): Promise<string> {
  const cached = accountTierCache.get(accountId);
  if (cached && cached.expiresAt > Date.now()) return cached.tier;

  const tier = await getAccountTier(accountId);
  accountTierCache.set(accountId, { tier, expiresAt: Date.now() + TIER_CACHE_TTL_MS });
  return tier;
}

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
  // The gateway package normally applies pickAutoModel before calling this hook.
  // Keep the same fallback here so a stale standalone gateway that asks the API
  // to resolve raw "auto" still gets a concrete upstream instead of 400ing.
  const effectiveModel = pickAutoModel(model, {}) ?? model;
  const provider = effectiveModel.includes('/') ? effectiveModel.split('/')[0] : '';

  if (provider === 'codex') {
    if (!principal.projectId) return [];
    const credential = await resolveCodexCredential(principal.projectId, principal.userId);
    return credential ? [codexDescriptor(credential, effectiveModel)] : [];
  }

  const byok = resolveCatalogUpstream(provider);

  if (byok && principal.projectId) {
    const key = await getProjectSecretValue(principal.projectId, byok.envVar);
    if (key) {
      const tier = config.KORTIX_BILLING_INTERNAL_ENABLED
        ? await resolveCachedAccountTier(principal.accountId)
        : 'self-hosted';
      const isFreeTier = config.KORTIX_BILLING_INTERNAL_ENABLED && tier === 'free';
      const byokDescriptor: UpstreamDescriptor = {
        provider,
        kind: byok.kind,
        baseUrl: byok.baseUrl,
        apiKey: key,
        billingMode:
          config.KORTIX_BILLING_INTERNAL_ENABLED && !isFreeTier ? 'platform-fee' : 'none',
        markup: isFreeTier ? 0 : PLATFORM_FEE_MARKUP,
        resolvedModel: effectiveModel.slice(provider.length + 1),
        pricing: livePricing(effectiveModel.slice(provider.length + 1)),
      };
      // Queue a managed model behind the BYOK key: if the user's key hits a
      // rate-limit / quota / billing error, the failover loop falls over to it
      // (billed as Kortix credits) so the turn doesn't die.
      return isFreeTier ? [byokDescriptor] : [byokDescriptor, ...byokFallbackCandidates()];
    }
  }

  // The platform's MANAGED route, for the curated single-segment model set
  // (Bedrock on Kortix-cloud, OpenRouter on self-host — decided inside
  // managedDescriptor by which key is configured). A BYOK catalog model (bare
  // `provider/model`) is handled above and requires the user's own key; it never
  // falls through here. A non-managed, non-connected model yields no candidate →
  // clear "model not available" error.
  const managed = getManagedModel(effectiveModel);
  if (managed && config.LLM_GATEWAY_ENABLED) {
    if (config.KORTIX_BILLING_INTERNAL_ENABLED) {
      const tier = await resolveCachedAccountTier(principal.accountId);
      if (!managed.free && !tierGrantsAllModels(tier)) return [];
    }
    return managedCandidates(managed);
  }
  return [];
}
