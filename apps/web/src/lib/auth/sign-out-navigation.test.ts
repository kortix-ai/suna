// Every logout control leaves on a DOCUMENT load, and every one of them goes
// through the single `performSignOut`.
//
// Why this is a correctness rule and not a preference: a soft navigation keeps
// the App Router route cache, the segment cache, and — on a Back/Forward —
// bfcache. `resetClientState()` reaches none of the three, `router.refresh()`
// does not clear the route cache (only Next's internal
// `invalidateEntirePrefetchCache` does, which no application code can call),
// and bfcache restores bypass staleness entirely, so no `staleTimes` value
// substitutes. Across an identity change that means the next account can be
// shown the previous account's rendered segments.
//
// SOURCE assertions, and therefore subject to this repo's documented trap: a
// source test that matches inside a COMMENT passes against text that never
// runs. Task 3's first harness did exactly that. So: comments are stripped
// before any match, every anchor is asserted to exist before it is used, and
// this file names `router.push` / `router.replace` only inside string
// constants — never in prose that a future slice could pick up.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WEB_SRC = resolve(import.meta.dir, '../..');

/** Comments stripped; `//` spared when it is a URL scheme. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function code(relativePath: string): string {
  return stripComments(readFileSync(resolve(WEB_SRC, relativePath), 'utf8'));
}

/**
 * The executable text between two anchors. Both anchors are asserted, so a
 * rename fails this test instead of silently reducing it to an empty slice
 * that every `not.toContain` passes against.
 */
function slice(source: string, startAnchor: string, endAnchor: string): string {
  const start = source.indexOf(startAnchor);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** Every navigation in a slice, as `[mechanism, argument]` pairs. */
function navigations(text: string): string[][] {
  const pattern =
    /window\.location\.(assign|replace)\(([^)]*)\)|window\.location\.(href)\s*=\s*([^;]+);|router\.(push|replace|refresh|prefetch)\(([^)]*)\)/g;
  return [...text.matchAll(pattern)].map((match) => [
    match[1] ?? match[3] ?? match[5],
    (match[2] ?? match[4] ?? match[6] ?? '').trim(),
  ]);
}

/** The six sign-out controls, each sliced down to its own logout path. */
const CONTROLS: { name: string; file: string; from: string; to: string }[] = [
  {
    name: 'the user menu / workspace switcher Log out',
    file: 'features/layout/user-menu-shared.tsx',
    from: 'export function useLogoutFlow(',
    to: 'const dialog = (',
  },
  {
    name: 'the command palette Log out',
    file: 'features/workspace/command-palette.tsx',
    from: 'const performLogout = useCallback(',
    to: 'const handleSetTheme = useCallback(',
  },
  {
    name: "/projects/start's stuck-state escape hatch",
    file: 'app/(app)/projects/start/page.tsx',
    from: 'function StartSignOutButton()',
    to: 'function ProjectStartError(',
  },
  {
    name: "/new's Log out",
    file: 'features/workspace/new/new-workspace-page.tsx',
    from: 'fallbackLabel={user?.email}',
    to: 'Log out',
  },
  {
    name: "phone verification's Sign out",
    file: 'app/(auth)/auth/phone-verification/page.tsx',
    from: 'const signOutMutation = useMutation(',
    to: 'const handleSignOut',
  },
  {
    name: "AuthProvider's signOut, which every useAuth() consumer gets",
    file: 'features/providers/auth-provider.tsx',
    from: 'const value = useMemo<AuthContextType>(',
    to: 'return <AuthContext.Provider',
  },
];

describe('all six sign-out controls run the one sign-out', () => {
  for (const control of CONTROLS) {
    test(`${control.name} calls performSignOut`, () => {
      const body = slice(code(control.file), control.from, control.to);
      expect(body).toContain('performSignOut');
    });
  }

  for (const control of CONTROLS) {
    test(`${control.name} performs NO client-side navigation of its own`, () => {
      // Enumerated rather than spot-checked: a `router.push('/auth')` added
      // beside the call fails here instead of slipping past a `toContain`.
      // `router.prefetch` counts too — it only warms a segment cache that a
      // document load never reads.
      expect(navigations(slice(code(control.file), control.from, control.to))).toEqual([]);
    });
  }
});

describe('the one sign-out leaves on a document load', () => {
  test('performSignOut hands `leave` a window.location.assign', () => {
    const body = slice(
      code('lib/auth/perform-sign-out.ts'),
      'export async function performSignOut()',
      '\n}\n',
    );
    expect(body).toContain('window.location.assign(destination)');
  });

  test('neither the wiring nor the sequence holds a router at all', () => {
    for (const file of ['lib/auth/perform-sign-out.ts', 'lib/auth/sign-out-sequence.ts']) {
      const body = code(file);
      expect(body).not.toContain('router.');
      expect(body).not.toContain('next/navigation');
    }
  });

  test('it lands on /auth', () => {
    expect(code('lib/auth/sign-out-sequence.ts')).toContain(
      "export const SIGN_OUT_DESTINATION = '/auth';",
    );
  });
});

describe('the server half of the sign-out', () => {
  const serverActions = code('lib/auth/sign-out-actions.ts');

  test('revokes the session server-side and emits the audit event', () => {
    // It ran on ONE of the six controls before this was unified, so five of six
    // logouts left the session usable against the API until the access token
    // expired on its own.
    expect(serverActions).toContain('recordPlatformLogout(');
    expect(code('lib/auth/perform-sign-out.ts')).toContain(
      'finalizeServerSession: finalizeServerSignOut',
    );
  });

  test('clears the httpOnly auth-bounce cookie, which no client can reach', () => {
    expect(serverActions).toContain('AUTH_BOUNCE_COOKIE');
    expect(serverActions).toContain('await clearAuthBounceCookie();');
  });
});

describe('the sign-out path stays importable from the browser', () => {
  test('nothing in its graph pulls in `server-only`', async () => {
    // `AuthProvider` imports `performSignOut`, and `AuthProvider` is mounted by
    // dozens of component tests. Reaching `server-only` from here — as an
    // earlier revision did, through `@/lib/public-env-server` — turned 72 of
    // them into load errors at once. A real import, not a source match: only
    // evaluating the module proves the whole transitive graph is clean.
    const signOutModule = await import('./perform-sign-out');
    expect(typeof signOutModule.performSignOut).toBe('function');
  });
});

describe('the sign-out path leaves `kortix_last_project` alone', () => {
  // Load-bearing, not an oversight. The cookie is owner-bound
  // (`serializeLastProject`), so the next account cannot follow it, and the
  // middleware reads its OWNER half to attribute a bounce once identity
  // resolution has already returned `user: null` — which is what happens after
  // a logout and on the dominant session-expiry path. Deleting it on sign-out
  // un-attributes every post-logout bounce and re-opens the hole the
  // return-URL gate closes.
  test('neither the shared sign-out nor any control names the cookie', () => {
    const files = [
      'lib/auth/perform-sign-out.ts',
      'lib/auth/sign-out-sequence.ts',
      'lib/auth/sign-out-actions.ts',
      'lib/utils/reset-client-state.ts',
    ].concat(CONTROLS.map((control) => control.file));

    for (const file of files) {
      const body = code(file);
      expect(body).not.toContain('LAST_PROJECT_COOKIE');
      expect(body).not.toContain('kortix_last_project');
      expect(body).not.toContain('clearLastProjectId');
    }
  });
});
