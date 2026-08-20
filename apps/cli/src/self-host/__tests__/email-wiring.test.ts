import { describe, expect, test } from 'bun:test';

import { AUTH_EMAIL_HOOK_URI, applyEmailWiring } from '../email-wiring';

function freshInstance(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    EMAIL_URL: '',
    EMAIL_FROM: '',
    AUTH_EMAIL_HOOK_SECRET: '',
    GOTRUE_HOOK_SEND_EMAIL_ENABLED: 'false',
    GOTRUE_HOOK_SEND_EMAIL_URI: '',
    ENABLE_EMAIL_AUTOCONFIRM: 'true',
    KORTIX_PUBLIC_AUTH_METHODS: 'password',
    KORTIX_DOMAIN: 'kortix.example.com',
    ...overrides,
  };
}

describe('applyEmailWiring', () => {
  test('setting EMAIL_URL is the ONLY step an operator takes', () => {
    const env = freshInstance();
    env.EMAIL_URL = 'smtp://user:pass@smtp.example.com:587';

    applyEmailWiring(env, '');

    // GoTrue now delegates to the API, so auth mail uses the same provider.
    expect(env.GOTRUE_HOOK_SEND_EMAIL_ENABLED).toBe('true');
    expect(env.GOTRUE_HOOK_SEND_EMAIL_URI).toBe(AUTH_EMAIL_HOOK_URI);
    expect(env.AUTH_EMAIL_HOOK_SECRET).toMatch(/^v1,whsec_.+/);
    // Email works, so confirmation is required and magic-link is offered.
    expect(env.ENABLE_EMAIL_AUTOCONFIRM).toBe('false');
    expect(env.KORTIX_PUBLIC_AUTH_METHODS).toBe('password,magic');
    // Sending as noreply@kortix.com from someone else's box fails SPF/DKIM.
    expect(env.EMAIL_FROM).toBe('Kortix <noreply@kortix.example.com>');
  });

  test('an API-key provider works the same way — no SMTP anywhere', () => {
    const env = freshInstance();
    env.EMAIL_URL = 'resend://re_key';
    applyEmailWiring(env, '');
    expect(env.GOTRUE_HOOK_SEND_EMAIL_ENABLED).toBe('true');
    expect(env.KORTIX_PUBLIC_AUTH_METHODS).toBe('password,magic');
  });

  test('the hook secret is generated once and then preserved', () => {
    const env = freshInstance({ EMAIL_URL: 'resend://re_key' });
    applyEmailWiring(env, '');
    const first = env.AUTH_EMAIL_HOOK_SECRET;
    applyEmailWiring(env, env.EMAIL_URL);
    expect(env.AUTH_EMAIL_HOOK_SECRET).toBe(first);
  });

  test('an operator override survives every later reconcile', () => {
    const env = freshInstance({ EMAIL_URL: 'resend://re_key' });
    applyEmailWiring(env, '');

    // Operator deliberately turns auto-confirm back on.
    env.ENABLE_EMAIL_AUTOCONFIRM = 'true';
    // Every subsequent write reconciles with no transition and must not fight.
    applyEmailWiring(env, env.EMAIL_URL);
    applyEmailWiring(env, env.EMAIL_URL);
    expect(env.ENABLE_EMAIL_AUTOCONFIRM).toBe('true');
  });

  test('removing EMAIL_URL restores a usable instance instead of locking signups out', () => {
    const env = freshInstance({ EMAIL_URL: 'resend://re_key' });
    applyEmailWiring(env, '');
    expect(env.ENABLE_EMAIL_AUTOCONFIRM).toBe('false');

    const previous = env.EMAIL_URL;
    env.EMAIL_URL = '';
    applyEmailWiring(env, previous);

    expect(env.GOTRUE_HOOK_SEND_EMAIL_ENABLED).toBe('false');
    // Confirmation mail can no longer be sent, so requiring it would strand
    // every new signup on an instance that cannot confirm them.
    expect(env.ENABLE_EMAIL_AUTOCONFIRM).toBe('true');
    expect(env.KORTIX_PUBLIC_AUTH_METHODS).toBe('password');
  });

  test('an explicit EMAIL_FROM is never overwritten', () => {
    const env = freshInstance({ EMAIL_FROM: 'Support <help@acme.test>' });
    env.EMAIL_URL = 'smtp://relay.acme.test:25';
    applyEmailWiring(env, '');
    expect(env.EMAIL_FROM).toBe('Support <help@acme.test>');
  });

  test('reports what it changed so `env set` can restart the right services', () => {
    const env = freshInstance({ EMAIL_URL: 'resend://re_key' });
    const outcome = applyEmailWiring(env, '');
    expect(outcome.changed).toContain('GOTRUE_HOOK_SEND_EMAIL_ENABLED');
    expect(outcome.changed).toContain('AUTH_EMAIL_HOOK_SECRET');
    expect(outcome.notes.length).toBeGreaterThan(0);
  });
});
