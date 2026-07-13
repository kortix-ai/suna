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
});
