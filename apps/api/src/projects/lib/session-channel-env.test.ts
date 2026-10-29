import { describe, expect, test } from 'bun:test';
import { sessionChannelEnvFromMetadata, sessionSpaceEnv } from './session-channel-env';

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
      KORTIX_EMAIL_INBOX_ID: 'inbox-1',
      KORTIX_EMAIL_THREAD_ID: 'thread-email-1',
      KORTIX_EMAIL_MESSAGE_ID: 'message-1',
      KORTIX_EMAIL_ADDRESS: 'agent@example.com',
    });
  });

  test('reads legacy email metadata that carries only the inbox', () => {
    expect(sessionChannelEnvFromMetadata({ email: { inbox_id: 'inbox-legacy' } })).toEqual({
      KORTIX_EMAIL_INBOX_ID: 'inbox-legacy',
    });
  });

  test('ignores malformed and non-channel metadata', () => {
    expect(sessionChannelEnvFromMetadata(null)).toEqual({});
    expect(sessionChannelEnvFromMetadata({ email: 'invalid', slack: [] })).toEqual({});
    expect(sessionChannelEnvFromMetadata({ source: 'ui' })).toEqual({});
  });
});

describe('sessionSpaceEnv', () => {
  test('a channel thread: its id, kind and slug', () => {
    expect(sessionSpaceEnv({ spaceId: 'space-1', kind: 'channel', slug: 'launch', dmAgentName: null })).toEqual({
      KORTIX_SPACE_ID: 'space-1',
      KORTIX_SPACE_KIND: 'channel',
      KORTIX_SPACE_SLUG: 'launch',
    });
  });

  test('a DM thread: the agent name stands in for the slug', () => {
    expect(sessionSpaceEnv({ spaceId: 'space-2', kind: 'dm', slug: null, dmAgentName: 'researcher' })).toEqual({
      KORTIX_SPACE_ID: 'space-2',
      KORTIX_SPACE_KIND: 'dm',
      KORTIX_SPACE_SLUG: 'researcher',
    });
  });

  test('no space (or the flag off, which passes null): no variables', () => {
    expect(sessionSpaceEnv(null)).toEqual({});
  });
});
