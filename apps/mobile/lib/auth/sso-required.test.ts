import { afterEach, describe, expect, test } from 'bun:test';

import {
  emailRequiresSso,
  isSsoMode,
  reportAccessRemedy,
  useSsoRequiredStore,
} from './sso-required';

describe('isSsoMode', () => {
  test('only mode sso requires single sign-on', () => {
    expect(isSsoMode({ allowed: true, mode: 'sso' })).toBe(true);
    for (const mode of ['signin', 'signup', 'closed', 'SSO', '']) {
      expect(isSsoMode({ allowed: true, mode })).toBe(false);
    }
  });

  test('an API without mode, or a body that is not an object, proceeds', () => {
    expect(isSsoMode({ allowed: true })).toBe(false);
    expect(isSsoMode({ allowed: false })).toBe(false);
    for (const body of [null, undefined, 'sso', 403, []]) expect(isSsoMode(body)).toBe(false);
  });
});

describe('emailRequiresSso', () => {
  test('asks the check about this email and follows mode sso', async () => {
    const asked: string[] = [];
    const check = async (email: string) => {
      asked.push(email);
      return { allowed: true, mode: 'sso' };
    };
    expect(await emailRequiresSso('admin@sso.example.test', check)).toBe(true);
    expect(asked).toEqual(['admin@sso.example.test']);
  });

  test('another mode proceeds to the password, code or sign-up door', async () => {
    expect(
      await emailRequiresSso('a@example.test', async () => ({ allowed: true, mode: 'signin' }))
    ).toBe(false);
  });

  // A failed check never blocks sign-in: the API still refuses the session.
  test('a rejected check (network, 429, 5xx) proceeds', async () => {
    expect(
      await emailRequiresSso('a@example.test', () => Promise.reject(new Error('HTTP 429')))
    ).toBe(false);
  });

  test('a check that throws before it returns a promise proceeds', async () => {
    const check = (): Promise<unknown> => {
      throw new TypeError('fetch is not a function');
    };
    expect(await emailRequiresSso('a@example.test', check)).toBe(false);
  });

  test('a check that never answers proceeds at the deadline', async () => {
    const started = Date.now();
    expect(await emailRequiresSso('a@example.test', () => new Promise(() => {}), 20)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('reportAccessRemedy (the SDK onAccessRemedy hook)', () => {
  afterEach(() => useSsoRequiredStore.setState({ reported: false }));

  test('sso_required reports the refusal, so the session is signed out', () => {
    reportAccessRemedy('sso_required');
    expect(useSsoRequiredStore.getState().reported).toBe(true);
  });

  // An MFA step-up is not a reason to sign out.
  test('account_mfa_required reports nothing', () => {
    reportAccessRemedy('account_mfa_required');
    expect(useSsoRequiredStore.getState().reported).toBe(false);
  });

  test('the root layout passes it to createKortix and mounts the sign-out after AuthProtection', () => {
    const layout: string = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '../../app/_layout.tsx'),
      'utf8'
    );
    expect(layout).toContain('onAccessRemedy: reportAccessRemedy,');
    const guard = layout.indexOf('</AuthProtection>');
    expect(guard).toBeGreaterThan(0);
    expect(layout.indexOf('<SsoRequiredSignOut />')).toBeGreaterThan(guard);
  });
});
