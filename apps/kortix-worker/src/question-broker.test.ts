import { describe, expect, test } from 'bun:test';

import { QuestionBroker, type QuestionEvent, QuestionRejectedError } from './question-broker.ts';
import { createQuestionTool } from './question-tool.ts';

const QUESTION = {
  question: 'Which database should this project use?',
  header: 'Database',
  options: [
    { label: 'PostgreSQL', description: 'Use the existing PostgreSQL service.' },
    { label: 'SQLite', description: 'Keep the database inside one file.' },
  ],
};

describe('QuestionBroker', () => {
  test('publishes an OpenCode-shaped request and resolves the matching answer', async () => {
    const events: QuestionEvent[] = [];
    const broker = new QuestionBroker({
      sessionId: 'ses_pi_1',
      publish: (event) => events.push(event),
      createId: () => 'que_1',
    });

    const answer = broker.ask([QUESTION]);
    expect(broker.list()).toEqual([{ id: 'que_1', sessionID: 'ses_pi_1', questions: [QUESTION] }]);
    expect(events).toEqual([
      {
        type: 'question.asked',
        properties: { id: 'que_1', sessionID: 'ses_pi_1', questions: [QUESTION] },
      },
    ]);

    expect(broker.reply('que_1', [['PostgreSQL']])).toBe(true);
    await expect(answer).resolves.toEqual([['PostgreSQL']]);
    expect(broker.list()).toEqual([]);
    expect(events.at(-1)).toEqual({
      type: 'question.replied',
      properties: {
        sessionID: 'ses_pi_1',
        requestID: 'que_1',
        answers: [['PostgreSQL']],
      },
    });
  });

  test('rejects one pending request and removes it from recovery reads', async () => {
    const events: QuestionEvent[] = [];
    const broker = new QuestionBroker({
      sessionId: 'ses_pi_1',
      publish: (event) => events.push(event),
      createId: () => 'que_2',
    });

    const answer = broker.ask([QUESTION]);
    expect(broker.reject('que_2')).toBe(true);
    await expect(answer).rejects.toBeInstanceOf(QuestionRejectedError);
    expect(broker.list()).toEqual([]);
    expect(events.at(-1)).toEqual({
      type: 'question.rejected',
      properties: { sessionID: 'ses_pi_1', requestID: 'que_2' },
    });
  });

  test('cancels a pending question when the owning tool is aborted', async () => {
    const events: QuestionEvent[] = [];
    const controller = new AbortController();
    const broker = new QuestionBroker({
      sessionId: 'ses_pi_1',
      publish: (event) => events.push(event),
      createId: () => 'que_3',
    });

    const answer = broker.ask([QUESTION], { signal: controller.signal });
    controller.abort(new Error('turn stopped'));

    await expect(answer).rejects.toThrow('turn stopped');
    expect(broker.list()).toEqual([]);
    expect(events.at(-1)?.type).toBe('question.rejected');
  });

  test('refuses malformed answers and unknown request ids without settling', async () => {
    const broker = new QuestionBroker({
      sessionId: 'ses_pi_1',
      publish: () => {},
      createId: () => 'que_4',
    });
    const answer = broker.ask([{ ...QUESTION, custom: false }]);

    expect(() => broker.reply('que_4', [])).toThrow(/one answer per question/);
    expect(() => broker.reply('que_4', [['Unknown']])).toThrow(/not an available option/);
    expect(broker.reply('missing', [['PostgreSQL']])).toBe(false);
    expect(broker.reject('missing')).toBe(false);
    expect(broker.list()).toHaveLength(1);

    broker.reject('que_4');
    await expect(answer).rejects.toBeInstanceOf(QuestionRejectedError);
  });

  test('accepts a custom answer when the optional custom flag is omitted', async () => {
    const broker = new QuestionBroker({
      sessionId: 'ses_pi_1',
      publish: () => {},
      createId: () => 'que_custom_default',
    });
    const answer = broker.ask([QUESTION]);

    expect(broker.reply('que_custom_default', [['CockroachDB']])).toBe(true);
    await expect(answer).resolves.toEqual([['CockroachDB']]);
  });

  test('rejects a custom answer when custom is explicitly disabled', async () => {
    const broker = new QuestionBroker({
      sessionId: 'ses_pi_1',
      publish: () => {},
      createId: () => 'que_custom_disabled',
    });
    const answer = broker.ask([{ ...QUESTION, custom: false }]);

    expect(() => broker.reply('que_custom_disabled', [['CockroachDB']])).toThrow(
      /not an available option/,
    );
    broker.reject('que_custom_disabled');
    await expect(answer).rejects.toBeInstanceOf(QuestionRejectedError);
  });
});

describe('question tool', () => {
  test('blocks the model tool call until the OpenCode answer route replies', async () => {
    const broker = new QuestionBroker({
      sessionId: 'ses_pi_1',
      publish: () => {},
      createId: () => 'que_tool',
    });
    const tool = createQuestionTool(broker, (callID) => ({ messageID: 'msg_assistant', callID }));

    const execution = tool.execute('call_1', { questions: [QUESTION] });
    await Promise.resolve();
    expect(broker.list()[0]).toMatchObject({
      id: 'que_tool',
      sessionID: 'ses_pi_1',
      tool: { messageID: 'msg_assistant', callID: 'call_1' },
    });
    broker.reply('que_tool', [['SQLite']]);

    await expect(execution).resolves.toEqual({
      content: [{ type: 'text', text: 'Database: SQLite' }],
      details: { answers: [['SQLite']] },
    });
  });
});
