import { createRoute, z } from '@hono/zod-openapi';
import { PROJECT_ACTIONS } from '../../iam';
import {
  type CustomLlmProviderDefinition,
  CustomLlmProviderInputSchema,
  customProviderIdError,
  probeCustomModelLimits,
  customProviderIdFromSecret,
  customProviderSecretName,
} from '../../llm-gateway/custom-providers';
import { auth, errors, json } from '../../openapi';
import { listProjectCustomProviders, writeProjectCustomProvider } from '../../repositories/project-model-access';
import { config } from '../../config';
import { assertSafeEgressUrl, UnsafeEgressError } from '../../shared/ssrf-guard';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { propagateProjectSecretsToActiveSandboxes } from '../lib/sandbox-env-sync';
import { resolveProjectSecretsForConsumer } from '../secrets';

const CustomLlmProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  base_url: z.string().nullable(),
  models: z.array(z.object({
    id: z.string(),
    name: z.string(),
    /** Context window in tokens; absent: the gateway serves 128k. */
    context: z.number().optional(),
    /** Max output tokens; absent: the context window, else 16k. */
    output: z.number().optional(),
  })),
  secret_name: z.string(),
  has_key: z.boolean(),
  /** false: a `CUSTOM_<ID>_API_KEY` secret with no endpoint saved yet. */
  configured: z.boolean(),
}).openapi('CustomLlmProvider');
type CustomLlmProviderView = z.infer<typeof CustomLlmProviderSchema>;

const Params = z.object({ projectId: z.string(), providerId: z.string() });

function view(provider: CustomLlmProviderDefinition, secretNames: string[]): CustomLlmProviderView {
  const secretName = customProviderSecretName(provider.id);
  return { ...provider, secret_name: secretName, has_key: secretNames.includes(secretName), configured: true };
}

/**
 * Models → Custom: a project's own OpenAI-compatible endpoints, served by the
 * LLM gateway (llm-gateway/custom-providers.ts). The key is the ordinary
 * project secret `CUSTOM_<ID>_API_KEY`, written and deleted through the
 * secrets routes.
 */
export function registerCustomProvidersRoutes(): void {
  projectsApp.openapi(createRoute({
    method: 'get', path: '/{projectId}/custom-providers', tags: ['projects'],
    summary: 'List the custom LLM providers of a project', ...auth,
    request: { params: Params.omit({ providerId: true }) },
    responses: { 200: json(z.object({ providers: z.array(CustomLlmProviderSchema) }), 'Custom providers'), ...errors(403, 404) },
  }), async (c) => {
    const { projectId } = c.req.valid('param');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const { providers, secretNames } = await listProjectCustomProviders(projectId);
    const configured = new Set(providers.map((provider) => customProviderSecretName(provider.id)));
    // A key saved by the old Custom form (an opencode.jsonc snippet) has no
    // endpoint in Kortix yet: listed so the owner can add one.
    const legacy = secretNames.filter((name) => !configured.has(name)).flatMap((name) => {
      const id = customProviderIdFromSecret(name);
      return id ? [{ id, name: id, base_url: null, models: [], secret_name: name, has_key: true, configured: false }] : [];
    });
    return c.json({ providers: [...providers.map((provider) => view(provider, secretNames)), ...legacy] });
  });

  projectsApp.openapi(createRoute({
    method: 'put', path: '/{projectId}/custom-providers/{providerId}', tags: ['projects'],
    summary: 'Create or replace a custom LLM provider', ...auth,
    request: { params: Params, body: { content: { 'application/json': { schema: CustomLlmProviderInputSchema } } } },
    responses: { 200: json(CustomLlmProviderSchema, 'The saved provider'), ...errors(400, 403, 404) },
  }), async (c) => {
    const { projectId, providerId } = c.req.valid('param');
    const input = c.req.valid('json');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MODEL_WRITE);
    const idError = customProviderIdError(providerId);
    if (idError === 'reserved_provider_id') {
      return c.json({ error: `"${providerId}" is a built-in provider. Connect it under Providers instead.`, code: idError }, 400);
    }
    if (idError) {
      return c.json({ error: 'Provider ID can use lowercase letters, numbers, dashes and underscores (64 at most)', code: idError }, 400);
    }
    // The gateway enforces this on every request; checking here turns a dead
    // endpoint into a clear error at save time.
    try {
      await assertSafeEgressUrl(input.base_url, {
        allowHttp: true,
        allowPrivateHosts: config.KORTIX_LLM_CUSTOM_PROVIDER_ALLOW_HOSTS,
      });
    } catch (error) {
      if (!(error instanceof UnsafeEgressError)) throw error;
      return c.json({
        error: 'The base URL must be a public address the Kortix gateway can reach.',
        code: 'unsafe_base_url',
      }, 400);
    }
    // Save the key first: the endpoint's `GET /models` usually needs it.
    const [key] = await resolveProjectSecretsForConsumer({
      projectId, accountId: loaded.row.accountId, actorUserId: loaded.userId,
      name: customProviderSecretName(providerId), consumer: 'llm_gateway',
    });
    const detected = await probeCustomModelLimits(input.base_url, key?.value ?? null);
    const next = await writeProjectCustomProvider(projectId, providerId, input, detected);
    const { secretNames } = await listProjectCustomProviders(projectId);
    // Running sessions re-read the served model list.
    void propagateProjectSecretsToActiveSandboxes(projectId, { refreshModels: true });
    return c.json(view(next!.find((provider) => provider.id === providerId)!, secretNames));
  });

  projectsApp.openapi(createRoute({
    method: 'delete', path: '/{projectId}/custom-providers/{providerId}', tags: ['projects'],
    summary: 'Remove a custom LLM provider', ...auth,
    request: { params: Params },
    responses: { 204: { description: 'Removed' }, ...errors(403, 404) },
  }), async (c) => {
    const { projectId, providerId } = c.req.valid('param');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MODEL_WRITE);
    if (!(await writeProjectCustomProvider(projectId, providerId, null))) return c.json({ error: 'Not found' }, 404);
    void propagateProjectSecretsToActiveSandboxes(projectId, { refreshModels: true });
    return c.body(null, 204);
  });
}
