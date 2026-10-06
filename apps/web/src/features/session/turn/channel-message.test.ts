import { describe, expect, test } from 'bun:test';
import { parseChannelMessage, slackChannelNames, slackConversationName } from './channel-message';

// The parser's own tests live with it in `packages/shared/src/channel-message.test.ts`.
test('the session view reads channel messages with the shared parser', () => {
  const info = parseChannelMessage('New message from Alex Kim in the same Teams conversation:\nAnd production?');
  expect(info).toEqual({ platform: 'Teams', context: '', userName: 'Alex Kim', messageText: 'And production?', followUp: true });
});

describe('slackConversationName', () => {
  test('a channel reads #name, a DM its person, a group DM its members', () => {
    expect(slackConversationName({ channelName: 'general', channelType: 'channel' })).toBe('#general');
    expect(slackConversationName({ channelName: 'launch-plan', channelType: 'private_channel' })).toBe('#launch-plan');
    expect(slackConversationName({ channelName: 'Sam Rivera', channelType: 'im' })).toBe('Sam Rivera');
    expect(slackConversationName({ channelName: 'sam, alex', channelType: 'mpim' })).toBe('sam, alex');
  });

  test('a name stored before Slack types were recorded is still a channel', () => {
    expect(slackConversationName({ channelName: 'general', channelType: null })).toBe('#general');
  });

  test('no stored name is no label', () => {
    expect(slackConversationName({ channelName: null, channelType: 'channel' })).toBeNull();
  });
});

describe('slackChannelNames', () => {
  test("maps each named Slack binding's id to its name; skips other platforms and unnamed rows", () => {
    const names = slackChannelNames([
      { platform: 'slack', channelId: 'C0TEST1', channelName: 'general', channelType: 'channel' },
      { platform: 'slack', channelId: 'D0TEST1', channelName: 'Sam Rivera', channelType: 'im' },
      { platform: 'slack', channelId: 'C0TEST2', channelName: null, channelType: null },
      { platform: 'teams', channelId: '19:abc@thread.tacv2', channelName: 'General', channelType: 'channel' },
    ]);
    expect([...names]).toEqual([
      ['C0TEST1', '#general'],
      ['D0TEST1', 'Sam Rivera'],
    ]);
  });
});
