import { describe, expect, test } from 'bun:test';

import { resolveModelDefault } from './use-model-defaults';

describe('resolveModelDefault', () => {
  test('uses agent, project, account, then platform precedence', () => {
    const data = {
      accountDefault: 'openai/gpt-account',
      projectDefault: 'anthropic/claude-project',
      platformDefault: 'kortix/platform',
      agentDefaults: { coder: 'google/gemini-agent' },
      resolvedForCaller: 'anthropic/claude-project',
      freeTier: false,
    };

    expect(resolveModelDefault(data, 'coder')).toEqual({
      providerID: 'kortix',
      modelID: 'google/gemini-agent',
    });
    expect(resolveModelDefault(data, 'reviewer')).toEqual({
      providerID: 'kortix',
      modelID: 'anthropic/claude-project',
    });
  });

  test('does not expose the paid platform default to a free-tier caller', () => {
    expect(
      resolveModelDefault(
        {
          accountDefault: null,
          projectDefault: null,
          platformDefault: 'kortix/platform',
          agentDefaults: {},
          resolvedForCaller: null,
          freeTier: true,
        },
        undefined,
      ),
    ).toBeUndefined();
  });
});
