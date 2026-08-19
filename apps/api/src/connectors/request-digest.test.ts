import { describe, expect, test } from 'bun:test';
import { connectorRequestDigest } from './request-digest';

describe('connectorRequestDigest', () => {
  test('is stable across object key order', () => {
    expect(
      connectorRequestDigest(
        'gmail',
        'send_email',
        {
          subject: 'Invoice',
          to: 'finance@example.com',
        },
        {
          connectionId: 'connection-1',
          provider: 'pipedream',
          baseUrl: null,
          binding: { kind: 'pipedream' },
        },
      ),
    ).toBe(
      connectorRequestDigest(
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
          connectionId: 'connection-1',
        },
      ),
    );
  });

  test('changes when any authorized argument changes', () => {
    const approved = connectorRequestDigest(
      'gmail',
      'send_email',
      {
        to: 'finance@example.com',
        subject: 'Invoice',
      },
      {
        connectionId: 'connection-1',
        provider: 'pipedream',
        baseUrl: null,
        binding: { kind: 'pipedream' },
      },
    );
    const changedRecipient = connectorRequestDigest(
      'gmail',
      'send_email',
      {
        to: 'outside@example.net',
        subject: 'Invoice',
      },
      {
        connectionId: 'connection-1',
        provider: 'pipedream',
        baseUrl: null,
        binding: { kind: 'pipedream' },
      },
    );
    expect(changedRecipient).not.toBe(approved);
  });

  test('changes when the credential connection or action binding changes', () => {
    const args = { to: 'finance@example.com', subject: 'Invoice' };
    const approved = connectorRequestDigest('gmail', 'send_email', args, {
      connectionId: 'connection-1',
      provider: 'pipedream',
      baseUrl: null,
      binding: { kind: 'pipedream', actionKey: 'send-v1' },
    });
    const changedConnection = connectorRequestDigest('gmail', 'send_email', args, {
      connectionId: 'connection-2',
      provider: 'pipedream',
      baseUrl: null,
      binding: { kind: 'pipedream', actionKey: 'send-v1' },
    });
    const changedBinding = connectorRequestDigest('gmail', 'send_email', args, {
      connectionId: 'connection-1',
      provider: 'pipedream',
      baseUrl: null,
      binding: { kind: 'pipedream', actionKey: 'send-v2' },
    });
    expect(changedConnection).not.toBe(approved);
    expect(changedBinding).not.toBe(approved);
  });
});
