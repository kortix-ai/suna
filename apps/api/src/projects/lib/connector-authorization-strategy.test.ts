import { describe, expect, test } from 'bun:test';
import {
  connectorAuthorizationMatchesStrategy,
  isTrustedManagedChannelAuthorization,
} from './connector-authorization-strategy';

describe('connector authorization strategy', () => {
  test('project strategy accepts only project ownership', () => {
    expect(
      connectorAuthorizationMatchesStrategy({
        strategy: 'project',
        ownerType: 'project',
        ownerId: null,
        actingUserId: 'user-1',
        actingPrincipalIsServiceAccount: false,
      }),
    ).toBe(true);
    expect(
      connectorAuthorizationMatchesStrategy({
        strategy: 'project',
        ownerType: 'member',
        ownerId: 'user-1',
        actingUserId: 'user-1',
        actingPrincipalIsServiceAccount: false,
      }),
    ).toBe(false);
  });

  test('user strategy accepts only the acting human authorization', () => {
    expect(
      connectorAuthorizationMatchesStrategy({
        strategy: 'user',
        ownerType: 'member',
        ownerId: 'user-1',
        actingUserId: 'user-1',
        actingPrincipalIsServiceAccount: false,
      }),
    ).toBe(true);
    expect(
      connectorAuthorizationMatchesStrategy({
        strategy: 'user',
        ownerType: 'member',
        ownerId: 'user-2',
        actingUserId: 'user-1',
        actingPrincipalIsServiceAccount: false,
      }),
    ).toBe(false);
    expect(
      connectorAuthorizationMatchesStrategy({
        strategy: 'user',
        ownerType: 'member',
        ownerId: 'user-1',
        actingUserId: 'user-1',
        actingPrincipalIsServiceAccount: true,
      }),
    ).toBe(false);
  });

  test('management capability does not bypass strategy', () => {
    expect(
      connectorAuthorizationMatchesStrategy({
        strategy: 'user',
        ownerType: 'project',
        ownerId: null,
        actingUserId: 'manager-1',
        actingPrincipalIsServiceAccount: false,
      }),
    ).toBe(false);
    expect(
      connectorAuthorizationMatchesStrategy({
        strategy: 'project',
        ownerType: 'external',
        ownerId: 'managed-1',
        actingUserId: 'manager-1',
        actingPrincipalIsServiceAccount: false,
      }),
    ).toBe(false);
  });

  test('trusted managed email authorizations are an explicit project exception', () => {
    const managedSystem = isTrustedManagedChannelAuthorization({
      providerType: 'channel',
      platform: 'email',
      ownerType: 'external',
      ownerId: 'agentmail:inbox-1',
      metadata: {
        channel_profile: true,
        inbox_id: 'inbox-1',
      },
    });
    expect(managedSystem).toBe(true);
    expect(
      connectorAuthorizationMatchesStrategy({
        strategy: 'project',
        ownerType: 'external',
        ownerId: 'agentmail:inbox-1',
        actingUserId: 'user-1',
        actingPrincipalIsServiceAccount: false,
        trustedManagedSystem: managedSystem,
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
        metadata: {
          channel_profile: true,
          inbox_id: 'inbox-1',
        },
      }),
    ).toBe(false);
    expect(
      isTrustedManagedChannelAuthorization({
        providerType: 'channel',
        platform: 'email',
        ownerType: 'external',
        ownerId: 'managed-1',
        metadata: {
          channel_profile: true,
          inbox_id: 'inbox-1',
        },
      }),
    ).toBe(false);
  });
});
