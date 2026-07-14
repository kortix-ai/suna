import { afterEach, describe, expect, test } from 'bun:test';
import {
  buildTelegramWebhookUrl,
  inlineKeyboardMarkup,
  isValidTelegramBotToken,
  redactToken,
  setMessageReactionPayload,
  telegramApiBase,
  telegramBotIdFromToken,
} from './telegram-api';

// A realistic-shaped (but fake) BotFather token for the tests.
const TOKEN = '1234567890:AAF0eXaMpLeToKeNBoDy_1234-abcdEFGHijk';

describe('isValidTelegramBotToken', () => {
  test('accepts the BotFather shape <digits>:<35ish url-safe chars>', () => {
    expect(isValidTelegramBotToken(TOKEN)).toBe(true);
  });

  test('rejects everything that is not a bot token', () => {
    expect(isValidTelegramBotToken('')).toBe(false);
    expect(isValidTelegramBotToken('xoxb-slack-token-shape')).toBe(false);
    expect(isValidTelegramBotToken('1234567890')).toBe(false); // no secret part
    expect(isValidTelegramBotToken(':AAF0eXaMpLeToKeNBoDy_1234-abcdEFGHijk')).toBe(false); // no bot id
    expect(isValidTelegramBotToken('abc:AAF0eXaMpLeToKeNBoDy_1234-abcdEFGHijk')).toBe(false); // non-numeric id
    expect(isValidTelegramBotToken('1234567890:short')).toBe(false); // secret too short
    expect(isValidTelegramBotToken(`1234567890:${'x'.repeat(80)}`)).toBe(false); // secret too long
  });
});

describe('telegramBotIdFromToken', () => {
  test('extracts the numeric id before the colon', () => {
    expect(telegramBotIdFromToken(TOKEN)).toBe('1234567890');
  });

  test('returns null for malformed tokens', () => {
    expect(telegramBotIdFromToken('not-a-token')).toBeNull();
    expect(telegramBotIdFromToken('')).toBeNull();
  });
});

describe('buildTelegramWebhookUrl', () => {
  test('joins base origin and project id on the public webhook path', () => {
    expect(buildTelegramWebhookUrl('https://api.kortix.com', 'proj-1')).toBe(
      'https://api.kortix.com/v1/webhooks/telegram/proj-1',
    );
  });

  test('tolerates trailing slashes on the base', () => {
    expect(buildTelegramWebhookUrl('https://api.kortix.com///', 'proj-1')).toBe(
      'https://api.kortix.com/v1/webhooks/telegram/proj-1',
    );
  });
});

describe('redactToken', () => {
  test('strips the token out of Bot API URLs destined for logs', () => {
    const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
    expect(redactToken(url)).toBe('https://api.telegram.org/bot<redacted>/sendMessage');
    expect(redactToken(url)).not.toContain(TOKEN);
  });

  test('leaves token-free text untouched', () => {
    expect(redactToken('plain log line')).toBe('plain log line');
  });
});

describe('telegramApiBase', () => {
  afterEach(() => {
    delete process.env.KORTIX_TELEGRAM_API_BASE;
  });

  test('defaults to the real Bot API', () => {
    delete process.env.KORTIX_TELEGRAM_API_BASE;
    expect(telegramApiBase()).toBe('https://api.telegram.org');
  });

  test('honors the e2e stub override, read per call, trailing slash trimmed', () => {
    process.env.KORTIX_TELEGRAM_API_BASE = 'http://127.0.0.1:4567/';
    expect(telegramApiBase()).toBe('http://127.0.0.1:4567');
  });
});

describe('inlineKeyboardMarkup', () => {
  test('undefined when there are no buttons and no keyboard', () => {
    expect(inlineKeyboardMarkup({})).toBeUndefined();
    expect(inlineKeyboardMarkup({ buttons: [] })).toBeUndefined();
    expect(inlineKeyboardMarkup({ keyboard: [] })).toBeUndefined();
  });

  test('a single `buttons` row becomes one keyboard row', () => {
    const markup = inlineKeyboardMarkup({ buttons: [{ text: 'Open', url: 'https://k.x' }] });
    expect(markup).toEqual({ inline_keyboard: [[{ text: 'Open', url: 'https://k.x' }]] });
  });

  test('serializes callback buttons to callback_data (not url)', () => {
    const markup = inlineKeyboardMarkup({
      keyboard: [
        [{ text: 'Yes', callbackData: 'kxq:0:0' }],
        [{ text: 'No', callbackData: 'kxq:0:1' }],
      ],
    });
    expect(markup).toEqual({
      inline_keyboard: [
        [{ text: 'Yes', callback_data: 'kxq:0:0' }],
        [{ text: 'No', callback_data: 'kxq:0:1' }],
      ],
    });
  });

  test('explicit `keyboard` rows take precedence over `buttons`', () => {
    const markup = inlineKeyboardMarkup({
      buttons: [{ text: 'ignored', url: 'https://x' }],
      keyboard: [[{ text: 'A', callbackData: 'kxq:0:0' }]],
    });
    expect(markup).toEqual({ inline_keyboard: [[{ text: 'A', callback_data: 'kxq:0:0' }]] });
  });

  test('mixes url and callback buttons within a keyboard', () => {
    const markup = inlineKeyboardMarkup({
      keyboard: [
        [
          { text: 'Pick', callbackData: 'kxq:0:0' },
          { text: 'Docs', url: 'https://d.x' },
        ],
      ],
    });
    expect(markup?.inline_keyboard[0]).toEqual([
      { text: 'Pick', callback_data: 'kxq:0:0' },
      { text: 'Docs', url: 'https://d.x' },
    ]);
  });
});

describe('setMessageReactionPayload', () => {
  test('sets a single emoji reaction', () => {
    expect(setMessageReactionPayload(42, 7, '👀')).toEqual({
      chat_id: 42,
      message_id: 7,
      reaction: [{ type: 'emoji', emoji: '👀' }],
    });
  });

  test('null clears the reaction (empty set)', () => {
    expect(setMessageReactionPayload(42, 7, null)).toEqual({
      chat_id: 42,
      message_id: 7,
      reaction: [],
    });
  });
});
