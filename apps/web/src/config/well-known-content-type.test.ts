import { expect, test } from 'bun:test';
import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';
import config from '../../next.config';

const resolved: NextConfig = await config(PHASE_DEVELOPMENT_SERVER);

// Apple reads the association file as JSON: Universal Links for /share and
// /auth/callback, and shared web credentials. The file has no extension, so
// it was served as application/octet-stream (KRTX-3255).
test('the Apple app-site-association file is served as JSON', async () => {
  const rules = await resolved.headers?.();
  const headers = rules?.find((rule) => rule.source === '/.well-known/apple-app-site-association')?.headers;
  expect(headers).toContainEqual({ key: 'Content-Type', value: 'application/json' });
});
