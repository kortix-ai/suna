import { describe, expect, mock, test } from 'bun:test';

let capturedCommand: unknown;

mock.module('../../core/runtime/client', () => ({
  getClient: () => ({
    session: {
      command: async (input: unknown) => {
        capturedCommand = input;
        return { data: {} };
      },
    },
  }),
}));

import { executeOpenCodeCommand } from './commands';

describe('executeOpenCodeCommand', () => {
  test('forwards model, agent, and variant overrides to the runtime client', async () => {
    await executeOpenCodeCommand({
      sessionId: 'ses_root',
      command: 'review',
      args: 'src',
      agent: 'coder',
      model: 'kortix/anthropic/claude-sonnet-4-6',
      variant: 'high',
    });

    expect(capturedCommand).toEqual({
      sessionID: 'ses_root',
      command: 'review',
      arguments: 'src',
      agent: 'coder',
      model: 'kortix/anthropic/claude-sonnet-4-6',
      variant: 'high',
    });
  });
});
