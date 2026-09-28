import { describe, expect, test } from 'bun:test';
import { loginCommand } from './connect-mcp-modal';

describe('loginCommand', () => {
  test('Kortix Cloud uses the CLI default host', () => {
    expect(loginCommand('https://api.kortix.com/v1')).toBe('kortix login');
    expect(loginCommand(undefined)).toBe('kortix login');
  });

  test('any other deployment names its API origin as a host', () => {
    expect(loginCommand('https://dev-api.kortix.com/v1')).toBe(
      'kortix login --host dev-api.kortix.com --api https://dev-api.kortix.com',
    );
    expect(loginCommand('http://localhost:8008/v1')).toBe(
      'kortix login --host localhost --api http://localhost:8008',
    );
  });
});
