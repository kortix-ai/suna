/**
 * Unit tests for the git proxy's pure parsing/scoping helpers.
 */
import { describe, expect, test } from 'bun:test';
import {
  extractToken,
  normalizeProjectId,
  scopeForService,
} from '../git-proxy/parse';

describe('normalizeProjectId', () => {
  test('strips a trailing .git', () => {
    expect(normalizeProjectId('abc-123.git')).toBe('abc-123');
    expect(normalizeProjectId('abc-123')).toBe('abc-123');
    expect(normalizeProjectId('abc.GIT')).toBe('abc');
  });
});

describe('extractToken', () => {
  test('Bearer', () => {
    expect(extractToken('Bearer kortix_abc')).toBe('kortix_abc');
    expect(extractToken('bearer kortix_abc')).toBe('kortix_abc');
  });

  test('Basic — token in the password slot (x-access-token username)', () => {
    const header = `Basic ${Buffer.from('x-access-token:kortix_sb_xyz').toString('base64')}`;
    expect(extractToken(header)).toBe('kortix_sb_xyz');
  });

  test('Basic — any username is accepted, password is the token', () => {
    const header = `Basic ${Buffer.from('git:kortix_pat_9').toString('base64')}`;
    expect(extractToken(header)).toBe('kortix_pat_9');
  });

  test('Basic — password-only (no colon)', () => {
    const header = `Basic ${Buffer.from('kortix_only').toString('base64')}`;
    expect(extractToken(header)).toBe('kortix_only');
  });

  test('missing / malformed', () => {
    expect(extractToken(undefined)).toBeNull();
    expect(extractToken('')).toBeNull();
    expect(extractToken('Basic')).toBeNull();
    expect(extractToken('Digest foo')).toBeNull();
  });
});

describe('scopeForService', () => {
  test('git-receive-pack ⇒ write, everything else ⇒ read', () => {
    expect(scopeForService('git-receive-pack')).toBe('write');
    expect(scopeForService('git-upload-pack')).toBe('read');
    expect(scopeForService(undefined)).toBe('read');
    expect(scopeForService(null)).toBe('read');
  });
});
