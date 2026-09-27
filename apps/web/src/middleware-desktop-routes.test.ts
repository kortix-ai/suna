import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'middleware.ts'), 'utf8');
// apps/web/src -> apps/desktop-electron/src/nav-rules.js, the Electron shell's
// navigation rules. Its comment above APP_PATH_PREFIXES states the list MUST
// equal DESKTOP_ALLOWED_ROUTES in apps/web/src/middleware.ts, and
// nav-rules.test.js asserts the two lists are equal. The list used to live in
// main.js.
const desktopNavRulesSource = readFileSync(
  join(import.meta.dir, '../../desktop-electron/src/nav-rules.js'),
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
    const start = desktopNavRulesSource.indexOf('const APP_PATH_PREFIXES');
    const end = desktopNavRulesSource.indexOf('function isAppPath');
    // Guard the slice: a moved or renamed anchor yields an empty string, and
    // an empty list fails with a message that hides where the list went.
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const shellList = desktopNavRulesSource.slice(start, end);
    expect(shellList).toContain("'/new'");
    const webList = source.slice(
      source.indexOf('const DESKTOP_ALLOWED_ROUTES'),
      source.indexOf('export async function middleware'),
    );
    const webRoutes = [...webList.matchAll(/'(\/[^']*)'/g)].map((m) => m[1]);
    expect(webRoutes.length).toBeGreaterThan(10);
    expect(webRoutes.filter((route) => !shellList.includes(`'${route}'`))).toEqual([]);
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
