import { describe, expect, test } from 'bun:test';
import { sessionChannelEnvFromMetadata } from './session-channel-env';

describe('sessionChannelEnvFromMetadata', () => {
  test('restores Slack and email runtime bindings for a cold reprovision', () => {
    expect(
      sessionChannelEnvFromMetadata({
        slack: {
          team_id: 'team-1',
          channel: 'channel-1',
          thread_ts: 'thread-1',
          user: 'user-1',
        },
        email: {
          inbox_id: 'inbox-1',
          thread_id: 'thread-email-1',
          message_id: 'message-1',
          address: 'agent@example.com',
        },
      }),
    ).toEqual({
      SLACK_TEAM_ID: 'team-1',
      SLACK_CHANNEL_ID: 'channel-1',
      SLACK_THREAD_TS: 'thread-1',
      SLACK_USER_ID: 'user-1',
      KORTIX_CONNECTORS_MCP_ENABLED: '1',
      KORTIX_EMAIL_INBOX_ID: 'inbox-1',
      KORTIX_EMAIL_THREAD_ID: 'thread-email-1',
      KORTIX_EMAIL_MESSAGE_ID: 'message-1',
      KORTIX_EMAIL_ADDRESS: 'agent@example.com',
    });
  });

  test('uses legacy email metadata as the MCP upgrade marker', () => {
    expect(sessionChannelEnvFromMetadata({ email: { inbox_id: 'inbox-legacy' } })).toEqual({
      KORTIX_CONNECTORS_MCP_ENABLED: '1',
      KORTIX_EMAIL_INBOX_ID: 'inbox-legacy',
    });
  });

  test('ignores malformed and non-channel metadata', () => {
    expect(sessionChannelEnvFromMetadata(null)).toEqual({});
    expect(sessionChannelEnvFromMetadata({ email: 'invalid', slack: [] })).toEqual({});
    expect(sessionChannelEnvFromMetadata({ source: 'ui' })).toEqual({});
  });
});
