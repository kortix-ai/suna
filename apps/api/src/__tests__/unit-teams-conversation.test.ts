import { describe, expect, test } from 'bun:test';
import { describeTeamsConversation } from '../channels/teams/util';

/** The bindings table used to show `19:…@thread.tacv2;messageid=…` for a Teams row. */
describe('describeTeamsConversation', () => {
  test('a channel post reads as team › channel', () => {
    expect(
      describeTeamsConversation({
        conversation: { conversationType: 'channel' },
        channelData: { team: { name: 'Kortix SSO Test' }, channel: { name: 'Opći' } },
      }),
    ).toEqual({ channelName: 'Kortix SSO Test › Opći', channelType: 'channel' });
  });

  test('the General channel arrives without a channel name', () => {
    expect(
      describeTeamsConversation({ conversation: { conversationType: 'channel' }, channelData: { team: { name: 'Eng' } } }),
    ).toEqual({ channelName: 'Eng › General', channelType: 'channel' });
  });

  test('a group chat uses its title, a personal chat the person', () => {
    expect(describeTeamsConversation({ conversation: { conversationType: 'groupChat', name: 'Launch crew' } })).toEqual({
      channelName: 'Launch crew',
      channelType: 'groupChat',
    });
    expect(describeTeamsConversation({ conversation: { conversationType: 'personal' }, from: { name: 'Ivan Bagaric' } })).toEqual({
      channelName: 'Ivan Bagaric',
      channelType: 'personal',
    });
  });
});
