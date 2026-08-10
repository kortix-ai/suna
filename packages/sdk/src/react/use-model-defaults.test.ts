import { describe, expect, test } from 'bun:test';

import { resolveModelDefault } from './use-model-defaults';

describe('resolveModelDefault', () => {
  test('uses agent, workspace, account, then platform precedence', () => {
    const data = {
      accountDefault: 'openai/gpt-account',
      workspaceDefault: 'anthropic/claude-workspace',
      platformDefault: 'kortix/platform',
      agentDefaults: { coder: 'google/gemini-agent' },
      resolvedForCaller: 'anthropic/claude-workspace',
      freeTier: false,
    };

    expect(resolveModelDefault(data, 'coder')).toEqual({
      providerID: 'kortix',
      modelID: 'google/gemini-agent',
    });
    expect(resolveModelDefault(data, 'reviewer')).toEqual({
      providerID: 'kortix',
      modelID: 'anthropic/claude-workspace',
    });
  });

  test('does not expose the paid platform default to a free-tier caller', () => {
    expect(
      resolveModelDefault(
        {
          accountDefault: null,
          workspaceDefault: null,
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
