import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = readFileSync(resolve(import.meta.dir, 'middleware.ts'), 'utf8');
const publicRoutes = src.slice(src.indexOf('const PUBLIC_ROUTES'), src.indexOf('];', src.indexOf('const PUBLIC_ROUTES')));

test('/review is not public — the Review Center ships flag-gated inside Customize', () => {
  expect(publicRoutes).not.toContain("'/review'");
  expect(existsSync(resolve(import.meta.dir, 'app/(app)/review'))).toBe(false);
});

test('token-gated entry points stay public', () => {
  for (const route of ["'/secret-intake'", "'/connect'", "'/share'"]) {
    expect(publicRoutes).toContain(route);
  }
});
