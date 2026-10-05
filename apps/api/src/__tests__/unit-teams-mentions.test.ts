import { describe, expect, test } from 'bun:test';
import { conversationScope, isBotMentioned } from '../channels/teams/util';

const BOT = '28:62b4470a-e8e6-4e13-a73f-363de2209dfc';

describe('isBotMentioned', () => {
  test('true when a mention entity names the recipient bot', () => {
    expect(
      isBotMentioned({
        recipient: { id: BOT },
        entities: [{ type: 'mention', mentioned: { id: BOT, name: 'Kortix Dev' }, text: '<at>Kortix Dev</at>' }],
      }),
    ).toBe(true);
  });

  test('false for a mention of someone else, a non-mention entity, or no entities', () => {
    expect(isBotMentioned({ recipient: { id: BOT }, entities: [{ type: 'mention', mentioned: { id: '29:someone' } }] })).toBe(false);
    expect(isBotMentioned({ recipient: { id: BOT }, entities: [{ type: 'clientInfo', locale: 'hr-HR' }] })).toBe(false);
    expect(isBotMentioned({ recipient: { id: BOT } })).toBe(false);
  });
});

describe('conversationScope', () => {
  test('maps Teams conversationType, defaulting to personal', () => {
    expect(conversationScope({ conversation: { conversationType: 'channel' } })).toBe('channel');
    expect(conversationScope({ conversation: { conversationType: 'groupChat' } })).toBe('groupChat');
    expect(conversationScope({ conversation: { conversationType: 'personal' } })).toBe('personal');
    expect(conversationScope({})).toBe('personal');
  });
});
