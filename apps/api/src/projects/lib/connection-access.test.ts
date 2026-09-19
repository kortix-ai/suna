import { describe, expect, test } from 'bun:test';
import {
  connectionIsReachable,
  isTrustedManagedChannelAuthorization,
} from './connection-access';

const human = {
  actingUserId: 'user-1',
  actingPrincipalIsServiceAccount: false,
};

const serviceAccount = {
  actingUserId: '',
  actingPrincipalIsServiceAccount: true,
};

describe('connection reachability', () => {
  test('a project-owned account is reachable by every principal that may use the connector', () => {
    expect(
      connectionIsReachable({ ownerType: 'project', ownerId: null, ...human }),
    ).toBe(true);
    // The whole point of retiring the strategy flag: an unattended automation
    // now uses the shared account instead of having nothing it can reach.
    expect(
      connectionIsReachable({ ownerType: 'project', ownerId: null, ...serviceAccount }),
    ).toBe(true);
  });

  test('a member-owned account is reachable only by its own owner', () => {
    expect(
      connectionIsReachable({ ownerType: 'member', ownerId: 'user-1', ...human }),
    ).toBe(true);
    expect(
      connectionIsReachable({ ownerType: 'member', ownerId: 'user-2', ...human }),
    ).toBe(false);
  });

  test('a service account never runs as somebody personal account', () => {
    expect(
      connectionIsReachable({
        ownerType: 'member',
        ownerId: 'user-1',
        actingUserId: 'user-1',
        actingPrincipalIsServiceAccount: true,
      }),
    ).toBe(false);
  });

  test('an absent acting user never matches an absent owner', () => {
    // `actingUserId` defaults to '' with no human in context; an owner id that
    // is empty or null must not read as "the caller owns this".
    expect(
      connectionIsReachable({
        ownerType: 'member',
        ownerId: '',
        actingUserId: '',
        actingPrincipalIsServiceAccount: false,
      }),
    ).toBe(false);
    expect(
      connectionIsReachable({
        ownerType: 'member',
        ownerId: null,
        actingUserId: '',
        actingPrincipalIsServiceAccount: false,
      }),
    ).toBe(false);
  });

  test('agent, subject and bare external ownership stay unreachable', () => {
    for (const ownerType of ['agent', 'subject', 'external'] as const) {
      expect(
        connectionIsReachable({ ownerType, ownerId: 'owner-1', ...human }),
      ).toBe(false);
    }
  });

  test('trusted managed email authorizations are the one external exception', () => {
    const managedSystem = isTrustedManagedChannelAuthorization({
      providerType: 'channel',
      platform: 'email',
      ownerType: 'external',
      ownerId: 'agentmail:inbox-1',
      metadata: { channel_connection: true, inbox_id: 'inbox-1' },
    });
    expect(managedSystem).toBe(true);
    expect(
      connectionIsReachable({
        ownerType: 'external',
        ownerId: 'agentmail:inbox-1',
        trustedManagedSystem: managedSystem,
        ...human,
      }),
    ).toBe(true);
  });

  test('generic external metadata cannot activate the managed exception', () => {
    expect(
      isTrustedManagedChannelAuthorization({
        providerType: 'http',
        platform: null,
        ownerType: 'external',
        ownerId: 'agentmail:inbox-1',
        metadata: { channel_connection: true, inbox_id: 'inbox-1' },
      }),
    ).toBe(false);
    expect(
      isTrustedManagedChannelAuthorization({
        providerType: 'channel',
        platform: 'email',
        ownerType: 'external',
        ownerId: 'managed-1',
        metadata: { channel_connection: true, inbox_id: 'inbox-1' },
      }),
    ).toBe(false);
  });
});
