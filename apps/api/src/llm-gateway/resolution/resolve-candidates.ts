import {
  type AuthedPrincipal,
  GatewayResolutionError,
  type UpstreamDescriptor,
} from '@kortix/llm-gateway';
import { accountMayUseManagedModels, getCachedAccountTier } from '../../billing/services/entitlements';
import { isPaidTier } from '../../billing/services/tiers';
import { config } from '../../config';
import {
  getProjectSecretValueForConsumer,
  resolveProjectSecretsForConsumer,
} from '../../projects/secrets';
import { CodexRefreshError, resolveCodexCredential } from '../credentials/codex';
import { capabilitiesForModel } from '../models/catalog-models';
import { getRuntimeManagedModel, isKnownManagedModelId } from '../models/managed-models';
import { resolveCatalogUpstream } from '../models/provider-registry';
import {
  bedrockByokBaseUrl,
  codexDescriptor,
  livePricing,
  managedCandidates,
  normalizeBedrockInferenceProfileRegion,
  stripBedrockInferenceProfilePrefix,
} from './descriptors';

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

// Managed-models entitlement, same shared snapshot cache. Trial overlay and
// the operator `managed_models_override` are applied inside — never derive
// this from a tier string here (that is exactly the conflation the comment
// below warns about).
export const resolveCachedManagedModels = accountMayUseManagedModels;

// A managed model to fall over to when a BYOK key hits a limit (429/402/403).
// Gated on the managed gateway being on + the managed provider being on (CLOUD-
// ONLY) + a configured, resolvable fallback model. getRuntimeManagedModel()/
// managedCandidates() are themselves empty when KORTIX_MANAGED_PROVIDER_ENABLED
// is off, so a self-host naturally has no managed fallback — the explicit check
// here is redundant belt-and-suspenders (never a silent fallback to dosco's
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
 * The same block, for a plan that is PAID but simply does not include managed
 * inference — every v3 credit plan (Starter / Team / Scale).
 *
 * "requires a paid plan" is false and actively misleading there: the customer
 * is paying. Managed models are not something their plan is too small for, they
 * are deliberately not bundled, and the remedy is a key rather than an upgrade.
 */
const BRING_YOUR_OWN_KEY_SUGGESTION =
  'This plan does not include managed models. Add your own provider key to use ' +
  'this model, or pick a model your key covers.';

export function noManagedModelsError(model: string, tierIsPaid: boolean): GatewayResolutionError {
  return tierIsPaid
    ? new GatewayResolutionError(
        'plan_upgrade_required',
        `"${model}" needs your own provider key on this plan.`,
        BRING_YOUR_OWN_KEY_SUGGESTION,
      )
    : new GatewayResolutionError(
        'plan_upgrade_required',
        `"${model}" requires a paid plan.`,
        PLAN_UPGRADE_SUGGESTION,
      );
}

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
  const effectiveModel = model;
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
      credential = await resolveCodexCredential(principal.projectId, principal.userId, undefined, {
        accountId: principal.accountId,
        sessionId: principal.sessionId,
      });
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
    const readGatewaySecret = (name: string) =>
      getProjectSecretValueForConsumer({
        projectId: principal.projectId!,
        accountId: principal.accountId,
        sessionId: principal.sessionId,
        actorUserId: principal.userId,
        name,
        consumer: 'llm_gateway',
      });
    const keys = await resolveProjectSecretsForConsumer({
      projectId: principal.projectId,
      accountId: principal.accountId,
      sessionId: principal.sessionId,
      actorUserId: principal.userId,
      name: byok.envVar,
      consumer: 'llm_gateway',
    });
    if (keys.length > 0) {
      const tier = config.KORTIX_BILLING_INTERNAL_ENABLED
        ? await resolveCachedAccountTier(principal.accountId)
        : 'self-hosted';
      // TWO DIFFERENT QUESTIONS. Conflating them is what let a credit plan reach
      // managed inference through the back door.
      //
      // 1. Does this account pay the BYOK platform fee? Free accounts do not;
      //    every paid account does, including the v3 credit plans.
      //    `tier` here is the RESOLVED plan key (getCachedAccountTier reads the
      //    shared billing resolver: trial overlay and per-seat self-heal
      //    applied), so a trial of a paid plan pays the fee for the trial
      //    window and a stale-tier per-seat team is not waived by accident.
      //    Deliberately plan-KEY equality with 'free', not "free family": an
      //    unprovisioned account (`none`) has always paid this fee, and
      //    widening the waiver to it is a pricing decision, not a refactor.
      const isFreeTier = config.KORTIX_BILLING_INTERNAL_ENABLED && tier === 'free';
      // 2. May this account use MANAGED inference at all? `models: []` says no
      //    for Starter/Team/Scale even though they are paid, so this cannot be a
      //    `tier === 'free'` check — it has to be the same entitlement predicate
      //    the direct managed path uses (trial + operator override included).
      //    Billing disabled (self-hosted) keeps the fallback, as before.
      const mayUseManagedModels = await resolveCachedManagedModels(principal.accountId);
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
      // Bedrock's project-scoped region also feeds the AI-SDK engine's Bedrock
      // provider (descriptor.region); resolve it once for both baseUrl + region.
      const bedrockRegion =
        byok.kind === 'bedrock' ? await readGatewaySecret(BEDROCK_REGION_ENV_VAR) : undefined;
      const baseUrl = byok.kind === 'bedrock' ? bedrockByokBaseUrl(bedrockRegion) : byok.baseUrl;
      // Bedrock invoke id: normalize a wrong-geography cross-region
      // inference-profile prefix (e.g. a `jp.` pick that got stored as an
      // account default / session pin on a us-east-1 box) to the endpoint's own
      // region, so it stops 400ing "The provided model identifier is invalid."
      // No-op for every other provider and for already-correct ids.
      const invokeModelId =
        byok.kind === 'bedrock'
          ? normalizeBedrockInferenceProfileRegion(resolvedModelId, bedrockRegion)
          : resolvedModelId;
      const byokDescriptors: UpstreamDescriptor[] = keys.map(({ identifier, value }) => ({
        provider,
        kind: byok.kind,
        npm: byok.npm,
        baseUrl,
        ...(bedrockRegion ? { region: bedrockRegion } : {}),
        apiKey: value,
        credentialRef: identifier,
        billingMode:
          config.KORTIX_BILLING_INTERNAL_ENABLED && !isFreeTier ? 'platform-fee' : 'none',
        markup: isFreeTier ? 0 : PLATFORM_FEE_MARKUP,
        resolvedModel: invokeModelId,
        // Bedrock-only: the id used to INVOKE stays the full cross-region
        // inference-profile id (resolvedModel above, region-normalized) — only
        // the id used to LOOK UP pricing gets the geography prefix stripped,
        // since the models.dev catalog only knows the base model id. See
        // stripBedrockInferenceProfilePrefix's doc comment.
        pricing: livePricing(
          provider,
          byok.kind === 'bedrock'
            ? stripBedrockInferenceProfilePrefix(invokeModelId)
            : invokeModelId,
        ),
        reasoning: capabilities.reasoning,
        temperature: capabilities.temperature,
      }));
      // Queue a managed model behind the BYOK key: if the user's key hits a
      // rate-limit / quota / billing error, the failover loop falls over to it
      // (billed as dosco credits) so the turn doesn't die.
      //
      // Only for accounts entitled to managed models. Otherwise a plan that
      // includes no inference could reach it by having its own key rate-limit —
      // serving managed tokens the plan forbids, and skipping the wallet
      // admission gate on the way, since that gate is bypassed for exactly the
      // tiers this fallback would be serving.
      return mayUseManagedModels
        ? [...byokDescriptors, ...byokFallbackCandidates()]
        : byokDescriptors;
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
  // deployment" error, never a silent fallback to dosco credits. A BYOK catalog
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
      if (!(await resolveCachedManagedModels(principal.accountId))) {
        // A v3 credit plan lands here too — it pays, it just doesn't bundle
        // managed inference. Telling that customer to "upgrade" is wrong.
        const tier = await resolveCachedAccountTier(principal.accountId);
        throw noManagedModelsError(effectiveModel, isPaidTier(tier ?? 'free'));
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
      `The "${effectiveModel}" model requires dosco's managed provider, which is disabled on this deployment.`,
      'Connect your own API key for a BYOK-compatible model, or ask your deployment operator to enable the managed provider.',
    );
  }

  throw new GatewayResolutionError(
    'model_not_found',
    `"${effectiveModel}" is not a recognized model.`,
    'Check the model id, or choose a different model.',
  );
}
