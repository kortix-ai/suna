import { describe, expect, test } from 'bun:test';

import { createGatewayRouteResolver } from './resolve-route';

const principal = { userId: 'u1', accountId: 'a1' };

describe('gateway control-plane route resolver', () => {
  const resolveRoute = createGatewayRouteResolver({
    defaultModel: 'model-default',
    visionModel: 'model-vision',
    policies: [{
      id: 'default-degrade',
      models: ['model-default'],
      fallbackModels: ['model-fallback'],
      fallbackOn: 'any-error',
    }],
    supportsImage: (model) => model === 'model-default' || model === 'model-vision',
  });

  test('resolves auto and attaches the matching declarative fallback policy', async () => {
    expect(await resolveRoute(principal, {
      requestedModel: 'auto',
      requires: { imageInput: false },
    })).toEqual({
      policyId: 'default-degrade',
      primaryModel: 'model-default',
      fallbackModels: ['model-fallback'],
      fallbackOn: 'any-error',
    });
  });

  test('uses the principal default without changing explicit model requests', async () => {
    expect((await resolveRoute({ ...principal, defaultModel: 'account-model' }, {
      requestedModel: 'auto',
      requires: { imageInput: false },
    }))?.primaryModel).toBe('account-model');
    expect(await resolveRoute(principal, {
      requestedModel: 'explicit-model',
      requires: { imageInput: false },
    })).toEqual({
      policyId: 'direct',
      primaryModel: 'explicit-model',
      fallbackModels: [],
      fallbackOn: 'transient',
    });
  });

  test('selects the configured vision model only when the chosen model lacks image input', async () => {
    const route = await resolveRoute({ ...principal, defaultModel: 'text-only' }, {
      requestedModel: 'auto',
      requires: { imageInput: true },
    });
    expect(route?.primaryModel).toBe('model-vision');

    const explicit = await resolveRoute(principal, {
      requestedModel: 'explicit-text-model',
      requires: { imageInput: true },
    });
    expect(explicit.primaryModel).toBe('explicit-text-model');
  });

  test('project exact rules override the project default chain and unmatched explicit models stay direct', async () => {
    const projectResolver = createGatewayRouteResolver({
      defaultModel: 'platform-default',
      visionModel: 'platform-vision',
      policies: [],
      supportsImage: () => false,
      getProjectPolicy: async () => ({
        visionModel: 'project-vision',
        defaultFallback: { models: ['project-fallback'], fallbackOn: 'any-error' },
        rules: [{
          model: 'explicit-primary',
          fallbackModels: ['specific-fallback'],
          fallbackOn: 'transient',
        }],
      }),
    });

    expect(await projectResolver({ ...principal, projectId: 'p1' }, {
      requestedModel: 'explicit-primary',
      requires: { imageInput: false },
    })).toEqual({
      policyId: 'project:exact:explicit-primary',
      primaryModel: 'explicit-primary',
      fallbackModels: ['specific-fallback'],
      fallbackOn: 'transient',
    });

    expect(await projectResolver({ ...principal, projectId: 'p1' }, {
      requestedModel: 'unmatched-primary',
      requires: { imageInput: false },
    })).toEqual({
      policyId: 'direct',
      primaryModel: 'unmatched-primary',
      fallbackModels: [],
      fallbackOn: 'transient',
    });
  });

  test('auto uses project default fallback, project vision, and permits explicitly disabling fallback', async () => {
    let disabled = false;
    const projectResolver = createGatewayRouteResolver({
      defaultModel: 'platform-default',
      visionModel: 'platform-vision',
      policies: [],
      supportsImage: (model) => model === 'project-vision',
      getProjectPolicy: async () => ({
        visionModel: 'project-vision',
        defaultFallback: {
          models: disabled ? [] : ['project-fallback'],
          fallbackOn: 'any-error',
        },
        rules: [],
      }),
    });

    expect(await projectResolver({ ...principal, projectId: 'p1', defaultModel: 'project-default' }, {
      requestedModel: 'auto',
      requires: { imageInput: false },
    })).toEqual({
      policyId: 'project:default',
      primaryModel: 'project-default',
      fallbackModels: ['project-fallback'],
      fallbackOn: 'any-error',
    });

    const vision = await projectResolver(
      { ...principal, projectId: 'p1', defaultModel: 'text-only' },
      { requestedModel: 'auto', requires: { imageInput: true } },
    );
    expect(vision.primaryModel).toBe('project-vision');
    expect(vision.fallbackModels).toEqual(['project-fallback']);

    disabled = true;
    const noFallback = await projectResolver(
      { ...principal, projectId: 'p1' },
      { requestedModel: 'auto', requires: { imageInput: false } },
    );
    expect(noFallback.fallbackModels).toEqual([]);
    expect(noFallback.policyId).toBe('project:default');
  });
});

describe('gateway control-plane route resolver — generation-defaults clamping', () => {
  const genPrincipal = { ...principal, projectId: 'p1' };

  const reasoningModel = {
    id: 'reasoning-model',
    name: 'Reasoning Model',
    reasoning: true,
    reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
    temperature: false,
    limit: { output: 4096 },
  };

  function resolverFor(modelGenerationConfig: Record<string, unknown>) {
    return createGatewayRouteResolver({
      defaultModel: 'model-default',
      visionModel: 'model-vision',
      policies: [],
      supportsImage: () => true,
      getProjectPolicy: async () => ({
        visionModel: null,
        defaultFallback: null,
        rules: [],
        modelGenerationConfig: modelGenerationConfig as never,
      }),
      catalogModelFor: (model) => (model === 'reasoning-model' ? (reasoningModel as never) : undefined),
    });
  }

  test('attaches a clamped generationDefaults for the resolved primary model', async () => {
    const resolveRoute = resolverFor({
      'reasoning-model': { reasoningEffort: 'high', maxOutputTokens: 999_999 },
    });
    const route = await resolveRoute(genPrincipal, {
      requestedModel: 'reasoning-model',
      requires: { imageInput: false },
    });
    // maxOutputTokens is clamped to the model's limit.output (4096).
    expect(route.generationDefaults).toEqual({ reasoningEffort: 'high', maxOutputTokens: 4096 });
  });

  test('drops a capability the resolved model does not support (temperature:false)', async () => {
    const resolveRoute = resolverFor({
      'reasoning-model': { temperature: 1.5, topP: 0.9 },
    });
    const route = await resolveRoute(genPrincipal, {
      requestedModel: 'reasoning-model',
      requires: { imageInput: false },
    });
    expect(route.generationDefaults).toBeUndefined();
  });

  test('no configured entry for the resolved model → no generationDefaults', async () => {
    const resolveRoute = resolverFor({ 'other-model': { temperature: 0.5 } });
    const route = await resolveRoute(genPrincipal, {
      requestedModel: 'reasoning-model',
      requires: { imageInput: false },
    });
    expect(route.generationDefaults).toBeUndefined();
  });
});
