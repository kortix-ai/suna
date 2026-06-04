import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCustomProviderConfigUpdate } from './custom-provider-config';

test('buildCustomProviderConfigUpdate never emits legacy top-level models', () => {
  const cfg = buildCustomProviderConfigUpdate(undefined, {
    providerID: 'my-provider',
    name: 'My Provider',
    baseURL: 'https://api.example.com/v1',
    apiKey: '',
    modelId: 'model-1',
    modelName: 'Model 1',
  });

  assert.equal('models' in cfg, false);
  assert.deepEqual((cfg.provider as any)['my-provider'], {
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
});
