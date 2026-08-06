import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'middleware.ts'), 'utf8');

describe('desktop route allowlist', () => {
  test('/new is reachable inside the desktop shell', () => {
    const list = source.slice(
      source.indexOf('const DESKTOP_ALLOWED_ROUTES'),
      source.indexOf('export async function middleware'),
    );
    expect(list).toContain("'/new'");
  });

  test('the desktop bounce lands on the door that resolves a real workspace', () => {
    expect(source).toContain('NextResponse.redirect(new URL(PROJECT_LANDING_PATH');
  });

  test('/new is NOT public — it requires authentication', () => {
    const publicList = source.slice(
      source.indexOf('const PUBLIC_ROUTES'),
      source.indexOf('const DESKTOP_ALLOWED_ROUTES'),
    );
    expect(publicList).not.toContain("'/new'");
  });
});
