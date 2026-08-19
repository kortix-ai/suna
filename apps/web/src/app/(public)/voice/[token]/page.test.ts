import { describe, expect, test } from 'bun:test';
import { isJoinLinkToken } from './page';

describe('isJoinLinkToken', () => {
  test('true for the short, server-resolved join-link token scheme', () => {
    expect(isJoinLinkToken('vjl_abc123')).toBe(true);
  });

  test('false for a legacy raw LiveKit JWT path segment', () => {
    expect(isJoinLinkToken('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMSJ9.signature')).toBe(false);
  });

  test('false for an empty segment', () => {
    expect(isJoinLinkToken('')).toBe(false);
  });
});
