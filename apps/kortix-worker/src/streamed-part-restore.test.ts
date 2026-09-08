import { expect, test } from 'bun:test';
import { ChatEventAdapter } from './chat-events.ts';
import { RuntimeSurface } from './runtime-surface.ts';

test.each(['', 'Let me inspect the configured effort.'])(
  'restoration retains streamed reasoning %j before tool calls',
  (reasoning) => {
    const options = {
      sessionId: 'streamed-part-restore',
      resolvedModel: { providerID: 'kortix', modelID: 'test-model' },
    };
    const surface = new RuntimeSurface(options);
    const user = {
      role: 'user',
      content: [{ type: 'text', text: 'Inspect the effort.' }],
      timestamp: 10,
      kortixWireMessageId: 'msg_000000000010aaaaaaaaaaaaaa',
    };
    surface.seedRestoredMessages([user]);
    let clock = 20;
    const adapter = new ChatEventAdapter({
      sessionID: surface.rootId,
      messageId: () => 'msg_000000000020bbbbbbbbbbbbbb',
      parentMessageId: () => user.kortixWireMessageId,
      model: options.resolvedModel,
      now: () => clock++,
    });
    const emit = (event: unknown) =>
      adapter.translate(event).forEach((frame) => surface.publishWire(frame));
    emit({ type: 'message_start', message: { role: 'assistant' } });
    emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 },
    });
    emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: reasoning },
    });
    emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_start', contentIndex: 1 },
    });
    emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_end', contentIndex: 1, content: '' },
    });
    const call = { type: 'toolCall', id: 'call_effort', name: 'inspect_effort', arguments: {} };
    const message = {
      role: 'assistant',
      content: [...(reasoning ? [{ type: 'thinking', thinking: reasoning }] : []), call],
      stopReason: 'toolUse',
      timestamp: 20,
    };
    emit({ type: 'message_end', message });
    emit({
      type: 'tool_execution_start',
      toolCallId: call.id,
      toolName: call.name,
      args: call.arguments,
    });
    const result = { content: [{ type: 'text', text: 'high' }], details: { effort: 'high' } };
    emit({ type: 'tool_execution_end', toolCallId: call.id, result, isError: false });
    const toolResult = {
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      ...result,
      timestamp: 30,
    };
    emit({ type: 'message_end', message: toolResult });
    const before = surface.transcript.page({ limit: 100, before: null }).messages;
    expect(before[1]!.parts.map((part) => part.type)).toEqual(['reasoning', 'text', 'tool']);
    expect(before[1]!.parts[0]!.time).toEqual({ start: 21, end: 22 });
    const durable = JSON.parse(JSON.stringify([user, message, toolResult]));
    for (let restore = 0; restore < 2; restore++) {
      const restored = new RuntimeSurface(options);
      restored.seedRestoredMessages(durable);
      expect(restored.transcript.page({ limit: 100, before: null }).messages).toEqual(before);
    }
    const replay = new ChatEventAdapter({ sessionID: surface.rootId, now: () => 100 });
    expect(replay.translate({ type: 'message_start', message: durable[1] })).toEqual([]);
    expect(replay.translate({ type: 'message_end', message: durable[1] })).toEqual([]);
    const resumed = replay.translate({
      type: 'tool_execution_start',
      toolCallId: call.id,
      toolName: call.name,
      args: call.arguments,
    });
    expect(resumed[0]!.properties.part).toMatchObject({
      id: before[1]!.parts[2]!.id,
      state: { time: { start: 24 } },
    });
    expect(replay.toolContext(call.id)).toEqual(adapter.toolContext(call.id));
    expect(message.content).toEqual([
      ...(reasoning ? [{ type: 'thinking', thinking: reasoning }] : []),
      call,
    ]);
  },
);
