import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCustomProviderConfigUpdate,
  isEnvReference,
  normalizeCustomProviderForm,
  validateCustomProviderForm,
} from './custom-provider-config.ts';

test('validateCustomProviderForm rejects invalid provider IDs', () => {
  assert.equal(
    validateCustomProviderForm({
      providerID: 'bad provider',
      name: 'Bad Provider',
      baseURL: 'https://example.com/v1',
      apiKey: '',
      modelId: 'model-1',
      modelName: 'Model 1',
    }),
    'Provider ID can only use letters, numbers, dashes, and underscores',
  );
});

test('buildCustomProviderConfigUpdate preserves existing providers and adds custom provider', () => {
  const config = buildCustomProviderConfigUpdate(
    {
      provider: {
        anthropic: {
          name: 'Anthropic',
        },
      },
    } as any,
    {
      providerID: 'my-provider',
      name: 'My Provider',
      baseURL: 'https://api.example.com/v1',
      apiKey: '',
      modelId: 'model-1',
      modelName: 'Model 1',
    },
  );

  assert.deepEqual((config.provider as any).anthropic, { name: 'Anthropic' });
  assert.deepEqual((config.provider as any)['my-provider'], {
    npm: '@ai-sdk/openai-compatible',
    name: 'My Provider',
    options: {
      baseURL: 'https://api.example.com/v1',
    },
    models: {
      'model-1': {
        id: 'model-1',
        name: 'Model 1',
        family: 'my-provider',
      },
    },
  });
  assert.equal('models' in config, false);
});

test('buildCustomProviderConfigUpdate persists env api keys into provider options', () => {
  const normalized = normalizeCustomProviderForm({
    providerID: 'env-provider',
    name: 'Env Provider',
    baseURL: 'https://api.example.com/v1',
    apiKey: '  {env:CUSTOM_PROVIDER_API_KEY}  ',
    modelId: 'model-1',
    modelName: 'Model 1',
  });

  assert.equal(normalized.apiKey, '{env:CUSTOM_PROVIDER_API_KEY}');
  assert.equal(isEnvReference(normalized.apiKey), true);

  const config = buildCustomProviderConfigUpdate(undefined, normalized);
  assert.deepEqual((config.provider as any)['env-provider'].options, {
    baseURL: 'https://api.example.com/v1',
    apiKey: '{env:CUSTOM_PROVIDER_API_KEY}',
  });
});
