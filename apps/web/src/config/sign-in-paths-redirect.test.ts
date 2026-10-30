import { expect, test } from 'bun:test';
import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';
import config from '../../next.config';

const resolved: NextConfig = await config(PHASE_DEVELOPMENT_SERVER);

// KRTX-3154: /login and /signup are the paths people type. They bounced to
// /auth until unknown paths stopped bouncing, then answered "Page not found".
// /auth asks for the email first and picks sign-in or sign-up itself.
test('the conventional sign-in and sign-up paths redirect to /auth', async () => {
  const redirects = (await resolved.redirects?.()) ?? [];
  const rule = redirects.find((candidate) => candidate.destination === '/auth');
  expect(rule).toMatchObject({ source: '/:path(login|signin|sign-in|signup|sign-up|register)', permanent: false });
});
