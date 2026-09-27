import { describe, expect, test } from 'bun:test';

import { permissionPromptDetail, permissionPromptTitle, pinnedPermission } from './permission-prompt';

describe('pinnedPermission', () => {
  test('undefined for an empty list', () => {
    expect(pinnedPermission([])).toBeUndefined();
  });

  test('the oldest (first) pending permission', () => {
    const permissions = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];
    expect(pinnedPermission(permissions)).toEqual({ id: 'p1' });
  });
});

describe('permissionPromptTitle', () => {
  test('known permission types get their question-style title', () => {
    expect(permissionPromptTitle('bash')).toBe('Run a command in the sandbox?');
    expect(permissionPromptTitle('edit')).toBe('Edit a file?');
    expect(permissionPromptTitle('write')).toBe('Write a file?');
    expect(permissionPromptTitle('read')).toBe('Read a file?');
    expect(permissionPromptTitle('webfetch')).toBe('Fetch a URL?');
    expect(permissionPromptTitle('mcp')).toBe('Use an MCP tool?');
    expect(permissionPromptTitle('doom_loop')).toBe('Repeat this tool call?');
  });

  test('an unknown type falls back to metadata.title when present', () => {
    expect(permissionPromptTitle('custom_thing', { title: 'Deploy to production?' })).toBe(
      'Deploy to production?',
    );
  });

  test('an unknown type with no usable metadata falls back to the label as a question', () => {
    expect(permissionPromptTitle('custom_thing')).toBe('custom_thing?');
    expect(permissionPromptTitle('custom_thing', { title: '   ' })).toBe('custom_thing?');
    expect(permissionPromptTitle('custom_thing', { title: 42 })).toBe('custom_thing?');
  });

  test('a known type wins over metadata.title', () => {
    expect(permissionPromptTitle('bash', { title: 'Something else' })).toBe(
      'Run a command in the sandbox?',
    );
  });
});

describe('permissionPromptDetail', () => {
  test('joins patterns with two spaces, mirroring web', () => {
    expect(permissionPromptDetail(['rm -rf /tmp/x', 'ls'])).toBe('rm -rf /tmp/x  ls');
  });

  test('a single pattern', () => {
    expect(permissionPromptDetail(['npm install'])).toBe('npm install');
  });

  test('falls back to metadata.title when there are no patterns', () => {
    expect(permissionPromptDetail(undefined, { title: 'curl https://example.com' })).toBe(
      'curl https://example.com',
    );
    expect(permissionPromptDetail([], { title: 'curl https://example.com' })).toBe(
      'curl https://example.com',
    );
  });

  test('null when neither patterns nor a usable metadata title exist', () => {
    expect(permissionPromptDetail(undefined)).toBeNull();
    expect(permissionPromptDetail([])).toBeNull();
    expect(permissionPromptDetail(undefined, {})).toBeNull();
    expect(permissionPromptDetail(undefined, { title: '  ' })).toBeNull();
    expect(permissionPromptDetail(undefined, { title: 7 })).toBeNull();
  });
});
