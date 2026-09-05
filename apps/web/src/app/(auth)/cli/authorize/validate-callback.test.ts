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

describe('loopback subdomains — the Cloudflare WAF workaround', () => {
  // The WAF in front of every non-prod origin 403s a query string carrying a
  // bare 127.0.0.1 or localhost host, so those two were rejected at the edge
  // and `kortix login` could not complete against dev/staging at all.
  // Measured 2026-09-01 on dev.kortix.com: 127.0.0.1 -> 403, localhost -> 403,
  // cli.localhost -> 401 (past the WAF).
  test('accepts the *.localhost subdomain the CLI now sends', () => {
    expect(validateCallback('http://cli.localhost:64169/callback').ok).toBe(true);
  });

  test('still accepts the two historical forms, so an older CLI keeps working', () => {
    expect(validateCallback('http://127.0.0.1:64169/callback').ok).toBe(true);
    expect(validateCallback('http://localhost:64169/callback').ok).toBe(true);
  });

  test('refuses a host that merely CONTAINS localhost', () => {
    // `localhost.evil.com` and `notlocalhost` are ordinary internet names.
    expect(validateCallback('http://localhost.evil.com:80/callback').ok).toBe(false);
    expect(validateCallback('http://notlocalhost:64169/callback').ok).toBe(false);
    expect(validateCallback('http://evil.com/?x=.localhost').ok).toBe(false);
  });

  test('refuses a bare .localhost with no label', () => {
    expect(validateCallback('http://.localhost:64169/callback').ok).toBe(false);
  });
});
