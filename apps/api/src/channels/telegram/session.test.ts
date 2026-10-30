import { describe, expect, test } from 'bun:test';
import { channelPromptText, parseChannelMessage } from '@kortix/shared';
import { config } from '../../config';
import type { TurnErrorInfo } from '../slack/errors';
import { sessionWebUrl } from '../slack/util';
import { telegramEnvelope, telegramFileOf, telegramMessageEvent, telegramNotice, telegramQuestionText, telegramThreadId, type TelegramMessage } from './session';

const message: TelegramMessage = {
  message_id: 7,
  date: 1_760_000_000,
  chat: { id: -100123, type: 'supergroup' },
  from: { id: 42, username: 'synthetic_user' },
  text: 'status?',
};

describe('telegram inbox envelope', () => {
  test('a message becomes one event keyed by bot and update id, routed and ordered by chat', () => {
    expect(telegramMessageEvent('p1', '555', { update_id: 9, message })).toEqual({
      id: '9',
      source: 'telegram:555',
      type: 'telegram.message.created',
      time: new Date(1_760_000_000_000).toISOString(),
      subject: '-100123',
      sequence: 9,
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
    const prompt = channelPromptText(telegramEnvelope(message));
    expect(prompt).toContain('kortix connectors call kortix_telegram.send_message');
    expect(prompt).toContain('"chat_id":"-100123"');
    expect(prompt).toContain('"reply_parameters":{"message_id":7}');
    expect(prompt).toContain('status?');
    // Every Kortix command, not only /new: the agent must not offer one it never receives.
    expect(prompt).toContain('Kortix answers /new, /stop, /status, /model, /agent and /help in the chat itself; those commands never reach you.');
  });

  test("the session view reads the prompt back as the person's message (the shared channel parser)", () => {
    expect(parseChannelMessage(channelPromptText(telegramEnvelope(message)))).toEqual({
      platform: 'Telegram',
      context: 'chat -100123',
      userName: '@synthetic_user',
      messageText: 'status?',
      followUp: false,
    });
    expect(parseChannelMessage(channelPromptText(telegramEnvelope({ ...message, text: 'next\n\nline' })))).toEqual({
      platform: 'Telegram',
      context: 'chat -100123',
      userName: '@synthetic_user',
      messageText: 'next\n\nline',
      followUp: false,
    });
  });
});

describe('telegram files', () => {
  const { text: _text, ...bare } = message;
  const photo: TelegramMessage = {
    ...bare,
    photo: [
      { file_id: 'ph-small', width: 90, height: 90 },
      { file_id: 'ph-big', width: 1280, height: 960, file_size: 120_000 },
    ],
  };
  const voice: TelegramMessage = { ...bare, voice: { file_id: 'v1', duration: 7, mime_type: 'audio/ogg; codecs=opus' } };
  const report: TelegramMessage = { ...bare, document: { file_id: 'd1', file_name: 'report.pdf', mime_type: 'application/pdf' } };
  const sticker: TelegramMessage = { ...bare, sticker: { emoji: '👍' } };
  const event = (m: object) => telegramMessageEvent('p1', '555', { update_id: 9, message: m as TelegramMessage });

  test('a photo or a sticker with no text is stored; a join, a pin and a location store nothing', () => {
    expect(event(photo)?.data.message).toEqual(photo as unknown as Record<string, unknown>);
    expect(event(sticker)).not.toBeNull();
    expect(event({ ...bare, new_chat_members: [{ id: 5 }] })).toBeNull();
    expect(event({ ...bare, pinned_message: { message_id: 3 } })).toBeNull();
    expect(event({ ...bare, location: { latitude: 1, longitude: 2 } })).toBeNull();
  });

  test("the largest photo by area, in either order; the message's own file, never a quoted one", () => {
    expect(telegramFileOf(photo)?.ref.file_id).toBe('ph-big');
    expect(telegramFileOf({ ...photo, photo: [...photo.photo!].reverse() })?.ref.file_id).toBe('ph-big');
    expect(telegramFileOf({ ...message, reply_to_message: photo } as TelegramMessage)).toBeNull();
    expect(telegramFileOf(sticker)).toBeNull();
  });

  test('an animation is read once, as its document; a missing name and type get the defaults', () => {
    const gif = { ...bare, animation: { file_id: 'a1', file_name: 'loop.mp4', mime_type: 'video/mp4' }, document: { file_id: 'a1', file_name: 'loop.mp4', mime_type: 'video/mp4' } };
    expect(telegramFileOf(gif as TelegramMessage)).toEqual({ ref: gif.document, kind: 'document', name: 'loop.mp4', mime: 'video/mp4', label: 'file loop.mp4' });
    expect(telegramFileOf(photo)).toEqual({ ref: photo.photo![1], kind: 'photo', mime: 'image/jpeg', label: 'photo' });
    expect(telegramFileOf({ ...bare, document: { file_id: 'd2' } })).toMatchObject({ kind: 'document', mime: 'application/octet-stream', label: 'document' });
    expect(telegramFileOf({ ...bare, voice: { file_id: 'v2' } })).toMatchObject({ kind: 'voice message', mime: 'audio/ogg', label: 'voice message' });
    expect(telegramFileOf({ ...bare, video_note: { file_id: 'n1', duration: 3 } })).toMatchObject({ kind: 'video message', mime: 'video/mp4', label: 'video message, 3 s' });
  });

  test('a message with no text reads as its file or sticker; a caption leads; an album item says so', () => {
    const text = (m: TelegramMessage) => telegramEnvelope(m).text;
    expect(text(photo)).toBe('(photo)');
    expect(text(report)).toBe('(file report.pdf)');
    expect(text(voice)).toBe('(voice message, 7 s)');
    expect(text(sticker)).toBe('(sticker 👍)');
    expect(text({ ...photo, caption: 'what is this?' })).toBe('what is this?');
    // A named file keeps its name under the caption: the agent may need it, and it stays in the sender's text.
    expect(text({ ...report, caption: 'which year is this?' })).toBe('which year is this?\n(file report.pdf)');
    const album = 'This message is one item of an album. Telegram sends each item as its own message, and usually only the first carries the caption.';
    expect(telegramEnvelope({ ...photo, media_group_id: 'g1' }).notes).toContain(album);
    expect(telegramEnvelope(photo).notes).not.toContain(album);
    expect(parseChannelMessage(channelPromptText(telegramEnvelope(photo)))?.messageText).toBe('(photo)');
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

describe('telegram question text', () => {
  test('a question shows its header, its numbered options and the footer, and always fits one message', () => {
    const text = telegramQuestionText(
      [{ header: 'Pick', question: 'Which database?', options: [{ label: 'Postgres', description: 'managed' }, { label: 'SQLite', description: '' }] }],
      'Tap an option.',
    );
    expect(text).toBe('Pick: Which database?\n1. Postgres — managed\n2. SQLite\n\nTap an option.');
    const long = telegramQuestionText(
      [{ header: '', question: 'q'.repeat(10_000), options: [{ label: 'l'.repeat(300), description: '' }] }],
      'f'.repeat(300),
    );
    expect(long.length).toBeLessThanOrEqual(4096);
    expect(long).toEndWith('f'.repeat(190));
    // An emoji across the limit is dropped whole: a lone surrogate fails the Bot API call.
    const emoji = telegramQuestionText([{ header: '', question: `${'q'.repeat(3_899)}😀`, options: [] }], `${'f'.repeat(189)}😀`);
    expect(emoji).toBe(`${'q'.repeat(3_899)}\n\n${'f'.repeat(189)}`);
  });
});
