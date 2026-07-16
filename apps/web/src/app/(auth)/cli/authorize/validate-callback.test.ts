import { describe, expect, test } from 'bun:test';

import { validateCallback } from './validate-callback';

describe('validateCallback', () => {
  test('accepts 127.0.0.1 and localhost http callbacks', () => {
    expect(validateCallback('http://127.0.0.1:8712/callback')).toEqual({
      ok: true,
      reason: '',
      display: '127.0.0.1:8712',
    });
    expect(validateCallback('http://localhost:3999/callback').ok).toBe(true);
    expect(validateCallback('http://localhost:3999/callback').display).toBe('localhost:3999');
  });

  test('rejects a missing or malformed URL', () => {
    expect(validateCallback(null).ok).toBe(false);
    expect(validateCallback('').ok).toBe(false);
    expect(validateCallback('not a url').ok).toBe(false);
  });

  test('rejects non-http protocols', () => {
    expect(validateCallback('https://127.0.0.1:8712/callback').ok).toBe(false);
    expect(validateCallback('file:///etc/passwd').ok).toBe(false);
  });

  test('rejects non-local hosts', () => {
    expect(validateCallback('http://evil.example.com/callback').ok).toBe(false);
    expect(validateCallback('http://127.0.0.2:8712/callback').ok).toBe(false);
    expect(validateCallback('http://0.0.0.0:8712/callback').ok).toBe(false);
  });
});
