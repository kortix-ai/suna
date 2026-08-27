import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The nav contract: clicking an in-app menu item must never reload the page.
 *
 * Next 16.3 converts a client navigation into a full document load whenever the
 * RSC fetch it runs at click time comes back wrong — see
 * node_modules/next/dist/client/components/router-reducer/fetch-server-response.js
 * lines 148 (non-flight / non-2xx / empty body), 177 (build id differs from the
 * client bundle), 181 (redirect payload) and the catch at ~205 (fetch rejected).
 *
 * A prefetched `<Link>` already holds its payload in the segment cache, so the
 * click never runs that fetch. A `<button onClick={() => router.push(href)}>`
 * runs it cold every single time and is exposed to all four. That asymmetry is
 * why menu items, and only menu items, "sometimes hard refresh".
 *
 * `eslint-rules/no-router-push-for-static-href.mjs` and Next's own
 * `no-location-assign-relative-destination` detect both shapes. They are set to
 * `error` in eslint.config.mjs — but NOTHING in .github/workflows runs eslint
 * over apps/web, so on their own they gate nothing. This test is what makes
 * them binding: it runs both rules inside `pnpm test`.
 *
 * Linting all of src/ takes ~44s. Pre-filtering to the files that even contain
 * a risky token cuts that to a few seconds without weakening the assertion —
 * neither rule can fire in a file with no `router.push`, `router.replace` or
 * `window.location` in it.
 */
const WEB_ROOT = resolve(import.meta.dir, '../../..');

const NAV_RULES = [
  'nav-contract/no-router-push-for-static-href',
  '@next/next/no-location-assign-relative-destination',
];

/** Files that could possibly trip either rule. */
function candidateFiles(): string[] {
  const out = execFileSync(
    'grep',
    [
      '-rlE',
      'router\\.(push|replace)\\(|window\\.location|location\\.(href|assign|replace)\\s*=',
      'src',
      '--include=*.ts',
      '--include=*.tsx',
    ],
    { cwd: WEB_ROOT, encoding: 'utf8' },
  );
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((f) => !f.includes('.test.'));
}

type LintMessage = { ruleId: string | null; line: number; message: string };
type LintResult = { filePath: string; messages: LintMessage[] };

function lintNavRules(files: string[]): string[] {
  if (files.length === 0) return [];
  const raw = execFileSync('npx', ['eslint', '--format', 'json', ...files], {
    cwd: WEB_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // eslint exits non-zero when it reports anything; we read the JSON either way.
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const results = JSON.parse(raw) as LintResult[];
  return results.flatMap((r) =>
    r.messages
      .filter((m) => m.ruleId !== null && NAV_RULES.includes(m.ruleId))
      .map((m) => `${r.filePath.replace(`${WEB_ROOT}/`, '')}:${m.line}  [${m.ruleId}]`),
  );
}

describe('nav contract — no full page reload on an in-app navigation', () => {
  test(
    'no nav control reaches a static internal href through router.push or window.location',
    () => {
      let violations: string[];
      try {
        violations = lintNavRules(candidateFiles());
      } catch (error) {
        // eslint exits 1 when it reports problems. execFileSync throws, but the
        // JSON is still on stdout.
        const stdout = (error as { stdout?: string }).stdout;
        if (!stdout) throw error;
        const results = JSON.parse(stdout) as LintResult[];
        violations = results.flatMap((r) =>
          r.messages
            .filter((m) => m.ruleId !== null && NAV_RULES.includes(m.ruleId))
            .map((m) => `${r.filePath.replace(`${WEB_ROOT}/`, '')}:${m.line}  [${m.ruleId}]`),
        );
      }

      expect(violations).toEqual([]);
    },
    120_000,
  );

  test('both rules are wired at error level, not warn', () => {
    // As warnings they sat under ~400 react-hooks messages and nobody saw them.
    const config = readFileSync(resolve(WEB_ROOT, 'eslint.config.mjs'), 'utf8');
    for (const rule of NAV_RULES) {
      expect(config).toContain(`'${rule}': 'error'`);
    }
    expect(config).toContain("plugins: { 'nav-contract': navContract }");
  });

  test('the local rule exists and keeps its escape hatch', () => {
    const rule = readFileSync(
      resolve(WEB_ROOT, 'eslint-rules/no-router-push-for-static-href.mjs'),
      'utf8',
    );
    // Controls whose destination is only known after the click (a cmdk row
    // activated by keyboard, an id returned by a POST) legitimately keep
    // router.push. They must say so on the line, so every exemption carries a
    // reason instead of accumulating silently.
    expect(rule).toContain("const ESCAPE = 'nav-contract:'");
  });
});

describe('nav contract — the router bridge', () => {
  test('non-component modules have a soft-navigation path', () => {
    // Stores and lib/ helpers cannot call useRouter(), so they used to reach for
    // window.location.href — an unconditional full reload, every time.
    const bridge = resolve(WEB_ROOT, 'src/lib/navigation/router-bridge.ts');
    expect(existsSync(bridge)).toBe(true);
    const source = readFileSync(bridge, 'utf8');
    expect(source).toContain('export function softNavigate');
    expect(source).toContain('export function softPrefetch');
  });

  test('the bridge is mounted in the root layout', () => {
    // An unmounted bridge silently falls back to window.location — the exact
    // behavior it exists to remove — so the mount is part of the contract.
    const layout = readFileSync(resolve(WEB_ROOT, 'src/app/layout.tsx'), 'utf8');
    expect(layout).toContain('<RouterBridge />');
    expect(layout).toContain("from '@/lib/navigation/router-bridge-mount'");
  });
});

describe('nav contract — dev/staging environment gate', () => {
  test('the access cookie renews on the cookie path, not only on a Basic challenge', () => {
    // The cookie carries maxAge 7 days. Renewing it only on `source === 'basic'`
    // meant the window never slid: it expired 7 days after the single Basic
    // challenge, mid-session. The next request 401s, and a 401 on an RSC
    // navigation is not a login prompt — Next turns the click into a full
    // document load (fetch-server-response.js:148).
    const middleware = readFileSync(resolve(WEB_ROOT, 'src/middleware.ts'), 'utf8');
    const start = middleware.indexOf('const finalizeEnvironmentAccess');
    expect(start).toBeGreaterThan(-1);
    const body = middleware.slice(start, middleware.indexOf('};', start));

    expect(body).toContain("protection.source === 'basic' || protection.source === 'cookie'");
    // The old condition skipped the renewal whenever the browser already held a
    // valid cookie. Its return would restore the 7-day cliff.
    expect(body).not.toContain('accessCookie !== expectedAccessCookie');
  });
});

describe('nav contract — every URL written to history is a real route', () => {
  // `openTabAndNavigate` pushState's a tab's href straight into the address
  // bar. `/sessions/<id>` and `/terminal/<id>` are leftovers of the
  // instance-scoped scheme (packages/sdk/.../instance-routes.ts) and have no
  // App Router page, so the tab looked fine while the URL 404'd on reload or
  // Back. Live code must build `/projects/<id>/sessions/<id>` instead.
  //
  // The allow-list is exactly the paths proven unreachable: the palette's
  // no-projectId branch, and the terminal rail that both AppProviders call
  // sites mount with showRightSidebar={false}.
  const LEGACY_UNREACHABLE = [
    'src/features/workspace/command-palette.tsx',
    'src/components/sidebar/sidebar-right.tsx',
  ];

  test('no live code writes a /sessions/<id> or /terminal/<id> tab href', () => {
    const hits = execFileSync(
      'grep',
      ['-rln', 'href: `/\\(sessions\\|terminal\\)/', 'src', '--include=*.ts', '--include=*.tsx'],
      { cwd: WEB_ROOT, encoding: 'utf8' },
    )
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((f) => !f.includes('.test.'))
      .filter((f) => !LEGACY_UNREACHABLE.includes(f));

    expect(hits).toEqual([]);
  });

  test('the canonical builder exists and is project-scoped', () => {
    const source = readFileSync(resolve(WEB_ROOT, 'src/lib/navigation/session-href.ts'), 'utf8');
    expect(source).toContain('export function projectSessionHref');
    expect(source).toContain('`/projects/${projectId}/sessions/${sessionId}`');
  });
});
