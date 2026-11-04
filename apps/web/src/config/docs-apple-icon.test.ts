import { expect, test } from 'bun:test';
import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';
import config from '../../next.config';

const resolved: NextConfig = await config(PHASE_DEVELOPMENT_SERVER);

// KRTX-3226: the docs pages link /docs/apple-touch-icon.png (Blume detects the
// app's public/apple-touch-icon.png) but the docs build never contains it, so
// the `/docs/:path*` directory rule turned it into a 404.
test('the docs apple-touch-icon is the app icon, matched before the docs directory rule', async () => {
  const rewrites = await resolved.rewrites?.();
  const afterFiles = Array.isArray(rewrites) ? rewrites : (rewrites?.afterFiles ?? []);
  const icon = afterFiles.findIndex((rule) => rule.source === '/docs/apple-touch-icon.png');
  const directory = afterFiles.findIndex((rule) => rule.source === '/docs/:path*');
  expect(icon).toBeGreaterThanOrEqual(0);
  expect(afterFiles[icon]?.destination).toBe('/apple-touch-icon.png');
  expect(icon).toBeLessThan(directory);
});
