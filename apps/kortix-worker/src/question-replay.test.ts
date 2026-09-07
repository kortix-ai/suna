import { expect, test } from 'bun:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { planQuestionReplay } from './question-replay.ts';
import type { QuestionCheckpoint } from './question-checkpoint.ts';

function fixture() {
  const questions = [
    { header: 'Mode', question: 'Choose.', options: [{ label: 'Blue', description: 'First.' }] },
  ];
  const assistant = {
    ...fauxAssistantMessage(
      [
        { type: 'text' as const, text: 'Choose next.' },
        fauxToolCall('write', { path: 'file', content: 'once' }, { id: 'call_write' }),
        fauxToolCall('question', { questions }, { id: 'call_question' }),
        fauxToolCall('read', { path: 'file' }, { id: 'call_read' }),
      ],
      { stopReason: 'toolUse' },
    ),
    kortixWireMessageId: 'msg_assistant',
    kortixParentMessageId: 'msg_user',
  };
  const messages: any[] = [
    { role: 'user', content: [{ type: 'text', text: 'Act.' }], kortixWireMessageId: 'msg_user' },
    assistant,
    {
      role: 'toolResult',
      toolCallId: 'call_write',
      toolName: 'write',
      content: [{ type: 'text', text: 'written' }],
      isError: false,
      timestamp: 100,
    },
  ];
  const checkpoint: QuestionCheckpoint = {
    turnMessageId: 'msg_user',
    toolCallId: 'call_question',
    resolution: null,
    released: false,
    request: {
      id: 'que_one',
      sessionID: 'ses_one',
      questions: structuredClone(questions),
      tool: { messageID: 'msg_assistant', callID: 'msg_assistant-p2' },
    },
  };
  return { messages, checkpoint };
}

test('plans replay from the saved tool batch and retains completed results without rerunning their actions', () => {
  const { messages, checkpoint } = fixture();
  const before = structuredClone(messages);
  const plan = planQuestionReplay(messages, checkpoint);
  expect(plan.assistantIndex).toBe(1);
  expect(plan.completedSteps).toBe(1);
  expect([...plan.results.keys()]).toEqual(['call_write']);
  expect(plan.results.get('call_write')).toEqual(messages[2]);
  expect(plan.assistant).toEqual(messages[1]);
  expect(messages).toEqual(before);
});

for (const corruption of [
  'missing-result',
  'wrong-result',
  'later-assistant',
  'wrong-question',
  'wrong-parent',
  'wrong-wire-part',
  'released',
  'duplicate-call',
]) {
  test(`rejects a ${corruption} checkpoint instead of repeating an unknown tool boundary`, () => {
    const { messages, checkpoint } = fixture();
    if (corruption === 'missing-result') messages.pop();
    if (corruption === 'wrong-result') messages[2].toolCallId = 'call_read';
    if (corruption === 'later-assistant') messages.push(fauxAssistantMessage('already continued'));
    if (corruption === 'wrong-question') checkpoint.request.questions[0]!.question = 'Changed?';
    if (corruption === 'wrong-parent') checkpoint.turnMessageId = 'msg_other';
    if (corruption === 'wrong-wire-part') checkpoint.request.tool!.callID = 'msg_assistant-p1';
    if (corruption === 'released') checkpoint.released = true;
    if (corruption === 'duplicate-call') messages[1].content[3].id = 'call_write';
    expect(() => planQuestionReplay(messages, checkpoint)).toThrow(/question replay/);
  });
}
