import { describe, expect, test } from 'bun:test';

import { withoutAgentModel } from './local-config-state';

describe('withoutAgentModel', () => {
  test('removes only the selected agent model', () => {
    expect(withoutAgentModel({
      kortix: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
      reviewer: { providerID: 'openai', modelID: 'gpt-5.4' },
    }, 'kortix')).toEqual({
      reviewer: { providerID: 'openai', modelID: 'gpt-5.4' },
    });
  });

  test('does not mutate the persisted model map', () => {
    const models = {
      kortix: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
    };

    withoutAgentModel(models, 'kortix');

    expect(models).toEqual({
      kortix: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
    });
  });
});
