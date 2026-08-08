import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'middleware.ts'), 'utf8');
// apps/web/src -> apps/desktop-electron/src/main.js. This file's own comment
// (main.js, right above APP_PATH_PREFIXES) states the two must stay in sync:
// "MUST stay in sync with DESKTOP_ALLOWED_ROUTES in apps/web/src/middleware.ts."
const desktopMainSource = readFileSync(
  join(import.meta.dir, '../../desktop-electron/src/main.js'),
  'utf8',
);

describe('desktop route allowlist', () => {
  test('/new is reachable inside the desktop shell (web middleware half)', () => {
    const list = source.slice(
      source.indexOf('const DESKTOP_ALLOWED_ROUTES'),
      source.indexOf('export async function middleware'),
    );
    expect(list).toContain("'/new'");
  });

  // Final-review FIX 3: the web half above was pinned, but the Electron
  // main-process half never was — that gap is exactly what let `/new` go
  // missing from `APP_PATH_PREFIXES` while `DESKTOP_ALLOWED_ROUTES` already
  // had it. A full-frame navigation to `/new` (a deep link, an external
  // open, `target=_blank`) fell through `isAppPath` and opened the create
  // page in the user's system browser instead of the desktop window. Both
  // halves of the pair must be asserted, in the SAME test file, or a future
  // drift on either side goes unnoticed again.
  test('/new is reachable inside the desktop shell (Electron main-process half) — MUST stay in sync with the web half above', () => {
    const list = desktopMainSource.slice(
      desktopMainSource.indexOf('const APP_PATH_PREFIXES'),
      desktopMainSource.indexOf('function isAppPath'),
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
