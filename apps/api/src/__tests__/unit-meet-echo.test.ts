import { describe, expect, test } from 'bun:test';
import { isBotEcho, recordBotSpeech } from '../channels/meet-echo';
import { isSelfEcho } from '../channels/meet-webhook';

describe('meet self-echo suppression (the bot hearing itself)', () => {
  test('exact match catches short acknowledgement clips', () => {
    recordBotSpeech('bot1', 'Sure. One Sec.');
    expect(isBotEcho('bot1', 'Sure. One Sec.')).toBe(true);
    expect(isBotEcho('bot1', 'sure one sec')).toBe(true);
  });

  test('fuzzy match catches a reply the captions slightly mangle', () => {
    recordBotSpeech('bot2', 'No rush, take your time.');
    expect(isBotEcho('bot2', 'No rush take your time on it.')).toBe(true);
  });

  test('catches a truncated, mis-heard fragment of a longer reply (the real failure)', () => {
    recordBotSpeech(
      'bot2b',
      "Hi Saumya, I'm the Kortix Notetaker, an AI assistant that joins meetings to capture notes and summarize.",
    );
    expect(
      isBotEcho('bot2b', "Hi Saumya. I'm cortex. Notetaker an AI assistant that joins meetings to capture"),
    ).toBe(true);
  });

  test('does not flag unrelated speech, or a longer line that merely contains a short ack', () => {
    recordBotSpeech('bot3', 'On it.');
    expect(isBotEcho('bot3', "what's the migration status")).toBe(false);
    expect(isBotEcho('bot3', 'i am on it now and still working')).toBe(false);
  });

  test('echoes are isolated per bot', () => {
    recordBotSpeech('botA', 'Let me look that up for you.');
    expect(isBotEcho('botB', 'Let me look that up for you.')).toBe(false);
  });
});

describe('isSelfEcho', () => {
  test("drops the bot's own chat message by sender name", () => {
    expect(isSelfEcho('botX', 'Kortix Notetaker', { speaker: 'Kortix Notetaker', text: 'hi' })).toBe(true);
    expect(isSelfEcho('botX', 'Kortix Notetaker', { speaker: 'Saumya', text: 'hi' })).toBe(false);
  });

  test('drops the bot transcribed speaking itself (content echo)', () => {
    recordBotSpeech('botY', 'Welcome everyone, glad to be here.');
    expect(isSelfEcho('botY', 'Kortix', { speaker: 'Unknown', text: 'Welcome everyone glad to be here' })).toBe(true);
  });
});
