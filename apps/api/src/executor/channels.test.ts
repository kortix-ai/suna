import { describe, expect, test } from 'bun:test';
import { SLACK_CHANNEL_CONNECTOR_SLUG, channelDefaultSlug } from './channels';

describe('channelDefaultSlug', () => {
  test('maps slack to its reserved, non-shadowable slug', () => {
    expect(channelDefaultSlug('slack')).toBe(SLACK_CHANNEL_CONNECTOR_SLUG);
    expect(SLACK_CHANNEL_CONNECTOR_SLUG).not.toBe('slack');
  });
});
