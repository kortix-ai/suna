import { expect, test } from 'bun:test';
import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';
import config from '../../next.config';

const resolved: NextConfig = await config(PHASE_DEVELOPMENT_SERVER);

test('web sends a restrictive Permissions-Policy on the catch-all header rule', async () => {
  const rules = await resolved.headers?.();
  const headers = rules?.find((rule) => rule.source === '/:path*')?.headers;
  expect(headers).toContainEqual({
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=()',
  });
  expect(headers).toContainEqual({ key: 'X-Content-Type-Options', value: 'nosniff' });
  expect(headers).toContainEqual({ key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' });
});
