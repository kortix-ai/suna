import { describe, expect, test } from 'bun:test';
import { sunaMigrationGitAuthMethod } from '../projects/suna-migration/suna-migration-phases';

describe('Suna migration Git credential metadata', () => {
  test('writes Nango auth for managed GitHub repositories', () => {
    expect(sunaMigrationGitAuthMethod('github', 'managed-nango-connection')).toBe('nango');
  });

  test('rejects a managed GitHub repository without a Nango connection reference', () => {
    expect(() => sunaMigrationGitAuthMethod('github', null)).toThrow(
      'Managed GitHub migration repository is missing its Nango connection reference.',
    );
    expect(() => sunaMigrationGitAuthMethod('github', '   ')).toThrow(
      'Managed GitHub migration repository is missing its Nango connection reference.',
    );
  });

  test('preserves the managed auth method for non-GitHub backends', () => {
    expect(sunaMigrationGitAuthMethod('code-storage', null)).toBe('managed');
  });
});
