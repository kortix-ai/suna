import { describe, expect, test } from 'bun:test';
import { SLACK_CHANNEL_CONNECTOR_SLUG, channelCatalog, channelDefaultSlug, withChannelDefaults } from './channels';
import { executeCall } from './call';

describe('channelDefaultSlug', () => {
  test('maps slack to its reserved, non-shadowable slug', () => {
    expect(channelDefaultSlug('slack')).toBe(SLACK_CHANNEL_CONNECTOR_SLUG);
    expect(SLACK_CHANNEL_CONNECTOR_SLUG).not.toBe('slack');
  });
});

describe('Slack curated defaults reach the outgoing request', () => {
  async function sent(actionPath: string, args: Record<string, unknown>) {
    let url = '';
    const action = channelCatalog('slack').find((a) => a.path === actionPath)!;
    await executeCall({
      binding: action.binding,
      baseUrl: 'https://slack.com/api',
      auth: { type: 'bearer' } as never,
      secret: 'xoxb-test',
      args: withChannelDefaults('slack', actionPath, args),
      paramHints: {},
      fetchImpl: (async (u: string) => {
        url = u;
        return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
      }) as never,
    });
    return new URL(url).searchParams;
  }

  test('list_channels {} sends private channels and hides archived', async () => {
    const q = await sent('list_channels', {});
    expect(q.get('exclude_archived')).toBe('true');
    expect(q.get('types')).toBe('public_channel,private_channel');
  });

  test('an explicit arg wins over the default', async () => {
    const q = await sent('list_channels', { exclude_archived: false, types: 'public_channel' });
    expect(q.get('exclude_archived')).toBe('false');
    expect(q.get('types')).toBe('public_channel');
  });

  test('get_history applies limit 20; get_thread and list_users leave Slack's default', async () => {
    expect((await sent('get_history', { channel: 'C1' })).get('limit')).toBe('20');
    expect((await sent('get_history', { channel: 'C1', limit: 5 })).get('limit')).toBe('5');
    expect((await sent('get_thread', { channel: 'C1', ts: '1' })).get('limit')).toBeNull();
    expect((await sent('list_users', {})).get('limit')).toBeNull();
  });

  test('non-slack platforms and http connectors are untouched', () => {
    expect(withChannelDefaults('teams', 'list_channels', {})).toEqual({});
  });
});
