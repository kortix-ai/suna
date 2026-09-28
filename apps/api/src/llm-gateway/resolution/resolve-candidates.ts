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

type ResolutionOptions = { providerSecretPools?: Record<string, string[]>; probe?: boolean };
type Context = { principal: AuthedPrincipal; effectiveModel: string; personalUserId: string | null; options?: ResolutionOptions };

async function selectedPool(context: Context, providerId: string, name: string, enabled?: boolean) {
  const { principal, options, personalUserId } = context;
  if (!principal.projectId) return null;
  const prospectiveIds = options?.providerSecretPools?.[providerId];
  if ((prospectiveIds === undefined && !principal.sessionId) || !principal.userId ||
    !(enabled ?? await projectFeatureFlagEnabled(principal.projectId, 'pooled_provider_secrets'))) return null;
  return resolveSessionProviderSecrets({
    accountId: principal.accountId, projectId: principal.projectId,
    ...(prospectiveIds !== undefined ? { secretIds: prospectiveIds } : { sessionId: principal.sessionId! }),
    ...(options?.probe ? { advanceIndex: false } : {}),
    userId: principal.userId, grantUserId: personalUserId, providerId, name,
  });
}

function codexGrantAllowed(principal: AuthedPrincipal) {
  return !Array.isArray(principal.agentGrant?.env) ||
    principal.agentGrant.env.some((name) => name.toUpperCase() === 'CODEX_AUTH_JSON');
}

function codexGrantRefusal() {
  return new GatewayResolutionError('provider_not_connected',
    'The running agent cannot use ChatGPT connections.',
    'Add CODEX_AUTH_JSON to the agent secret grant, or choose another agent.');
}

async function codexAccountCandidates(context: Context, secrets: Array<{ secretId: string; value: string }>, selected: boolean) {
  const { principal, effectiveModel } = context;
  const candidates: UpstreamDescriptor[] = [];
  let expired = false;
  for (const secret of secrets) {
    try {
      const credential = await resolveCodexAccountCredential({
        projectId: principal.projectId!, accountId: principal.accountId,
        sessionId: principal.sessionId ?? null, userId: principal.userId,
        secretId: secret.secretId, value: secret.value,
      });
      if (!credential) { if (selected) expired = true; continue; }
      candidates.push({ ...codexDescriptor(credential, effectiveModel),
        credentialRef: secret.secretId, poolSecretId: secret.secretId });
    } catch (err) {
      if (!(err instanceof CodexRefreshError)) throw err;
      if (selected) expired = true;
    }
  }
  return { candidates, expired };
}

async function codexSharedCandidates(context: Context): Promise<UpstreamDescriptor[] | GatewayResolutionError | null> {
  const { principal, personalUserId } = context;
  const shared = await resolveProjectSharedProviderSecrets({
    accountId: principal.accountId, projectId: principal.projectId!,
    userId: principal.userId, grantUserId: principal.keyId ? null : personalUserId,
    providerId: 'codex', name: 'CODEX_AUTH_JSON',
  });
  if ((shared.secrets.length || shared.coolingDown) && !codexGrantAllowed(principal)) return codexGrantRefusal();
  if (shared.secrets.length) {
    const { candidates } = await codexAccountCandidates(context, shared.secrets, false);
    if (candidates.length) return candidates;
    return new GatewayResolutionError('provider_reauth_required',
      'The ChatGPT connections shared with this project need reconnection.',
      'Reconnect a shared ChatGPT account in Models, then retry.');
  }
  if (shared.coolingDown) return new GatewayResolutionError('provider_pool_rate_limited',
    'All ChatGPT connections shared with this project are cooling down.',
    'Retry after the cooldown, or connect another ChatGPT account.', shared.retryAfterSeconds);
  return null;
}

async function codexFallback(context: Context, sharedFailure: GatewayResolutionError | null): Promise<UpstreamDescriptor[]> {
  const { principal, effectiveModel, personalUserId } = context;
  let credential: Awaited<ReturnType<typeof resolveCodexCredential>>;
  try {
    credential = await resolveCodexCredential(principal.projectId!, principal.userId, undefined, {
      accountId: principal.accountId, sessionId: principal.sessionId, principalUserId: personalUserId,
    });
  } catch (err) {
    if (err instanceof CodexRefreshError) throw new GatewayResolutionError(
      'provider_reauth_required', 'Your Codex session has expired or was revoked.',
      'Reconnect Codex in project settings, then retry.');
    throw err;
  }
  if (!credential) {
    if (sharedFailure) throw sharedFailure;
    throw new GatewayResolutionError('provider_not_connected', 'Connect Codex to use this model.',
      'Connect your ChatGPT/Codex account in project settings, then retry.');
  }
  return [codexDescriptor(credential, effectiveModel)];
}

async function resolveCodexCandidates(context: Context): Promise<UpstreamDescriptor[]> {
  const { principal, effectiveModel, personalUserId } = context;
  if (!principal.projectId) throw new GatewayResolutionError('provider_not_connected',
    'Connect Codex to use this model.', 'Connect your ChatGPT/Codex account in project settings, then retry.');
  const pooledEnabled = await projectFeatureFlagEnabled(principal.projectId, 'pooled_provider_secrets');
  const pool = await selectedPool(context, 'codex', 'CODEX_AUTH_JSON', pooledEnabled);
  if (pool?.configured) {
    if (!codexGrantAllowed(principal)) throw codexGrantRefusal();
    if (!pool.secrets.length) throw new GatewayResolutionError(
      pool.coolingDown ? 'provider_pool_rate_limited' : 'provider_not_connected',
      pool.coolingDown ? 'All selected ChatGPT connections are cooling down.' :
        'No usable ChatGPT connection is selected for this session.',
      'Select a granted ChatGPT connection in session settings.', pool.retryAfterSeconds);
    const { candidates, expired } = await codexAccountCandidates(context, pool.secrets, true);
    if (candidates.length) return candidates;
    throw new GatewayResolutionError(expired ? 'provider_reauth_required' : 'provider_not_connected',
      expired ? 'The selected ChatGPT connections need reconnection.' : 'No ChatGPT connection is available.',
      'Reconnect a selected ChatGPT account or select another granted connection.');
  }
  if (pooledEnabled && personalUserId && !principal.keyId) {
    const personal = await resolveDefaultCodexAccountSecret(principal.accountId, principal.projectId, personalUserId);
    if (personal) {
      if (!codexGrantAllowed(principal)) throw codexGrantRefusal();
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
      throw new GatewayResolutionError('provider_reauth_required', 'Your ChatGPT connection needs reconnection.',
        'Reconnect your ChatGPT account in Models, then retry.');
    }
  }
  const shared = pooledEnabled ? await codexSharedCandidates(context) : null;
  if (Array.isArray(shared)) return shared;
  return codexFallback(context, shared);
}

async function byokDescriptors(context: Context, provider: string,
  byok: NonNullable<ReturnType<typeof resolveCatalogUpstream>>,
  keys: Array<{ identifier: string; value: string }>, pooled: boolean): Promise<UpstreamDescriptor[]> {
  const { principal, effectiveModel } = context;
  const resolvedModelId = effectiveModel.slice(provider.length + 1);
  const capabilities = capabilitiesForModel(provider, resolvedModelId);
  const bedrockRegion = byok.kind === 'bedrock'
    ? (await getProjectSecretValueForConsumer({
        projectId: principal.projectId!, accountId: principal.accountId,
        sessionId: principal.sessionId, actorUserId: principal.userId,
        name: BEDROCK_REGION_ENV_VAR, consumer: 'llm_gateway',
      }))?.trim() || undefined
    : undefined;
  if (bedrockRegion && !isAwsRegion(bedrockRegion)) throw new GatewayResolutionError(
    'provider_not_connected', `The project's AWS_REGION secret is not an AWS region name.`,
    'Set AWS_REGION to a region such as us-east-1, or remove it to use us-east-1.');
  const baseUrl = byok.kind === 'bedrock' ? bedrockByokBaseUrl(bedrockRegion) : byok.baseUrl;
  const invokeModelId = byok.kind === 'bedrock'
    ? normalizeBedrockInferenceProfileRegion(resolvedModelId, bedrockRegion) : resolvedModelId;
  return keys.map(({ identifier, value }) => ({
    provider, kind: byok.kind, npm: byok.npm, baseUrl,
    ...(bedrockRegion ? { region: bedrockRegion } : {}),
    apiKey: value, credentialRef: identifier,
    ...(pooled ? { poolSecretId: identifier } : {}),
    billingMode: 'none', markup: 0, resolvedModel: invokeModelId,
    pricing: livePricing(provider, byok.kind === 'bedrock'
      ? stripBedrockInferenceProfilePrefix(invokeModelId) : invokeModelId),
    reasoning: capabilities.reasoning, temperature: capabilities.temperature,
  }));
}

async function resolveByokCandidates(context: Context, provider: string,
  byok: NonNullable<ReturnType<typeof resolveCatalogUpstream>>): Promise<UpstreamDescriptor[]> {
  const { principal } = context;
  const pool = await selectedPool(context, provider, byok.envVar);
  if (pool?.configured && Array.isArray(principal.agentGrant?.env) &&
    !principal.agentGrant.env.some((name) => name.toUpperCase() === byok.envVar.toUpperCase())) {
    throw new GatewayResolutionError('provider_not_connected', `The running agent cannot use ${provider} keys.`,
      `Add ${byok.envVar} to the agent's secret grant, or choose another agent.`);
  }
  const keys = pool?.configured
    ? pool.secrets.map((secret) => ({ identifier: secret.secretId, value: secret.value }))
    : await resolveProjectSecretsForConsumer({
        projectId: principal.projectId!, accountId: principal.accountId,
        sessionId: principal.sessionId, actorUserId: principal.userId,
        name: byok.envVar, consumer: 'llm_gateway',
      });
  if (pool?.configured && !keys.length) throw new GatewayResolutionError(
    pool.coolingDown ? 'provider_pool_rate_limited' : 'provider_not_connected',
    pool.coolingDown ? `All selected ${provider} keys are cooling down after rate limits.` :
      `No usable ${provider} key is selected for this session.`,
    pool.coolingDown ? 'Retry after the provider cooldown, or select another granted key.' :
      'Select a granted key in session settings.', pool.retryAfterSeconds);
  return keys.length ? byokDescriptors(context, provider, byok, keys, !!pool?.configured) : [];
}

async function resolveManagedCandidates(principal: AuthedPrincipal, effectiveModel: string,
  access: Awaited<ReturnType<typeof getProjectModelAccess>>): Promise<UpstreamDescriptor[]> {
  const managed = getRuntimeManagedModel(effectiveModel);
  if (!managed || !config.LLM_GATEWAY_ENABLED || !config.KORTIX_MANAGED_PROVIDER_ENABLED) return [];
  if (access.disabledProviders.includes('kortix')) throw new GatewayResolutionError('provider_disabled',
    'Kortix Managed Models are disabled for this project.',
    'Choose a model from an enabled provider, or enable Kortix Managed Models in Models.');
  if (principal.freeModelsOnly) throw new GatewayResolutionError('plan_upgrade_required',
    `"${effectiveModel}" requires a paid plan.`, PLAN_UPGRADE_SUGGESTION);
  if (config.KORTIX_BILLING_INTERNAL_ENABLED && !(await accountMayUseManagedModels(principal.accountId))) {
    const tier = await getCachedAccountTier(principal.accountId);
    throw noManagedModelsError(effectiveModel, isPaidTier(tier ?? 'free'));
  }
  return managedCandidates(managed);
}

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
  const context = { principal, effectiveModel, personalUserId, options };
  if (provider === 'codex') return resolveCodexCandidates(context);

  const byok = resolveCatalogUpstream(provider);
  if (byok && principal.projectId) {
    const candidates = await resolveByokCandidates(context, provider, byok);
    if (candidates.length) return candidates;
  }
  const candidates = await resolveManagedCandidates(principal, effectiveModel, access);
  if (candidates.length) return candidates;

  // A BYOK-recognized provider with no usable key wins over the generic
  // "model not found" — the model IS real, we just can't reach it right now.
  if (byok && principal.projectId) throw new GatewayResolutionError(
    'provider_not_connected', `No ${provider} API key is connected for this project.`,
    `Add a ${provider} API key in project settings, then retry.`);

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
