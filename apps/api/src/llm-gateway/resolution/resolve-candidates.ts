import {
  type AuthedPrincipal,
  GatewayResolutionError,
  type UpstreamDescriptor,
} from '@kortix/llm-gateway';
import { getCachedAccountTier } from '../../billing/services/entitlements';
import { accountIsFreeTierForModels } from '../../billing/services/tiers';
import { config } from '../../config';
import { getProjectSecretValue } from '../../projects/secrets';
import { CodexRefreshError, resolveCodexCredential } from '../credentials/codex';
import { capabilitiesForModel } from '../models/catalog-models';
import { getRuntimeManagedModel, isKnownManagedModelId } from '../models/managed-models';
import { resolveCatalogUpstream } from '../models/provider-registry';
import { resolveGatewayRoute } from '../routing';
import { bedrockByokBaseUrl, codexDescriptor, livePricing, managedCandidates } from './descriptors';

const PLATFORM_FEE_MARKUP = 0.1;

// Bedrock is the one native-transport BYOK provider whose credential is
// multi-field (see apps/web/src/lib/llm-providers.ts's env-vars-per-provider
// doc comment): AWS_BEARER_TOKEN_BEDROCK (fetched below via `byok.envVar`,
// same as every other BYOK provider) PLUS the project's own AWS_REGION, which
// no other BYOK provider needs — every other provider publishes a static
// baseUrl from resolveCatalogUpstream. AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY
// are collected by the dashboard's connect form too, but unused until the
// SigV4 signing path lands (see transports/bedrock/request.ts's
// TODO(bedrock-sigv4)); only the bearer token + region are read here today.
const BEDROCK_REGION_ENV_VAR = 'AWS_REGION';

// Tier resolution is the SHARED 30s-TTL cache in billing/services/entitlements
// (getCachedAccountTier) — this used to keep its own independent cache/Map
// here, so the BYOK fee-waiver decision below and the managed-model free-tier
// gate a few lines later could each see a different (stale-vs-fresh) tier for
// up to 30s after an upgrade/downgrade, resolved at different wall-clock
// instants. One cache, one invalidation point (entitlements.
// invalidateCachedAccountTier) removes that skew. `getCachedAccountTier`
// itself takes an injectable `now` (defaults to Date.now()) so the 30s TTL
// boundary stays unit-testable without a real wall-clock sleep — this is a
// thin re-export, not a second implementation.
export const resolveCachedAccountTier = getCachedAccountTier;

// A managed model to fall over to when a BYOK key hits a limit (429/402/403).
// Gated on the managed gateway being on + the managed provider being on (CLOUD-
// ONLY) + a configured, resolvable fallback model. getRuntimeManagedModel()/
// managedCandidates() are themselves empty when KORTIX_MANAGED_PROVIDER_ENABLED
// is off, so a self-host naturally has no managed fallback — the explicit check
// here is redundant belt-and-suspenders (never a silent fallback to Kortix's
// shared credentials), not load-bearing on its own.
function byokFallbackCandidates(): UpstreamDescriptor[] {
  if (!config.LLM_GATEWAY_ENABLED || !config.KORTIX_MANAGED_PROVIDER_ENABLED) return [];
  const fallbackId = config.LLM_GATEWAY_BYOK_FALLBACK_MODEL;
  if (!fallbackId) return [];
  const managed = getRuntimeManagedModel(fallbackId);
  return managed ? managedCandidates(managed) : [];
}

const PLAN_UPGRADE_SUGGESTION =
  'Upgrade your plan to use this model, or choose a model available on your current plan.';

/**
 * `resolveCandidates` throws a `GatewayResolutionError` (never returns an
 * empty array) whenever it can pin down WHY there's no upstream — the
 * generic-return-[] shape can't carry a reason, and handler.ts's dispatch
 * loop already treats a caught resolution error identically to an empty
 * result for control flow (see handler.ts's `resolveUpstream` try/catch), so
 * this is a non-breaking, additive change: it only adds information for the
 * final "no candidates at all" response to surface instead of the one-size-
 * fits-all "No upstream configured for model X".
 */
export async function resolveCandidates(
  principal: AuthedPrincipal,
  model: string,
): Promise<UpstreamDescriptor[]> {
  // The gateway normally applies the API-owned route plan before calling this hook.
  // Keep the same fallback here so a stale standalone gateway that asks the API
  // to resolve raw "auto" still gets a concrete upstream instead of 400ing — and
  // resolve it against the same account/agent default the control plane used.
  // Free-tier principals cannot use managed Kortix models, so stale AUTO below
  // resolves to no candidates rather than a paid/default upstream.
  const effectiveModel =
    model === 'auto' || model === 'kortix/auto'
      ? (
          await resolveGatewayRoute(principal, {
            requestedModel: model,
            requires: { imageInput: false },
          })
        ).primaryModel
      : model;
  const provider = effectiveModel.includes('/') ? effectiveModel.split('/')[0] : '';

  if (provider === 'codex') {
    if (!principal.projectId) {
      throw new GatewayResolutionError(
        'provider_not_connected',
        'Connect Codex to use this model.',
        'Connect your ChatGPT/Codex account in project settings, then retry.',
      );
    }
    let credential: Awaited<ReturnType<typeof resolveCodexCredential>>;
    try {
      credential = await resolveCodexCredential(principal.projectId, principal.userId);
    } catch (err) {
      if (err instanceof CodexRefreshError) {
        // Distinguishes "connected once, but the ChatGPT session expired or was
        // revoked" from "never connected" (below) — both used to collapse into
        // the same generic "No upstream configured" / "connect the provider"
        // message, which is actively misleading for a user who already connected.
        throw new GatewayResolutionError(
          'provider_reauth_required',
          'Your Codex session has expired or was revoked.',
          'Reconnect Codex in project settings, then retry.',
        );
      }
      throw err;
    }
    if (!credential) {
      throw new GatewayResolutionError(
        'provider_not_connected',
        'Connect Codex to use this model.',
        'Connect your ChatGPT/Codex account in project settings, then retry.',
      );
    }
    return [codexDescriptor(credential, effectiveModel)];
  }

  const byok = resolveCatalogUpstream(provider);
  // Set only when a BYOK-catalog provider is recognized but no usable key was
  // found — held until the managed-model fallthrough below has a chance to
  // resolve the SAME model id (rare but possible), so a real fallback candidate
  // still wins over surfacing this as the final failure.
  let byokFailure: GatewayResolutionError | null = null;

  if (byok && principal.projectId) {
    // Provider keys are always project-wide (shared) — there is no
    // per-user/private key concept. See getProjectSecretValue.
    const key = await getProjectSecretValue(principal.projectId, byok.envVar);
    if (key) {
      const tier = config.KORTIX_BILLING_INTERNAL_ENABLED
        ? await resolveCachedAccountTier(principal.accountId)
        : 'self-hosted';
      const isFreeTier = config.KORTIX_BILLING_INTERNAL_ENABLED && tier === 'free';
      const resolvedModelId = effectiveModel.slice(provider.length + 1);
      // Capability flags from the catalog (models.dev enrichment) so the
      // transport can decide which params a reasoning-restricted model
      // actually rejects, instead of hardcoding a model-id list.
      const capabilities = capabilitiesForModel(provider, resolvedModelId);
      // Bedrock has no static catalog baseUrl (see CatalogUpstream's doc
      // comment in provider-registry.ts) — its runtime endpoint is resolved
      // HERE, per-project, from the project's own AWS_REGION secret (falling
      // back to DEFAULT_BEDROCK_BYOK_REGION when unset), never from deployment
      // config. Every other BYOK provider already carries a static baseUrl on
      // `byok`, narrowed to `string` by the `byok.kind === 'bedrock'` check.
      const baseUrl =
        byok.kind === 'bedrock'
          ? bedrockByokBaseUrl(
              await getProjectSecretValue(principal.projectId, BEDROCK_REGION_ENV_VAR),
            )
          : byok.baseUrl;
      const byokDescriptor: UpstreamDescriptor = {
        provider,
        kind: byok.kind,
        baseUrl,
        apiKey: key,
        billingMode:
          config.KORTIX_BILLING_INTERNAL_ENABLED && !isFreeTier ? 'platform-fee' : 'none',
        markup: isFreeTier ? 0 : PLATFORM_FEE_MARKUP,
        resolvedModel: resolvedModelId,
        pricing: livePricing(resolvedModelId),
        reasoning: capabilities.reasoning,
        temperature: capabilities.temperature,
      };
      // Queue a managed model behind the BYOK key: if the user's key hits a
      // rate-limit / quota / billing error, the failover loop falls over to it
      // (billed as Kortix credits) so the turn doesn't die.
      return isFreeTier ? [byokDescriptor] : [byokDescriptor, ...byokFallbackCandidates()];
    }
    // No shared key configured for this project — provider keys are always
    // project-wide, so there's no other place to look.
    byokFailure = new GatewayResolutionError(
      'provider_not_connected',
      `No ${provider} API key is connected for this project.`,
      `Add a ${provider} API key in project settings, then retry.`,
    );
  }

  // The platform's MANAGED route (Bedrock or OpenRouter on KORTIX'S OWN shared
  // credentials — decided inside managedDescriptor by transport). CLOUD-ONLY:
  // getRuntimeManagedModel() only ever matches when KORTIX_MANAGED_PROVIDER_ENABLED
  // is on (RUNTIME_MANAGED_MODELS is empty otherwise — see managed-models.ts), so
  // a self-host never reaches this branch for an explicitly-named managed model;
  // it falls through to the checks below → a clear "model not available on this
  // deployment" error, never a silent fallback to Kortix credits. A BYOK catalog
  // model (bare `provider/model`) is handled above and requires the user's own
  // key; it never falls through here.
  const managed = getRuntimeManagedModel(effectiveModel);
  if (managed && config.LLM_GATEWAY_ENABLED && config.KORTIX_MANAGED_PROVIDER_ENABLED) {
    if (principal.freeModelsOnly) {
      throw new GatewayResolutionError(
        'plan_upgrade_required',
        `"${effectiveModel}" requires a paid plan.`,
        PLAN_UPGRADE_SUGGESTION,
      );
    }
    if (config.KORTIX_BILLING_INTERNAL_ENABLED) {
      const tier = await resolveCachedAccountTier(principal.accountId);
      if (accountIsFreeTierForModels(tier)) {
        throw new GatewayResolutionError(
          'plan_upgrade_required',
          `"${effectiveModel}" requires a paid plan.`,
          PLAN_UPGRADE_SUGGESTION,
        );
      }
    }
    const candidates = managedCandidates(managed);
    if (candidates.length) return candidates;
    // managed=true and every gate passed, but managedCandidates() itself found
    // no usable transport credential (an operator-side misconfiguration, e.g.
    // KORTIX_MANAGED_PROVIDER_ENABLED on without AWS_BEDROCK_API_KEY/
    // OPENROUTER_API_KEY set) — falls through to the deployment-disabled
    // message below, which is the closest accurate reason a caller can act on.
  }

  // A BYOK-recognized provider with no usable key wins over the generic
  // "model not found" — the model IS real, we just can't reach it right now.
  if (byokFailure) throw byokFailure;

  // The model id is a genuine managed-model id (checked against the BUNDLED
  // catalog, which — unlike RUNTIME_MANAGED_MODELS — is never gated by
  // KORTIX_MANAGED_PROVIDER_ENABLED) but didn't resolve above: either the
  // managed provider is off on this deployment, or it's misconfigured.
  if (isKnownManagedModelId(effectiveModel)) {
    throw new GatewayResolutionError(
      'model_disabled_on_deployment',
      `The "${effectiveModel}" model requires Kortix's managed provider, which is disabled on this deployment.`,
      'Connect your own API key for a BYOK-compatible model, or ask your deployment operator to enable the managed provider.',
    );
  }

  throw new GatewayResolutionError(
    'model_not_found',
    `"${effectiveModel}" is not a recognized model.`,
    'Check the model id, or choose a different model.',
  );
}
