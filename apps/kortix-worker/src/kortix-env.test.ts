import { describe, expect, test } from 'bun:test';
import { toFileErrorCode } from './kortix-env.ts';

// The daemon's env-rpc is a thin fs proxy and reports the real errno. pi's
// tools compare against pi's OWN codes, so this client has to translate.
// Unmapped, `write` could never create a file: withFileMutationQueue
// canonicalises the target first and rethrows anything that is not
// 'not_found', so every new file died on the pre-flight lstat and the agent
// fell back to bash heredocs (observed 10x in one turn on pi.kortix.com).
describe('toFileErrorCode', () => {
  test('ENOENT becomes not_found — the code the file-mutation queue tolerates', () => {
    expect(toFileErrorCode('ENOENT')).toBe('not_found');
  });

  test('mirrors pi harness/env/nodejs.js, spellings included', () => {
    expect(toFileErrorCode('ABORT_ERR')).toBe('aborted');
    expect(toFileErrorCode('EACCES')).toBe('permission_denied');
    expect(toFileErrorCode('EPERM')).toBe('permission_denied');
    // pi spells these without the article; a tool matching 'not_a_directory'
    // would never fire.
    expect(toFileErrorCode('ENOTDIR')).toBe('not_directory');
    expect(toFileErrorCode('EISDIR')).toBe('is_directory');
    expect(toFileErrorCode('EINVAL')).toBe('invalid');
  });

  test('an unmapped errno is unknown, never passed through as an errno', () => {
    // Handing pi a raw 'EMFILE' just moves the same bug to another code path.
    expect(toFileErrorCode('EMFILE')).toBe('unknown');
    expect(toFileErrorCode('ENOSPC')).toBe('unknown');
  });

  test('a code already in pi vocabulary survives, and nothing missing throws', () => {
    expect(toFileErrorCode('not_supported')).toBe('not_supported');
    expect(toFileErrorCode(undefined)).toBe('unknown');
    expect(toFileErrorCode('')).toBe('unknown');
  });
});
