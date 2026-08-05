import { describe, expect, test } from 'bun:test';
import { executorRequestDigest } from './request-digest';

describe('executorRequestDigest', () => {
  test('is stable across object key order', () => {
    expect(
      executorRequestDigest(
        'gmail',
        'send_email',
        {
          subject: 'Invoice',
          to: 'finance@example.com',
        },
        {
          profileId: 'profile-1',
          provider: 'pipedream',
          baseUrl: null,
          binding: { kind: 'pipedream' },
        },
      ),
    ).toBe(
      executorRequestDigest(
        'gmail',
        'send_email',
        {
          to: 'finance@example.com',
          subject: 'Invoice',
        },
        {
          binding: { kind: 'pipedream' },
          baseUrl: null,
          provider: 'pipedream',
          profileId: 'profile-1',
        },
      ),
    );
  });

  test('changes when any authorized argument changes', () => {
    const approved = executorRequestDigest(
      'gmail',
      'send_email',
      {
        to: 'finance@example.com',
        subject: 'Invoice',
      },
      {
        profileId: 'profile-1',
        provider: 'pipedream',
        baseUrl: null,
        binding: { kind: 'pipedream' },
      },
    );
    const changedRecipient = executorRequestDigest(
      'gmail',
      'send_email',
      {
        to: 'outside@example.net',
        subject: 'Invoice',
      },
      {
        profileId: 'profile-1',
        provider: 'pipedream',
        baseUrl: null,
        binding: { kind: 'pipedream' },
      },
    );
    expect(changedRecipient).not.toBe(approved);
  });

  test('changes when the credential profile or action binding changes', () => {
    const args = { to: 'finance@example.com', subject: 'Invoice' };
    const approved = executorRequestDigest('gmail', 'send_email', args, {
      profileId: 'profile-1',
      provider: 'pipedream',
      baseUrl: null,
      binding: { kind: 'pipedream', actionKey: 'send-v1' },
    });
    const changedProfile = executorRequestDigest('gmail', 'send_email', args, {
      profileId: 'profile-2',
      provider: 'pipedream',
      baseUrl: null,
      binding: { kind: 'pipedream', actionKey: 'send-v1' },
    });
    const changedBinding = executorRequestDigest('gmail', 'send_email', args, {
      profileId: 'profile-1',
      provider: 'pipedream',
      baseUrl: null,
      binding: { kind: 'pipedream', actionKey: 'send-v2' },
    });
    expect(changedProfile).not.toBe(approved);
    expect(changedBinding).not.toBe(approved);
  });
});
