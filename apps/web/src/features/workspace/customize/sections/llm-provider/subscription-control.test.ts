import { describe, expect, test } from 'bun:test';
import { subscriptionIsConnected, subscriptionPrimaryAction } from './subscription-control';

describe('subscriptionIsConnected', () => {
  test('sees the current credential', () => {
    expect(subscriptionIsConnected(['CODEX_AUTH_JSON'])).toBe(true);
  });

  // Projects connected before the rename still hold the legacy name, and they
  // are exactly the long-lived ones a user would now be trying to disconnect.
  test('sees the legacy credential', () => {
    expect(subscriptionIsConnected(['OPENCODE_AUTH_JSON'])).toBe(true);
  });

  test('an API key alone is NOT a subscription', () => {
    expect(subscriptionIsConnected(['OPENAI_API_KEY'])).toBe(false);
    expect(subscriptionIsConnected([])).toBe(false);
  });
});

describe('subscriptionPrimaryAction', () => {
  // The defect: a connected subscription offered "Connect" forever and could
  // never be removed from any surface in the product.
  test('a connected subscription offers DISCONNECT', () => {
    expect(subscriptionPrimaryAction({ connected: true, failed: false })).toBe('disconnect');
  });

  test('nothing connected offers CONNECT', () => {
    expect(subscriptionPrimaryAction({ connected: false, failed: false })).toBe('connect');
  });

  test('a failed attempt offers RECONNECT even when a credential is on file', () => {
    expect(subscriptionPrimaryAction({ connected: true, failed: true })).toBe('reconnect');
    expect(subscriptionPrimaryAction({ connected: false, failed: true })).toBe('reconnect');
  });
});
