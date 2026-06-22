import { describe, expect, test } from 'bun:test';
import { channelApiBase, channelCatalog, channelLabel } from '../executor/channels';

describe('teams channel catalog', () => {
  test('maps the platform to the Graph base + label', () => {
    expect(channelApiBase('teams')).toBe('https://graph.microsoft.com/v1.0');
    expect(channelLabel('teams')).toBe('Microsoft Teams');
  });

  test('exposes read actions bound to Graph paths', () => {
    const actions = channelCatalog('teams');
    const byPath = Object.fromEntries(actions.map((a) => [a.path, a]));
    expect(Object.keys(byPath).sort()).toEqual(
      ['get_channel', 'get_team', 'get_user', 'list_channels', 'list_members'].sort(),
    );
    const listChannels = byPath.list_channels!;
    expect(listChannels.binding).toEqual({ kind: 'http', method: 'GET', path: '/teams/{team-id}/channels' });
    expect(listChannels.risk).toBe('read');
    expect(channelCatalog('teams').every((a) => a.risk === 'read')).toBe(true);
  });

  test('unknown platform stays empty', () => {
    expect(channelCatalog('discord')).toEqual([]);
    expect(channelApiBase('discord')).toBe('');
  });
});
