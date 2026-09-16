import { expect, test } from 'bun:test';
import { isProviderIngressAuthFailure } from './provider-auth';

test('keeps sandbox authentication and other providers separate from Daytona ingress authentication', async () => {
  for (const body of [
    { error: 'unauthorized', reason: 'malformed' },
    { statusCode: 401, code: 'UNAUTHORIZED', message: 'application authorization failed' },
    null,
  ]) {
    expect(await isProviderIngressAuthFailure('daytona', Response.json(body, { status: 401 }))).toBe(false);
  }
  expect(await isProviderIngressAuthFailure('platinum', Response.json({
    statusCode: 401, code: 'UNAUTHORIZED', message: 'unauthorized: authentication failed: expired',
  }, { status: 401 }))).toBe(false);
});

test('recognizes only the observed HTTPS Daytona login endpoint', async () => {
  for (const location of [
    'https://api.auth.daytona.io.evil.test/user_management/authorize',
    'http://api.auth.daytona.io/user_management/authorize',
    'https://api.auth.daytona.io/application/oauth',
    '/user_management/authorize',
  ]) {
    expect(await isProviderIngressAuthFailure('daytona', new Response(null, {
      status: 307, headers: { location },
    }))).toBe(false);
  }
});
