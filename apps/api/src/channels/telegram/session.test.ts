import { describe, expect, test } from 'bun:test';
import { renderTelegramPrompt, telegramMessageEvent, telegramThreadId, type TelegramMessage } from './session';

const message: TelegramMessage = {
  message_id: 7,
  date: 1_760_000_000,
  chat: { id: -100123, type: 'supergroup' },
  from: { id: 42, username: 'synthetic_user' },
  text: 'status?',
};

describe('telegram inbox envelope', () => {
  test('a message becomes one event keyed by bot and update id, routed by chat', () => {
    expect(telegramMessageEvent('p1', '555', { update_id: 9, message })).toEqual({
      id: '9',
      source: 'telegram:555',
      type: 'telegram.message.created',
      time: new Date(1_760_000_000_000).toISOString(),
      subject: '-100123',
      projectId: 'p1',
      data: { message: message as unknown as Record<string, unknown> },
    });
  });

  test('edits, bots and empty updates carry nothing to answer', () => {
    expect(telegramMessageEvent('p1', '555', { update_id: 1, edited_message: message })).toBeNull();
    expect(telegramMessageEvent('p1', '555', { update_id: 2, message: { ...message, from: { id: 1, is_bot: true } } })).toBeNull();
    expect(telegramMessageEvent('p1', '555', { update_id: 3 })).toBeNull();
  });

  test('a forum topic is its own thread', () => {
    expect(telegramThreadId({ ...message, is_topic_message: true, message_thread_id: 5 })).toBe('-100123:5');
    expect(telegramThreadId({ ...message, message_thread_id: 5 })).toBe('-100123');
  });

  test('the prompt tells the agent to answer through the connector, with the chat and reply target', () => {
    const prompt = renderTelegramPrompt(message, 'new');
    expect(prompt).toContain('kortix connectors call kortix_telegram.send_message');
    expect(prompt).toContain('"chat_id":"-100123"');
    expect(prompt).toContain('"reply_parameters":{"message_id":7}');
    expect(prompt).toContain('status?');
  });
});
