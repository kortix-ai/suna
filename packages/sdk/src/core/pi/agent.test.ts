import { expect, test } from 'bun:test';
import { definePiAgent, type PiAgentContext } from './agent';

const context = {
  agentName: 'reviewer',
  sessionId: 'session',
  sourceSha: 'a'.repeat(40),
} as PiAgentContext;

test('a custom Pi factory retains native hooks and awaits agent initialization data', async () => {
  const beforeToolCall = async () => ({ block: true, reason: 'Review only' });
  const factory = definePiAgent(async ({ agentName }) => ({
    beforeToolCall,
    tools: [
      {
        name: 'custom_lookup',
        label: 'Lookup',
        description: 'Look up a value',
        parameters: { type: 'object', properties: {} } as any,
        execute: async () => ({
          content: [{ type: 'text' as const, text: agentName }],
          details: {},
        }),
      },
    ],
  }));
  const definition = await factory(context);
  expect(await definition.beforeToolCall!({} as any)).toEqual({
    block: true,
    reason: 'Review only',
  });
  expect((await definition.tools![0]!.execute('call', {}, undefined)).content).toEqual([
    { type: 'text', text: 'reviewer' },
  ]);
});

test('custom Pi definitions reject unsupported settings and malformed lifecycle hooks', async () => {
  for (const value of [
    null,
    [],
    { streamFn: () => {} },
    { model: 'uncompiled-model' },
    { tools: {} },
    { beforeToolCall: true },
    { initialize: 'run' },
    { hookTimeoutMs: 0 },
    { hookTimeoutMs: 30001 },
    { thinkingLevel: 'ultra' },
  ]) {
    await expect(definePiAgent(() => value as any)(context)).rejects.toThrow(/Pi agent/);
  }
});

test('custom tools require valid names, object schemas, and unique registrations', async () => {
  const tool = {
    name: 'lookup',
    label: 'Lookup',
    description: 'Look up a value',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [], details: {} }),
  };
  for (const tools of [
    [{ ...tool, name: '../bad' }],
    [{ ...tool, parameters: { type: 'string' } }],
    [{ ...tool, execute: undefined }],
    [tool, tool],
  ]) {
    await expect(definePiAgent(() => ({ tools }) as any)(context)).rejects.toThrow(/Pi agent/);
  }
});
