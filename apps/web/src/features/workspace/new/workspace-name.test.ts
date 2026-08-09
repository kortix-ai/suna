// apps/web/src/features/workspace/new/workspace-name.test.ts
import { describe, expect, test } from 'bun:test';

import { WORKSPACE_NAME_MAX_LENGTH, validateWorkspaceName } from './workspace-name';

describe('validateWorkspaceName', () => {
  test('accepts letters, numbers, spaces, hyphens, underscores and dots', () => {
    expect(validateWorkspaceName('my-agi_company.v2 3')).toEqual({
      ok: true,
      name: 'my-agi_company.v2 3',
    });
  });

  test('trims surrounding whitespace before validating', () => {
    expect(validateWorkspaceName('  suna-web  ')).toEqual({ ok: true, name: 'suna-web' });
  });

  test('rejects an empty or whitespace-only name', () => {
    expect(validateWorkspaceName('')).toEqual({ ok: false, error: 'Name is required' });
    expect(validateWorkspaceName('   ')).toEqual({ ok: false, error: 'Name is required' });
  });

  test('rejects characters the API rejects', () => {
    expect(validateWorkspaceName('my/agi')).toEqual({
      ok: false,
      error: 'Use only letters, numbers, spaces, hyphens, underscores or dots',
    });
    expect(validateWorkspaceName('café')).toEqual({
      ok: false,
      error: 'Use only letters, numbers, spaces, hyphens, underscores or dots',
    });
  });

  test('rejects a name longer than the API ceiling', () => {
    const tooLong = 'a'.repeat(WORKSPACE_NAME_MAX_LENGTH + 1);
    expect(validateWorkspaceName(tooLong)).toEqual({
      ok: false,
      error: `Name must be ${WORKSPACE_NAME_MAX_LENGTH} characters or fewer`,
    });
  });

  test('accepts a name exactly at the ceiling', () => {
    const exact = 'a'.repeat(WORKSPACE_NAME_MAX_LENGTH);
    expect(validateWorkspaceName(exact)).toEqual({ ok: true, name: exact });
  });
});
