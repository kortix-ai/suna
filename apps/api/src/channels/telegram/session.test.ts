import { describe, expect, test } from 'bun:test';
import { config } from '../../config';
import type { TurnErrorInfo } from '../slack/errors';
import { sessionWebUrl } from '../slack/util';
import { renderTelegramPrompt, telegramMessageEvent, telegramNotice, telegramThreadId, type TelegramMessage } from './session';

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

describe('telegram notices for a session (run errors)', () => {
  const target = { platform: 'telegram' as const, workspaceId: '555', threadId: '1', projectId: 'p1' };
  const details = `Details: ${sessionWebUrl(config.FRONTEND_URL, 'p1', 's1')}`;
  const runFailed = (error?: TurnErrorInfo) => telegramNotice(target, { kind: 'run_failed', sessionId: 's1', error });

  const cases: Array<[TurnErrorInfo | undefined, string, string]> = [
    [{ name: 'APIError', statusCode: 402, message: 'Payment Required: Insufficient credits. Balance: -6 credits' }, 'Out of credits', 'A workspace admin can top up credits in Kortix. Then send your message again.'],
    [{ name: 'APIError', statusCode: 429, message: 'rate limited' }, 'Usage limit reached', 'Wait, then send your message again. A project admin can also pick another model in Kortix.'],
    [{ name: 'MessageOutputLengthError', message: '' }, 'Response too long', 'Ask the agent to continue, or narrow the request.'],
    [{ name: 'ContextOverflowError', message: '' }, 'Conversation too long', 'Send /new to start a new conversation.'],
    [{ name: 'APIError', statusCode: 503, message: 'upstream unavailable' }, 'Provider unavailable', 'Send your message again to retry.'],
    [{ name: 'UnknownError', message: 'boom' }, 'Run failed', 'Send your message again, or send /new to start a new conversation.'],
    [undefined, 'Run failed', 'Send your message again, or send /new to start a new conversation.'],
  ];
  for (const [error, title, advice] of cases) {
    test(`${title}: the title, what to do next and the session link, never the provider's text`, () => {
      expect(runFailed(error)).toBe([`Kortix could not finish this run: ${title}.`, advice, details].join('\n'));
      if (error?.message) expect(runFailed(error)).not.toContain(error.message);
    });
  }

  test('a stopped run says nothing', () => {
    expect(runFailed({ name: 'MessageAbortedError', message: '' })).toBeNull();
    expect(runFailed({ name: 'Error', message: '', code: 'aborted' })).toBeNull();
  });

  test('a failed start says so, with the classified reason when there is one, and asks for /new', () => {
    const reason = "Couldn't access the project's Git repository. Check the project's Git credentials and try again.";
    const tail = ['Send /new, then send your message again. If it fails again, a project admin can check the session in Kortix.', details];
    expect(telegramNotice(target, { kind: 'start_failed', sessionId: 's1', reason })).toBe(
      [`Kortix could not start this chat's session, so the agent did not run. ${reason}`, ...tail].join('\n'),
    );
    expect(telegramNotice(target, { kind: 'start_failed', sessionId: 's1', reason: null })).toBe(
      ["Kortix could not start this chat's session, so the agent did not run.", ...tail].join('\n'),
    );
  });

  test('a start the provider may clear says it is retrying, and when to send /new', () => {
    const reason = 'The compute provider is at capacity right now.';
    expect(telegramNotice(target, { kind: 'start_retrying', sessionId: 's1', reason })).toBe(
      [
        `Kortix could not start this chat's session yet. ${reason}`,
        'Kortix tries again automatically for a few minutes. If the agent does not reply, send /new, then send your message again.',
      ].join('\n'),
    );
  });

  test('the inbound notices keep their copy', () => {
    const inbound = { ...target, messageId: '7' };
    expect(telegramNotice(inbound, { kind: 'create_pending' })).toBe('Kortix is still starting a session for this chat. The agent replies here when it is ready.');
    expect(telegramNotice(inbound, { kind: 'follow_up_failed' })).toBe("This chat's Kortix session cannot take new messages. Send /new to start a new conversation, then send your message again.");
  });
});
