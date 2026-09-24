import { describe, expect, test } from 'bun:test';
import { accountHubUrl } from './web-account-links';

describe('accountHubUrl', () => {
  test('builds the members tab url', () => {
    expect(accountHubUrl('https://kortix.com', 'acc-1', 'members')).toBe(
      'https://kortix.com/projects?accountId=acc-1&accountTab=members'
    );
  });

  test('builds every valid tab', () => {
    for (const tab of ['members', 'groups', 'git', 'audit'] as const) {
      expect(accountHubUrl('https://kortix.com', 'acc-1', tab)).toBe(
        `https://kortix.com/projects?accountId=acc-1&accountTab=${tab}`
      );
    }
  });

  test('strips a trailing slash from the frontend url', () => {
    expect(accountHubUrl('https://kortix.com/', 'acc-1', 'git')).toBe(
      'https://kortix.com/projects?accountId=acc-1&accountTab=git'
    );
  });

  test('encodes the account id', () => {
    expect(accountHubUrl('https://kortix.com', 'acc 1/2', 'audit')).toBe(
      'https://kortix.com/projects?accountId=acc%201%2F2&accountTab=audit'
    );
  });
});
