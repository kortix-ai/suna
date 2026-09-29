/**
 * The call route's HTTP status for a gateway `error`. Computer states the owner
 * controls (access, offline, unpaired) are expected outcomes, not server
 * faults: a 5xx invites clients to retry, and each retry re-prompts the owner.
 */
import { describe, expect, test } from 'bun:test';
import { connectorErrorHttpStatus } from '../connectors/router';

describe('connectorErrorHttpStatus()', () => {
  test('access refusals are 403', () => {
    for (const kind of ['computer_access_pending', 'computer_access_denied', 'computer_access_off', 'computer_capability_not_approved']) {
      expect(connectorErrorHttpStatus(`${kind}: text`)).toBe(403);
    }
  });

  test('machine state is 409', () => {
    expect(connectorErrorHttpStatus('computer_offline: Mac is offline')).toBe(409);
    expect(connectorErrorHttpStatus('computer_unpaired: pair again')).toBe(409);
  });

  test('everything else stays 500', () => {
    expect(connectorErrorHttpStatus('upstream exploded')).toBe(500);
    expect(connectorErrorHttpStatus('computer_something_new: x')).toBe(500);
  });
});
