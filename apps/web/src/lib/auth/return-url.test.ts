import { describe, expect, test } from 'bun:test';

import { PROJECT_LANDING_PATH } from '@/lib/onboarding/landing-destination';
import {
  isInviteReturnUrl,
  isSignupSafeReturnUrl,
  resolveAuthRedirectBaseUrl,
  resolveNewAccountReturnUrl,
  sanitizeAuthReturnUrl,
} from './return-url';

describe('sanitizeAuthReturnUrl', () => {
  test('preserves an invite URL verbatim (must survive to reach the dialog)', () => {
    expect(sanitizeAuthReturnUrl('/invites/abc-123')).toBe('/invites/abc-123');
  });

  test('defaults to a project, not the projects list', () => {
    // Post-auth must never land on the list: choosing a project there is the
    // manual step this flow exists to remove.
    expect(sanitizeAuthReturnUrl(undefined)).toBe(PROJECT_LANDING_PATH);
    expect(sanitizeAuthReturnUrl(null)).toBe(PROJECT_LANDING_PATH);
    expect(PROJECT_LANDING_PATH).not.toBe('/projects');
  });

  test('rejects an absolute/off-origin URL', () => {
    expect(sanitizeAuthReturnUrl('https://evil.example.com')).toBe(PROJECT_LANDING_PATH);
    expect(sanitizeAuthReturnUrl('//evil.example.com')).toBe(PROJECT_LANDING_PATH);
  });

  test('does not return from auth to the projects list', () => {
    // Middleware sends an unauthenticated /projects request through /auth.
    // Returning to the list exposes it while first-project provisioning runs.
    expect(sanitizeAuthReturnUrl('/projects')).toBe(PROJECT_LANDING_PATH);
  });

  test('returns the canonical path, so later rules see what the browser opens', () => {
    expect(sanitizeAuthReturnUrl('/marketplace/../invites/abc')).toBe('/invites/abc');
    // A dot segment must not sneak a legacy path past its own prefix check.
    expect(sanitizeAuthReturnUrl('/invites/../dashboard')).toBe(PROJECT_LANDING_PATH);
    // Normalization must not disturb an ordinary path, its query, or its hash.
    expect(sanitizeAuthReturnUrl('/projects?tab=recent')).toBe('/projects?tab=recent');
    expect(sanitizeAuthReturnUrl('/invites/abc-123?x=1#note')).toBe('/invites/abc-123?x=1#note');
  });
});

describe('isInviteReturnUrl', () => {
  test('true for an invite acceptance path', () => {
    expect(isInviteReturnUrl('/invites/abc-123')).toBe(true);
    expect(isInviteReturnUrl('/invites/abc-123?x=1')).toBe(true);
  });

  test('false for non-invite destinations', () => {
    expect(isInviteReturnUrl('/projects')).toBe(false);
    expect(isInviteReturnUrl('/accounts')).toBe(false);
    // Must be the /invites/ segment, not just a prefix match.
    expect(isInviteReturnUrl('/invitesomething')).toBe(false);
    expect(isInviteReturnUrl('/invites')).toBe(false);
  });

  test('false for nullish input', () => {
    expect(isInviteReturnUrl(null)).toBe(false);
    expect(isInviteReturnUrl(undefined)).toBe(false);
  });

  test('the sanitized invite URL is recognized end-to-end', () => {
    expect(isInviteReturnUrl(sanitizeAuthReturnUrl('/invites/xyz'))).toBe(true);
  });
});

describe('resolveNewAccountReturnUrl', () => {
  test('drops a foreign project deep link — the reported bug', () => {
    // Live repro: opening a private project link while logged out sends the
    // path through /auth as ?redirect=. Creating an account there landed the
    // brand-new user on "Request access to this project" for a stranger's
    // project — an account seconds old cannot own something older than itself.
    expect(resolveNewAccountReturnUrl('/projects/319395c1-9c3f-41b4-ac6c-9539a12dbb7c')).toBe(
      PROJECT_LANDING_PATH,
    );
  });

  test('drops every account-scoped destination', () => {
    for (const path of [
      '/projects/319395c1-9c3f-41b4-ac6c-9539a12dbb7c/sessions/abc',
      '/projects/319395c1-9c3f-41b4-ac6c-9539a12dbb7c/files',
      '/projects/319395c1-9c3f-41b4-ac6c-9539a12dbb7c/customize',
      '/accounts/319395c1-9c3f-41b4-ac6c-9539a12dbb7c',
      '/accounts',
      '/connectors',
      '/review',
      '/checkout',
      '/setup',
    ]) {
      expect(resolveNewAccountReturnUrl(path)).toBe(PROJECT_LANDING_PATH);
    }
  });

  test('keeps join/authorize flows — the signup happened FOR these', () => {
    // Dropping any of these strands the flow that sent the user to sign up.
    expect(resolveNewAccountReturnUrl('/invites/abc-123')).toBe('/invites/abc-123');
    expect(resolveNewAccountReturnUrl('/oauth/authorize?client_id=x')).toBe(
      '/oauth/authorize?client_id=x',
    );
    expect(resolveNewAccountReturnUrl('/cli/authorize?code=x')).toBe('/cli/authorize?code=x');
    expect(resolveNewAccountReturnUrl('/tunnel/authorize/abc')).toBe('/tunnel/authorize/abc');
    expect(resolveNewAccountReturnUrl('/slack/login/tok')).toBe('/slack/login/tok');
    expect(resolveNewAccountReturnUrl('/teams/login/tok')).toBe('/teams/login/tok');
    expect(resolveNewAccountReturnUrl('/github/setup?installation_id=1')).toBe(
      '/github/setup?installation_id=1',
    );
  });

  test('keeps public pages — the CTA that started the signup', () => {
    expect(resolveNewAccountReturnUrl('/use-cases/research-agent')).toBe('/use-cases/research-agent');
    expect(resolveNewAccountReturnUrl('/marketplace/acme/tool')).toBe('/marketplace/acme/tool');
  });

  test('keeps the landing door itself', () => {
    expect(resolveNewAccountReturnUrl(PROJECT_LANDING_PATH)).toBe(PROJECT_LANDING_PATH);
    expect(resolveNewAccountReturnUrl(undefined)).toBe(PROJECT_LANDING_PATH);
    expect(resolveNewAccountReturnUrl(null)).toBe(PROJECT_LANDING_PATH);
    // The bare list is rewritten to the door by the sanitizer, and stays safe.
    expect(resolveNewAccountReturnUrl('/projects')).toBe(PROJECT_LANDING_PATH);
  });

  test('still rejects everything sanitizeAuthReturnUrl rejects', () => {
    expect(resolveNewAccountReturnUrl('https://evil.example.com')).toBe(PROJECT_LANDING_PATH);
    expect(resolveNewAccountReturnUrl('//evil.example.com')).toBe(PROJECT_LANDING_PATH);
    expect(resolveNewAccountReturnUrl('javascript:alert(1)')).toBe(PROJECT_LANDING_PATH);
  });

  test('matches on segment boundaries, not raw string prefixes', () => {
    // A lookalike path must not inherit an allowlisted prefix's exemption.
    expect(isSignupSafeReturnUrl('/marketplace-evil')).toBe(false);
    expect(isSignupSafeReturnUrl('/invitesomething')).toBe(false);
    expect(isSignupSafeReturnUrl('/projects/startle')).toBe(false);
    expect(isSignupSafeReturnUrl('/marketplace')).toBe(true);
    expect(isSignupSafeReturnUrl('/marketplace/acme')).toBe(true);
    expect(isSignupSafeReturnUrl('/marketplace?q=1')).toBe(true);
  });

  test('is default-deny: an unknown route is not signup-safe', () => {
    // A route added later must fail into the user's own project, never into
    // whatever the visitor had open before they had an account.
    expect(isSignupSafeReturnUrl('/some-future-route/123')).toBe(false);
    expect(resolveNewAccountReturnUrl('/some-future-route/123')).toBe(PROJECT_LANDING_PATH);
  });

  test('is nullish-safe', () => {
    expect(isSignupSafeReturnUrl(null)).toBe(false);
    expect(isSignupSafeReturnUrl(undefined)).toBe(false);
    expect(isSignupSafeReturnUrl('')).toBe(false);
  });

  test('a dot segment cannot smuggle a foreign project past the allowlist', () => {
    // Every consumer rebuilds this path through `new URL()`, which collapses
    // dot segments — so testing the raw string tests a path the browser never
    // visits. `/marketplace/../projects/<id>` would pass a `/marketplace`
    // check and then open `/projects/<id>`: the exact bug, through the fix.
    for (const crafted of [
      '/marketplace/../projects/319395c1-9c3f-41b4-ac6c-9539a12dbb7c',
      '/marketplace/%2e%2e/projects/319395c1-9c3f-41b4-ac6c-9539a12dbb7c',
      '/invites/../projects/319395c1-9c3f-41b4-ac6c-9539a12dbb7c',
      '/use-cases/a/../../projects/319395c1-9c3f-41b4-ac6c-9539a12dbb7c',
    ]) {
      const resolved = resolveNewAccountReturnUrl(crafted);
      // What the browser will actually open, not what the string looks like.
      expect(new URL(`https://kortix.local${resolved}`).pathname).not.toContain('319395c1');
      expect(resolved).toBe(PROJECT_LANDING_PATH);
    }
  });
});

describe('resolveAuthRedirectBaseUrl', () => {
  test('prefers the request origin in the normal case (local dev + cloud)', () => {
    expect(resolveAuthRedirectBaseUrl('http://localhost:3000', 'https://staging.example.com')).toBe(
      'http://localhost:3000',
    );
    expect(resolveAuthRedirectBaseUrl('https://kortix.com', 'https://kortix.com')).toBe('https://kortix.com');
  });

  test('leaves loopback origins as-is so local dev stays on localhost', () => {
    expect(resolveAuthRedirectBaseUrl('http://localhost:3000', undefined)).toBe('http://localhost:3000');
    expect(resolveAuthRedirectBaseUrl('http://127.0.0.1:3000', 'https://app.example.com')).toBe(
      'http://127.0.0.1:3000',
    );
  });

  test('falls back to APP_URL when the origin is a 0.0.0.0 wildcard bind (self-host behind proxy)', () => {
    // The exact live symptom: SSO on self-host landing on https://0.0.0.0:3000.
    expect(resolveAuthRedirectBaseUrl('https://0.0.0.0:3000', 'https://essentia.kortix.cloud')).toBe(
      'https://essentia.kortix.cloud',
    );
    expect(resolveAuthRedirectBaseUrl('http://0.0.0.0:3000', 'https://essentia.kortix.cloud/')).toBe(
      'https://essentia.kortix.cloud',
    );
    expect(resolveAuthRedirectBaseUrl('https://[::]:3000', 'https://essentia.kortix.cloud')).toBe(
      'https://essentia.kortix.cloud',
    );
  });

  test('keeps the wildcard origin only if no APP_URL is configured (nothing better to use)', () => {
    expect(resolveAuthRedirectBaseUrl('https://0.0.0.0:3000', undefined)).toBe('https://0.0.0.0:3000');
  });

  test('final fallback when everything is empty', () => {
    expect(resolveAuthRedirectBaseUrl('', undefined)).toBe('http://localhost:3000');
    expect(resolveAuthRedirectBaseUrl(null, 'https://app.example.com/')).toBe('https://app.example.com');
  });
});
