import { describe, expect, test } from 'bun:test';

import { credentialWriteTarget, oauth2DiscoveryConnectionKey } from './connector-credential-target';

describe('SetCredentialModal — where a credential is written', () => {
  test('a selected shared account is written through its own connection', () => {
    expect(credentialWriteTarget('project', 'conn_work')).toEqual({
      kind: 'connection',
      connectionId: 'conn_work',
    });
  });

  test('a selected personal account is written through its own connection', () => {
    expect(credentialWriteTarget('me', 'conn_mine')).toEqual({
      kind: 'connection',
      connectionId: 'conn_mine',
    });
  });

  test('a personal account not created yet is resolved first', () => {
    expect(credentialWriteTarget('me', null)).toEqual({ kind: 'resolve-connection' });
  });

  test("with no account selected, a shared credential goes to the connector's default slot", () => {
    expect(credentialWriteTarget('project', null)).toEqual({ kind: 'connector-default' });
  });
});

describe('SetCredentialModal — OAuth2 discovery cache identity', () => {
  test('two connections of one connector never share a discovery entry', () => {
    expect(oauth2DiscoveryConnectionKey('project', 'conn_a')).not.toBe(
      oauth2DiscoveryConnectionKey('project', 'conn_b'),
    );
  });

  test('an account not created yet is keyed by owner, so shared and personal differ', () => {
    expect(oauth2DiscoveryConnectionKey('project', null)).not.toBe(
      oauth2DiscoveryConnectionKey('me', null),
    );
    expect(oauth2DiscoveryConnectionKey('me', null)).not.toBe(
      oauth2DiscoveryConnectionKey('me', 'conn_a'),
    );
  });
});
