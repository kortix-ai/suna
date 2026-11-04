import { describe, expect, test } from 'bun:test';

import { testUiTranslator } from '@/i18n/test-translator';
import {
  authRateLimitCopy,
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

  test('degrades the mode-less eligibility response', () => {
    // The API's primary shape since KRTX-3504: eligibility carries no `mode`,
    // so the step stays neutral and adaptive.
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
    const copy = credentialsCopy('signin', testUiTranslator);
    expect(copy.title).toBe('Welcome back');
    expect(copy.passwordAutoComplete).toBe('current-password');
    expect(copy.showForgotPassword).toBe(true);
    expect(copy.submitsAs).toBe('signin');
  });

  test('signup mode asks for a new password and hides reset', () => {
    const copy = credentialsCopy('signup', testUiTranslator);
    expect(copy.title).toBe('Create your account');
    expect(copy.passwordAutoComplete).toBe('new-password');
    expect(copy.showForgotPassword).toBe(false);
    expect(copy.submitsAs).toBe('signup');
  });

  test('unknown mode stays neutral but submits through the adaptive signup path', () => {
    const copy = credentialsCopy('unknown', testUiTranslator);
    expect(copy.title).toBe('Enter your password');
    expect(copy.showForgotPassword).toBe(true);
    expect(copy.submitsAs).toBe('signup');
  });

  test('closed mode keeps the neutral copy and closes the sign-up door for every address', () => {
    // KRTX-3504: an existing account must still reach this step and sign in,
    // so identical, address-independent copy is what keeps a closed
    // resolution from leaking account history.
    const copy = credentialsCopy('closed', testUiTranslator);
    expect(copy.title).toBe('Enter your password');
    expect(copy.description).toContain('Signups are currently closed');
    expect(copy.passwordAutoComplete).toBe('current-password');
    expect(copy.showForgotPassword).toBe(true);
    expect(copy.submitsAs).toBe('signin');
  });

  test('closed mode never reuses the sign-up or sign-in copy that implies account history', () => {
    // 'closed' must not say "Welcome back" (that confirms the account exists)
    // nor "Create your account" (closed means nobody may create one).
    expect(credentialsCopy('closed', testUiTranslator).title).not.toBe('Welcome back');
    expect(credentialsCopy('closed', testUiTranslator).title).not.toBe('Create your account');
  });
});

describe('authRateLimitCopy', () => {
  test('maps the GoTrue email-send rate limit to human guidance', () => {
    const copy = authRateLimitCopy({
      code: 'over_email_send_rate_limit',
      message: 'Email rate limit exceeded',
    }, testUiTranslator);
    expect(copy).toContain('Try again in about an hour');
    // The raw GoTrue string must never reach the screen.
    expect(copy?.toLowerCase()).not.toContain('rate limit');
  });

  test('maps the generic request rate limit to human guidance', () => {
    const copy = authRateLimitCopy({
      code: 'over_request_rate_limit',
      message: 'Over request rate limit',
    }, testUiTranslator);
    expect(copy).toContain('Try again in a few minutes');
    expect(copy?.toLowerCase()).not.toContain('rate limit');
  });

  test('matches the raw message when the GoTrue code is missing', () => {
    expect(authRateLimitCopy({ message: 'Email rate limit exceeded' }, testUiTranslator)).toContain(
      'Try again in about an hour',
    );
  });

  test('leaves every other error to the existing handling', () => {
    expect(
      authRateLimitCopy({ code: 'invalid_credentials', message: 'Invalid login credentials' }, testUiTranslator),
    ).toBeNull();
    expect(authRateLimitCopy({ message: 'Email not confirmed' }, testUiTranslator)).toBeNull();
    expect(authRateLimitCopy({}, testUiTranslator)).toBeNull();
    expect(authRateLimitCopy(null, testUiTranslator)).toBeNull();
    expect(authRateLimitCopy(undefined, testUiTranslator)).toBeNull();
  });
});

describe('passwordFailureCopy', () => {
  test('invalid credentials on a known account reads as wrong password', () => {
    const failure = passwordFailureCopy(
      {
        mode: 'signin',
        code: 'invalid_credentials',
        fallback: 'Invalid login credentials',
      },
      testUiTranslator,
    );
    expect(failure.message).toContain('Incorrect password');
    expect(failure.switchToSignin).toBeUndefined();
  });

  test('existing account discovered during signup flips the step to sign-in', () => {
    const failure = passwordFailureCopy(
      {
        mode: 'signup',
        code: 'existing_account_wrong_password',
        fallback: 'An account with this email already exists.',
      },
      testUiTranslator,
    );
    expect(failure.message).toContain('already have an account');
    expect(failure.switchToSignin).toBe(true);
  });

  test('existing account in unknown mode reads as wrong password and flips to sign-in', () => {
    const failure = passwordFailureCopy(
      {
        mode: 'unknown',
        code: 'existing_account_wrong_password',
        fallback: null,
      },
      testUiTranslator,
    );
    expect(failure.message).toContain('Incorrect password');
    expect(failure.switchToSignin).toBe(true);
  });

  test('unmapped codes fall back to the server message', () => {
    expect(
      passwordFailureCopy(
        { mode: 'signup', code: 'signups_closed', fallback: 'Signups closed' },
        testUiTranslator,
      ).message,
    ).toBe('Signups closed');
    expect(
      passwordFailureCopy({ mode: 'signin', code: null, fallback: null }, testUiTranslator).message,
    ).toBe('An unexpected error occurred');
  });

  test('invalid credentials in unknown mode does not claim wrong password', () => {
    const failure = passwordFailureCopy(
      {
        mode: 'unknown',
        code: 'invalid_credentials',
        fallback: 'Invalid login credentials',
      },
      testUiTranslator,
    );
    expect(failure.message).toBe('Invalid login credentials');
  });

  test('closed mode reads invalid credentials as a wrong password, never as missing account', () => {
    const failure = passwordFailureCopy(
      {
        mode: 'closed',
        code: 'invalid_credentials',
        fallback: 'Invalid login credentials',
      },
      testUiTranslator,
    );
    expect(failure.message).toContain('Incorrect password');
    expect(failure.switchToSignin).toBeUndefined();
  });

  test('closed mode flips an adaptive signup discovery to sign-in', () => {
    const failure = passwordFailureCopy(
      {
        mode: 'closed',
        code: 'existing_account_wrong_password',
        fallback: null,
      },
      testUiTranslator,
    );
    expect(failure.message).toContain('Incorrect password');
    expect(failure.switchToSignin).toBe(true);
  });
});
