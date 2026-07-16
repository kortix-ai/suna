import { describe, expect, test } from 'bun:test';

import {
  credentialsCopy,
  parseAuthMethods,
  passwordFailureCopy,
  resolveEmailFlowMode,
} from './unified-auth-flow';

describe('parseAuthMethods', () => {
  test('defaults to magic and password when unset', () => {
    expect(parseAuthMethods(undefined)).toEqual(['magic', 'password']);
    expect(parseAuthMethods(null)).toEqual(['magic', 'password']);
    expect(parseAuthMethods('')).toEqual(['magic', 'password']);
  });

  test('parses a comma-separated list case-insensitively', () => {
    expect(parseAuthMethods('Password')).toEqual(['password']);
    expect(parseAuthMethods(' magic , password ')).toEqual(['magic', 'password']);
  });

  test('falls back to the default when nothing valid remains', () => {
    expect(parseAuthMethods('sso,oauth')).toEqual(['magic', 'password']);
  });

  test('drops unknown entries but keeps valid ones', () => {
    expect(parseAuthMethods('magic,sso')).toEqual(['magic']);
  });
});

describe('resolveEmailFlowMode', () => {
  test('maps explicit modes through', () => {
    expect(resolveEmailFlowMode({ allowed: true, mode: 'signin' })).toBe('signin');
    expect(resolveEmailFlowMode({ allowed: true, mode: 'signup' })).toBe('signup');
    expect(resolveEmailFlowMode({ allowed: false, mode: 'closed' })).toBe('closed');
    expect(resolveEmailFlowMode({ allowed: true, mode: 'sso' })).toBe('sso');
  });

  test('degrades legacy allowed-only responses', () => {
    expect(resolveEmailFlowMode({ allowed: true })).toBe('unknown');
    expect(resolveEmailFlowMode({ allowed: false })).toBe('closed');
  });

  test('degrades malformed responses to unknown', () => {
    expect(resolveEmailFlowMode(null)).toBe('unknown');
    expect(resolveEmailFlowMode(undefined)).toBe('unknown');
    expect(resolveEmailFlowMode('signin')).toBe('unknown');
    expect(resolveEmailFlowMode({ mode: 'weird' })).toBe('unknown');
    expect(resolveEmailFlowMode({})).toBe('unknown');
  });
});

describe('credentialsCopy', () => {
  test('signin mode greets a known account and offers password reset', () => {
    const copy = credentialsCopy('signin');
    expect(copy.title).toBe('Welcome back');
    expect(copy.passwordAutoComplete).toBe('current-password');
    expect(copy.showForgotPassword).toBe(true);
    expect(copy.submitsAs).toBe('signin');
  });

  test('signup mode asks for a new password and hides reset', () => {
    const copy = credentialsCopy('signup');
    expect(copy.title).toBe('Create your account');
    expect(copy.passwordAutoComplete).toBe('new-password');
    expect(copy.showForgotPassword).toBe(false);
    expect(copy.submitsAs).toBe('signup');
  });

  test('unknown mode stays neutral but submits through the adaptive signup path', () => {
    const copy = credentialsCopy('unknown');
    expect(copy.title).toBe('Enter your password');
    expect(copy.showForgotPassword).toBe(true);
    expect(copy.submitsAs).toBe('signup');
  });
});

describe('passwordFailureCopy', () => {
  test('invalid credentials on a known account reads as wrong password', () => {
    const failure = passwordFailureCopy({
      mode: 'signin',
      code: 'invalid_credentials',
      fallback: 'Invalid login credentials',
    });
    expect(failure.message).toContain('Incorrect password');
    expect(failure.switchToSignin).toBeUndefined();
  });

  test('existing account discovered during signup flips the step to sign-in', () => {
    const failure = passwordFailureCopy({
      mode: 'signup',
      code: 'existing_account_wrong_password',
      fallback: 'An account with this email already exists.',
    });
    expect(failure.message).toContain('already have an account');
    expect(failure.switchToSignin).toBe(true);
  });

  test('existing account in unknown mode reads as wrong password and flips to sign-in', () => {
    const failure = passwordFailureCopy({
      mode: 'unknown',
      code: 'existing_account_wrong_password',
      fallback: null,
    });
    expect(failure.message).toContain('Incorrect password');
    expect(failure.switchToSignin).toBe(true);
  });

  test('unmapped codes fall back to the server message', () => {
    expect(
      passwordFailureCopy({ mode: 'signup', code: 'signups_closed', fallback: 'Signups closed' })
        .message,
    ).toBe('Signups closed');
    expect(passwordFailureCopy({ mode: 'signin', code: null, fallback: null }).message).toBe(
      'An unexpected error occurred',
    );
  });

  test('invalid credentials in unknown mode does not claim wrong password', () => {
    const failure = passwordFailureCopy({
      mode: 'unknown',
      code: 'invalid_credentials',
      fallback: 'Invalid login credentials',
    });
    expect(failure.message).toBe('Invalid login credentials');
  });
});
