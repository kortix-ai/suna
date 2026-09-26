import { getProjectModelAccess } from '../../repositories/project-model-access';
import { projectFeatureFlagEnabled } from '../../feature-flags/for-project';
import {
  resolveDefaultCodexAccountSecret,
  resolveProjectSharedProviderSecrets,
  resolveSessionProviderSecrets,
} from '../../secrets/account-resource';
import { modelAccessAllows, modelAccessProvider } from '../model-access';
import { toWireModel } from './effective';
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
import { CodexRefreshError, resolveCodexAccountCredential, resolveCodexCredential } from '../credentials/codex';
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
import { isAwsRegion } from './aws-region';

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

function noManagedModelsError(model: string, tierIsPaid: boolean): GatewayResolutionError {
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
  options?: { providerSecretPools?: Record<string, string[]>; probe?: boolean },
): Promise<UpstreamDescriptor[]> {
  const effectiveModel = toWireModel(model);
  // Whose PERSONAL keys apply (spec 2026-09-22 §2.3): absent = the token user
  // (legacy); null = none (agent-principal session with no on-behalf-of human).
  const personalUserId = principal.personalUserId === undefined ? principal.userId : principal.personalUserId;
  const access = principal.projectId
    ? await getProjectModelAccess(principal.projectId)
    : { disabledProviders: [], disabledModels: [] };
  if (!modelAccessAllows(access, effectiveModel)) {
    const providerDisabled = access.disabledProviders.includes(modelAccessProvider(effectiveModel));
    throw new GatewayResolutionError(
      providerDisabled ? 'provider_disabled' : 'model_disabled',
      providerDisabled ? 'This provider is disabled for this project.' : 'This model is disabled for this project.',
      'Choose an enabled model, or ask a project manager to enable it in Models.',
    );
  }
  const provider = effectiveModel.includes('/') ? effectiveModel.split('/')[0] : '';
  const prospectiveIds = options?.providerSecretPools?.[provider];

  if (provider === 'codex') {
    if (!principal.projectId) {
      throw new GatewayResolutionError(
        'provider_not_connected',
        'Connect Codex to use this model.',
        'Connect your ChatGPT/Codex account in project settings, then retry.',
      );
    }
    const pooledEnabled = await projectFeatureFlagEnabled(principal.projectId, 'pooled_provider_secrets');
    const selectedPool = (prospectiveIds !== undefined || principal.sessionId) && principal.userId && pooledEnabled
      ? await resolveSessionProviderSecrets({
          accountId: principal.accountId, projectId: principal.projectId,
          ...(prospectiveIds !== undefined ? { secretIds: prospectiveIds } : { sessionId: principal.sessionId! }),
          ...(options?.probe ? { advanceIndex: false } : {}),
          userId: principal.userId, grantUserId: personalUserId, providerId: 'codex', name: 'CODEX_AUTH_JSON',
        })
      : null;
    const agentMayUseChatGptAccounts = !Array.isArray(principal.agentGrant?.env) ||
      principal.agentGrant.env.some((name) => name.toUpperCase() === 'CODEX_AUTH_JSON');
    const agentGrantRefusal = () => new GatewayResolutionError('provider_not_connected',
      'The running agent cannot use ChatGPT connections.',
      'Add CODEX_AUTH_JSON to the agent secret grant, or choose another agent.');
    if (selectedPool?.configured) {
      if (!agentMayUseChatGptAccounts) throw agentGrantRefusal();
      if (!selectedPool.secrets.length) {
        throw new GatewayResolutionError(
          selectedPool.coolingDown ? 'provider_pool_rate_limited' : 'provider_not_connected',
          selectedPool.coolingDown ? 'All selected ChatGPT connections are cooling down.' :
            'No usable ChatGPT connection is selected for this session.',
          'Select a granted ChatGPT connection in session settings.', selectedPool.retryAfterSeconds,
        );
      }
      const candidates = [];
      let expired = false;
      for (const secret of selectedPool.secrets) {
        try {
          const accountCredential = await resolveCodexAccountCredential({
            projectId: principal.projectId, accountId: principal.accountId,
            sessionId: principal.sessionId ?? null, userId: principal.userId,
            secretId: secret.secretId, value: secret.value,
          });
          if (!accountCredential) { expired = true; continue; }
          candidates.push({ ...codexDescriptor(accountCredential, effectiveModel),
            credentialRef: secret.secretId, poolSecretId: secret.secretId });
        } catch (err) {
          if (!(err instanceof CodexRefreshError)) throw err;
          expired = true;
        }
      }
      if (candidates.length) return candidates;
      throw new GatewayResolutionError(expired ? 'provider_reauth_required' : 'provider_not_connected',
        expired ? 'The selected ChatGPT connections need reconnection.' : 'No ChatGPT connection is available.',
        'Reconnect a selected ChatGPT account or select another granted connection.');
    }
    if (pooledEnabled && personalUserId && !principal.keyId) {
      const personal = await resolveDefaultCodexAccountSecret(principal.accountId, principal.projectId, personalUserId);
      if (personal) {
        if (!agentMayUseChatGptAccounts) throw agentGrantRefusal();
        try {
          const credential = await resolveCodexAccountCredential({
            projectId: principal.projectId, accountId: principal.accountId,
            sessionId: principal.sessionId ?? null, userId: principal.userId,
            secretId: personal.secretId, value: personal.value,
          });
          if (credential) return [{ ...codexDescriptor(credential, effectiveModel), credentialRef: personal.secretId }];
        } catch (err) {
          if (!(err instanceof CodexRefreshError)) throw err;
        }
        throw new GatewayResolutionError('provider_reauth_required',
          'Your ChatGPT connection needs reconnection.',
          'Reconnect your ChatGPT account in Models, then retry.');
      }
    }
    // No explicit pool and no personal account: the ChatGPT accounts shared
    // with this project that the principal may use — the same accounts the
    // model picker lists for it. Unattended sessions (Slack, cron triggers,
    // agent-started workers) never have a pool row, and a member who did not
    // create a shared account never has a personal one; without this step both
    // fell straight to the legacy project connection. A project gateway API
    // key (`keyId`) carries no member, so it gets only the accounts shared
    // with the whole project (`grantUserId: null`): never its creator's
    // personal connection or a member-restricted account.
    let sharedFailure: GatewayResolutionError | null = null;
    if (pooledEnabled) {
      const shared = await resolveProjectSharedProviderSecrets({
        accountId: principal.accountId, projectId: principal.projectId,
        userId: principal.userId, grantUserId: principal.keyId ? null : personalUserId,
        providerId: 'codex', name: 'CODEX_AUTH_JSON',
      });
      if ((shared.secrets.length || shared.coolingDown) && !agentMayUseChatGptAccounts) {
        // Before this fallback existed such an agent reached only the legacy
        // connection; it still may, but never a shared account.
        sharedFailure = agentGrantRefusal();
      } else if (shared.secrets.length) {
        const candidates = [];
        for (const secret of shared.secrets) {
          try {
            const accountCredential = await resolveCodexAccountCredential({
              projectId: principal.projectId, accountId: principal.accountId,
              sessionId: principal.sessionId ?? null, userId: principal.userId,
              secretId: secret.secretId, value: secret.value,
            });
            if (!accountCredential) continue;
            // `poolSecretId`: a 429 on one shared account records its cooldown
            // and moves the request to the next, exactly as in a selected pool.
            candidates.push({ ...codexDescriptor(accountCredential, effectiveModel),
              credentialRef: secret.secretId, poolSecretId: secret.secretId });
          } catch (err) {
            if (!(err instanceof CodexRefreshError)) throw err;
          }
        }
        if (candidates.length) return candidates;
        sharedFailure = new GatewayResolutionError('provider_reauth_required',
          'The ChatGPT connections shared with this project need reconnection.',
          'Reconnect a shared ChatGPT account in Models, then retry.');
      } else if (shared.coolingDown) {
        sharedFailure = new GatewayResolutionError('provider_pool_rate_limited',
          'All ChatGPT connections shared with this project are cooling down.',
          'Retry after the cooldown, or connect another ChatGPT account.', shared.retryAfterSeconds);
      }
    }
    let credential: Awaited<ReturnType<typeof resolveCodexCredential>>;
    try {
      credential = await resolveCodexCredential(principal.projectId, principal.userId, undefined, {
        accountId: principal.accountId,
        sessionId: principal.sessionId,
        principalUserId: personalUserId,
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
      if (sharedFailure) throw sharedFailure;
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
    const readGatewaySecret = (name: string) =>
      getProjectSecretValueForConsumer({
        projectId: principal.projectId!,
        accountId: principal.accountId,
        sessionId: principal.sessionId,
        actorUserId: principal.userId,
        name,
        consumer: 'llm_gateway',
      });
    const selectedPool = (prospectiveIds !== undefined || principal.sessionId) && principal.userId &&
      await projectFeatureFlagEnabled(principal.projectId, 'pooled_provider_secrets')
      ? await resolveSessionProviderSecrets({
          accountId: principal.accountId,
          projectId: principal.projectId,
          ...(prospectiveIds !== undefined ? { secretIds: prospectiveIds } : { sessionId: principal.sessionId! }),
          ...(options?.probe ? { advanceIndex: false } : {}),
          userId: principal.userId,
          grantUserId: personalUserId,
          providerId: provider,
          name: byok.envVar,
        })
      : null;
    if (selectedPool?.configured && Array.isArray(principal.agentGrant?.env) &&
      !principal.agentGrant.env.some((identifier) => identifier.toUpperCase() === byok.envVar.toUpperCase())) {
      throw new GatewayResolutionError('provider_not_connected',
        `The running agent cannot use ${provider} keys.`,
        `Add ${byok.envVar} to the agent's secret grant, or choose another agent.`);
    }
    const keys = selectedPool?.configured
      ? selectedPool.secrets.map((secret) => ({ identifier: secret.secretId, value: secret.value }))
      : await resolveProjectSecretsForConsumer({
          projectId: principal.projectId,
          accountId: principal.accountId,
          sessionId: principal.sessionId,
          actorUserId: principal.userId,
          name: byok.envVar,
          consumer: 'llm_gateway',
        });
    if (selectedPool?.configured && keys.length === 0) {
      throw new GatewayResolutionError(
        selectedPool.coolingDown ? 'provider_pool_rate_limited' : 'provider_not_connected',
        selectedPool.coolingDown
          ? `All selected ${provider} keys are cooling down after rate limits.`
          : `No usable ${provider} key is selected for this session.`,
        selectedPool.coolingDown
          ? 'Retry after the provider cooldown, or select another granted key.'
          : 'Select a granted key in session settings.',
        selectedPool.retryAfterSeconds,
      );
    }
    if (keys.length > 0) {
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
        byok.kind === 'bedrock'
          ? (await readGatewaySecret(BEDROCK_REGION_ENV_VAR))?.trim() || undefined
          : undefined;
      if (bedrockRegion && !isAwsRegion(bedrockRegion)) {
        throw new GatewayResolutionError(
          'provider_not_connected',
          `The project's AWS_REGION secret is not an AWS region name.`,
          'Set AWS_REGION to a region such as us-east-1, or remove it to use us-east-1.',
        );
      }
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
        ...(selectedPool?.configured ? { poolSecretId: identifier } : {}),
        // BYOK bills the provider account directly. Kortix records provider
        // spend for observability but never debits Kortix credits.
        billingMode: 'none',
        markup: 0,
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
      // Never append a Kortix-managed fallback. A failed BYOK key must fail as
      // BYOK; it must not silently convert the request into a Kortix charge.
      return byokDescriptors;
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
    if (access.disabledProviders.includes('kortix')) {
      throw new GatewayResolutionError('provider_disabled', 'Kortix Managed Models are disabled for this project.',
        'Choose a model from an enabled provider, or enable Kortix Managed Models in Models.');
    }
    if (principal.freeModelsOnly) {
      throw new GatewayResolutionError(
        'plan_upgrade_required',
        `"${effectiveModel}" requires a paid plan.`,
        PLAN_UPGRADE_SUGGESTION,
      );
    }
    if (config.KORTIX_BILLING_INTERNAL_ENABLED) {
      // Both reads go through the one billing cache in entitlements (30s TTL,
      // one invalidation point), so the entitlement and the tier that picks
      // the refusal copy cannot disagree. The trial overlay and the operator
      // `managed_models_override` apply inside `accountMayUseManagedModels`.
      if (!(await accountMayUseManagedModels(principal.accountId))) {
        // A v3 credit plan lands here too — it pays, it just doesn't bundle
        // managed inference. Telling that customer to "upgrade" is wrong.
        const tier = await getCachedAccountTier(principal.accountId);
        throw noManagedModelsError(effectiveModel, isPaidTier(tier ?? 'free'));
      }
    }
    const candidates = managedCandidates(managed);
    if (candidates.length) return candidates;
    // managed=true and every gate passed, but managedCandidates() itself found
    // no usable transport credential (an operator-side misconfiguration, e.g.
    // KORTIX_MANAGED_PROVIDER_ENABLED on without OPENROUTER_API_KEY set) — falls through to the deployment-disabled
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
