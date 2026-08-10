import { describe, expect, test } from 'bun:test';
import { validateScope } from './scope-validator';

describe('tunnel scope input validation', () => {
  test('rejects unknown fields instead of silently creating an unrestricted grant', () => {
    expect(validateScope('filesystem', { path: '/secret' })).toEqual({
      valid: false,
      error: 'Unknown scope field: "path"',
    });
    expect(validateScope('shell', { command: 'bash' }).valid).toBe(false);
  });

  test('preserves the UI scope label while sanitizing enforceable fields', () => {
    expect(
      validateScope('filesystem', {
        scope: 'files:read',
        paths: ['/home/user'],
        operations: ['read', 'list'],
      }),
    ).toEqual({
      valid: true,
      sanitized: {
        scope: 'files:read',
        paths: ['/home/user'],
        operations: ['read', 'list'],
      },
    });
  });

  test('rejects empty restriction arrays that would otherwise mean unrestricted', () => {
    expect(validateScope('filesystem', { paths: [] }).valid).toBe(false);
    expect(validateScope('filesystem', { operations: [] }).valid).toBe(false);
    expect(validateScope('shell', { commands: [] }).valid).toBe(false);
    expect(validateScope('desktop', { features: [] }).valid).toBe(false);
    expect(validateScope('filesystem', {}).valid).toBe(true);
  });

  test('rejects non-finite and duplicate scope values', () => {
    expect(validateScope('shell', { maxTimeout: Number.NaN }).valid).toBe(false);
    expect(validateScope('filesystem', { maxFileSize: Number.POSITIVE_INFINITY }).valid).toBe(
      false,
    );
    expect(validateScope('shell', { commands: ['node', 'node'] }).valid).toBe(false);
  });
});
