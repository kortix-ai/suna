import { expect, test } from 'bun:test';
import { Agent } from '@earendil-works/pi-agent-core';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { installStructuredOutput } from './structured-output.ts';

function fixture() {
  const faux = fauxProvider({ provider: 'structured-hooks' });
  const models = createModels();
  models.setProvider(faux.provider);
  const agent = new Agent({
    streamFn: (model, context, options) => models.streamSimple(model, context, options),
    initialState: {
      model: faux.getModel(),
      systemPrompt: 'Follow the user.',
      tools: [],
      messages: [],
    },
  });
  return { agent, faux };
}
const format = {
  type: 'json_schema' as const,
  schema: { type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'] },
};

test('native lifecycle hooks observe structured completion before the agent stops', async () => {
  const { agent, faux } = fixture();
  const seen: string[] = [];
  agent.beforeToolCall = async () => {
    seen.push('before');
    return undefined;
  };
  agent.afterToolCall = async () => {
    seen.push('after');
    return undefined;
  };
  agent.shouldStopAfterTurn = () => {
    seen.push('stop');
    return false;
  };
  const controller = installStructuredOutput(agent);
  controller.begin(format);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('StructuredOutput', { answer: 42 })], {
      stopReason: 'toolUse',
    }),
  ]);
  await agent.prompt('Return the answer.');
  expect(seen).toEqual(['before', 'after', 'stop']);
  expect(
    (agent.state.messages.find((message) => message.role === 'assistant') as any).kortixStructured,
  ).toEqual({ answer: 42 });
});

test('structured output preserves custom payload changes and limits required tool choice to its own prompt', async () => {
  const { agent, faux } = fixture();
  agent.onPayload = (payload) => ({ ...(payload as object), custom: true });
  const controller = installStructuredOutput(agent);
  const model = { ...faux.getModel(), api: 'openai-completions' as const };
  const payload = {
    tools: [{ type: 'function', function: { name: 'StructuredOutput' } }],
    tool_choice: 'auto',
  };
  controller.begin(format);
  expect(await agent.onPayload!(payload, model)).toEqual({
    ...payload,
    custom: true,
    tool_choice: 'required',
  });
  expect(await agent.onPayload!({ tools: [] }, model)).toEqual({ tools: [], custom: true });
  controller.end();
  expect(await agent.onPayload!(payload, model)).toEqual({ ...payload, custom: true });
});
