import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  canAdmitMobileOAuthSession,
  isNewlyCreatedUser,
  NEW_USER_REJECTION_WINDOW_MS,
} from '../lib/auth/mobile-admission.ts';

const sourceUrl = new URL('./useAuth.ts', import.meta.url);

test('web-created user is not rejected during session hydration or password sign-in', async () => {
  const source = await readFile(sourceUrl, 'utf8');
  const hydrationStart = source.indexOf('supabase.auth.getSession().then');
  const hydrationEnd = source.indexOf('return () => {', hydrationStart);
  const hydrationBlock = source.slice(hydrationStart, hydrationEnd);

  assert.equal(hydrationBlock.includes('admitMobileOAuthSession'), false);
  assert.equal(hydrationBlock.includes('canAdmitMobileSession'), false);
  assert.equal(hydrationBlock.includes('isNewlyCreatedUser'), false);

  const signedInStart = source.indexOf("if (_event === 'SIGNED_IN' && mobileOAuthAdmissionPendingRef.current)");
  assert.notEqual(signedInStart, -1);

  const signInStart = source.indexOf('const signIn = useCallback');
  const signInEnd = source.indexOf('const signUp = useCallback', signInStart);
  const signInMethod = source.slice(signInStart, signInEnd);

  assert.equal(signInMethod.includes('mobileOAuthAdmissionPendingRef'), false);
  assert.equal(signInMethod.includes('admitMobileOAuthSession'), false);
});

test('direct mobile OAuth signup remains blocked for brand-new accounts', () => {
  const now = Date.parse('2026-06-20T12:00:00.000Z');
  const createdAt = new Date(now - 5_000).toISOString();

  assert.equal(
    isNewlyCreatedUser({ created_at: createdAt }, now),
    true,
    'accounts inside the rejection window are treated as newly created',
  );
  assert.equal(
    canAdmitMobileOAuthSession({ created_at: createdAt }, {
      webRegistrationHandoffGranted: false,
      now,
    }),
    false,
    'direct mobile OAuth signup without a web handoff is rejected',
  );
});

test('verified web registration handoff admits a brand-new account through OAuth', () => {
  const now = Date.parse('2026-06-20T12:00:00.000Z');
  const createdAt = new Date(now - 5_000).toISOString();

  assert.equal(
    canAdmitMobileOAuthSession({ created_at: createdAt }, {
      webRegistrationHandoffGranted: true,
      now,
    }),
    true,
  );
});

test('existing accounts pass the OAuth gate even inside the rejection window', () => {
  const now = Date.parse('2026-06-20T12:00:00.000Z');
  const createdAt = new Date(now - NEW_USER_REJECTION_WINDOW_MS - 1_000).toISOString();

  assert.equal(
    canAdmitMobileOAuthSession({ created_at: createdAt }, {
      webRegistrationHandoffGranted: false,
      now,
    }),
    true,
  );
});
