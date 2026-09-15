import { expect, test } from 'bun:test';
import { ChatEventAdapter } from './chat-events.ts';

test('a resumed tool batch keeps the captured assistant and question part identities', () => {
  const adapter = new ChatEventAdapter({
    sessionID: 'ses_one',
    mintMessageId: () => 'msg_new',
    parentMessageId: () => 'msg_user',
    now: () => 200,
  });
  const message = {
    role: 'assistant',
    kortixWireMessageId: 'msg_saved',
    kortixParentMessageId: 'msg_user',
    kortixWireCreatedAt: 100,
    content: [
      { type: 'text', text: 'Choose.' },
      { type: 'toolCall', id: 'call_question', name: 'question', arguments: { questions: [] } },
    ],
    stopReason: 'toolUse',
  };
  expect(adapter.translate({ type: 'message_start', message })).toEqual([]);
  expect(adapter.translate({ type: 'message_end', message })).toEqual([]);
  const events = adapter.translate({
    type: 'tool_execution_start',
    toolCallId: 'call_question',
    toolName: 'question',
    args: { questions: [] },
  });
  expect(events[0]!.properties.part).toMatchObject({
    id: 'msg_saved-p1',
    messageID: 'msg_saved',
    callID: 'msg_saved-p1',
    state: { time: { start: 100 } },
  });
  expect(message.kortixWireMessageId).toBe('msg_saved');
  expect(message.kortixWireCreatedAt).toBe(100);
});
