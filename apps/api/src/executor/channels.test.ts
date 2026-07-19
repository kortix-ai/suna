import { describe, expect, test } from 'bun:test';
import {
  SLACK_CHANNEL_CONNECTOR_SLUG,
  channelDefaultSlug,
  connectorListNeedsResync,
} from './channels';

describe('connectorListNeedsResync', () => {
  test('reconciles when the connector set is empty', () => {
    expect(connectorListNeedsResync({ presentSlugs: [], slackInstalled: false })).toBe(true);
    expect(connectorListNeedsResync({ presentSlugs: [], slackInstalled: true })).toBe(true);
  });

  test('heals a Slack install whose channel connector row went missing', () => {
    // The regression: Slack installed, other connectors present, but no
    // kortix_slack row (connector was never synthesized) → must reconcile.
    expect(
      connectorListNeedsResync({ presentSlugs: ['github'], slackInstalled: true }),
    ).toBe(true);
  });

  test('does not reconcile a healthy project', () => {
    expect(
      connectorListNeedsResync({ presentSlugs: ['github'], slackInstalled: false }),
    ).toBe(false);
    expect(
      connectorListNeedsResync({
        presentSlugs: ['github', SLACK_CHANNEL_CONNECTOR_SLUG],
        slackInstalled: true,
      }),
    ).toBe(false);
    expect(
      connectorListNeedsResync({
        presentSlugs: [SLACK_CHANNEL_CONNECTOR_SLUG],
        slackInstalled: true,
      }),
    ).toBe(false);
  });
});

describe('channelDefaultSlug', () => {
  test('maps slack to its reserved, non-shadowable slug', () => {
    expect(channelDefaultSlug('slack')).toBe(SLACK_CHANNEL_CONNECTOR_SLUG);
    expect(SLACK_CHANNEL_CONNECTOR_SLUG).not.toBe('slack');
  });
});
