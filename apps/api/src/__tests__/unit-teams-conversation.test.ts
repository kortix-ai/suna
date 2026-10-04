import { describe, expect, test } from 'bun:test';
import { describeTeamsConversation, isTeamsChannelThreadId, teamsChannelRoot } from '../services/channels/teams/util';

const TEAM = '19:team-root@thread.tacv2';

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

  test('the General channel arrives without a channel name: its id is the team id', () => {
    expect(
      describeTeamsConversation({
        conversation: { conversationType: 'channel', id: `${TEAM};messageid=1700000000001` },
        channelData: { team: { id: TEAM, name: 'Eng' }, channel: { id: TEAM } },
      }),
    ).toEqual({ channelName: 'Eng › General', channelType: 'channel' });
    // Without `channelData.channel`, the thread's own id names the channel.
    expect(
      describeTeamsConversation({
        conversation: { conversationType: 'channel', id: `${TEAM};messageid=1700000000001` },
        channelData: { team: { id: TEAM, name: 'Eng' } },
      }),
    ).toEqual({ channelName: 'Eng › General', channelType: 'channel' });
  });

  test('another channel without a name is not called General', () => {
    expect(
      describeTeamsConversation({
        conversation: { conversationType: 'channel', id: '19:design@thread.tacv2;messageid=1700000000002' },
        channelData: { team: { id: TEAM, name: 'Eng' }, channel: { id: '19:design@thread.tacv2' } },
      }),
    ).toEqual({ channelType: 'channel' });
  });

  test('a channel post without the team name names nothing: a bare channel would overwrite `Team › Channel`', () => {
    expect(
      describeTeamsConversation({
        conversation: { conversationType: 'channel', id: `${TEAM};messageid=1700000000003` },
        channelData: { team: { id: TEAM }, channel: { id: TEAM, name: 'General' } },
      }),
    ).toEqual({ channelType: 'channel' });
  });

  test('a group chat uses its title, a personal chat the person', () => {
    expect(describeTeamsConversation({ conversation: { conversationType: 'groupChat', name: 'Launch crew' } })).toEqual({
      channelName: 'Launch crew',
      channelType: 'groupChat',
    });
    expect(describeTeamsConversation({ conversation: { conversationType: 'personal' }, from: { name: 'Alex Kim' } })).toEqual({
      channelName: 'Alex Kim',
      channelType: 'personal',
    });
  });
});

describe('Teams conversation ids', () => {
  test('a channel thread is `19:…;messageid=…`; its channel is the part before `;`', () => {
    expect(isTeamsChannelThreadId(`${TEAM};messageid=1700000000001`)).toBe(true);
    expect(isTeamsChannelThreadId('19:chat@thread.v2')).toBe(false);
    expect(isTeamsChannelThreadId('a:1personal')).toBe(false);
    expect(teamsChannelRoot({ conversation: { id: `${TEAM};messageid=1700000000001` } })).toBe(TEAM);
    expect(teamsChannelRoot({ channelData: { channel: { id: '19:design@thread.tacv2' } } })).toBe('19:design@thread.tacv2');
  });
});
