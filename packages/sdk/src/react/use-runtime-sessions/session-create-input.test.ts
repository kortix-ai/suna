import { describe, expect, test } from 'bun:test';

import { buildRuntimeSessionCreateInput } from './session-create-input';

describe('buildRuntimeSessionCreateInput', () => {
  test('carries an initial slash command through the platform session create contract', () => {
    expect(buildRuntimeSessionCreateInput({
      title: 'Kortix Onboarding',
      initialPrompt: '/onboarding',
    })).toEqual({
      name: 'Kortix Onboarding',
      initial_prompt: '/onboarding',
    });
  });

  test('omits every optional field when nothing was selected (unchanged server defaults)', () => {
    expect(buildRuntimeSessionCreateInput({})).toEqual({});
  });

  test('forwards a picked agent so the dashboard composer actually binds the session', () => {
    expect(buildRuntimeSessionCreateInput({ agentName: 'reviewer' })).toEqual({
      agent_name: 'reviewer',
    });
  });

  test('forwards an explicit connection and model selection', () => {
    expect(
      buildRuntimeSessionCreateInput({
        agentName: 'kortix',
        connectionId: 'anthropic_api_key',
        modelSelection: { kind: 'preset', modelId: 'kortix/anthropic/claude-opus-4-8' },
      }),
    ).toEqual({
      agent_name: 'kortix',
      connection_id: 'anthropic_api_key',
      model_selection: {
        kind: 'preset',
        model_id: 'kortix/anthropic/claude-opus-4-8',
        connection_id: 'anthropic_api_key',
      },
    });
  });

  test('a harness-native model selection carries its own connection id independent of the top-level one', () => {
    expect(
      buildRuntimeSessionCreateInput({
        agentName: 'claude-agent',
        modelSelection: {
          kind: 'custom',
          modelId: 'claude-opus-4-8',
          connectionId: 'claude_subscription',
        },
      }),
    ).toEqual({
      agent_name: 'claude-agent',
      model_selection: {
        kind: 'custom',
        model_id: 'claude-opus-4-8',
        connection_id: 'claude_subscription',
      },
    });
  });
});
