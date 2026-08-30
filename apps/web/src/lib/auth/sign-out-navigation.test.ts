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
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

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

describe('nothing on an identity change can wait forever', () => {
  // `packages/sdk/src/browser/cache/idb-sync-cache.ts` `openDB()` registers
  // `onupgradeneeded`/`onsuccess`/`onerror` and NO `onblocked`, and the file has
  // no `onversionchange` either. A version upgrade blocked by a tab still
  // holding the old version settles neither `success` nor `error`, and
  // `dbPromise` is memoized so every later caller parks behind it. That is not
  // hypothetical: `DB_VERSION` has been bumped twice in this repo's history.
  //
  // Unbounded, that single promise could (a) stop a user signing out at all,
  // and (b) park the whole app on its loading frame at SIGN-IN, because
  // `adoptUser` awaits the same reset before `setIsLoading(false)`.

  test('the sign-out bounds every step, not just guards it', () => {
    const sequence = code('lib/auth/sign-out-sequence.ts');
    expect(sequence).toContain("from '@/lib/utils/time-budget'");

    // All FOUR pre-navigation awaits, enumerated: a new unbounded `await
    // steps.` added beside them fails here.
    const budgeted = sequence.match(/withTimeBudget\(steps\./g) ?? [];
    expect(budgeted.length).toBe(4);
    expect(sequence).not.toContain('await steps.');
  });

  test('resetClientState bounds its one async step, for EVERY caller', () => {
    // In `runSignOut` and in `AuthProvider.adoptUser` alike — the sign-in side
    // is where this widened, because an absent marker now runs the reset ahead
    // of the first paint.
    const reset = code('lib/utils/reset-client-state.ts');
    expect(reset).toContain("from '@/lib/utils/time-budget'");
    expect(reset).toContain('withTimeBudget(clearSessionIDBCache())');
    expect(reset).not.toContain('await clearSessionIDBCache()');
  });

  test('the identity-critical clears stay SYNCHRONOUS, which is what makes the bound safe', () => {
    // Outrunning the IDB purge is only safe while everything that could leak
    // across identities has already completed. If any of these three grows an
    // `await`, the bound above starts skipping real work.
    const reset = code('lib/utils/reset-client-state.ts');
    for (const call of [
      'getSharedQueryClient()?.clear();',
      'useCurrentAccountStore.getState().clear();',
      'clearUserLocalStorage();',
    ]) {
      expect(reset).toContain(call);
      expect(reset).not.toContain(`await ${call}`);
    }
  });
});

describe('the signed-out route guards do not race the exit', () => {
  // `performSignOut` fires `SIGNED_OUT` before its document load starts, so a
  // guard that only checks `!user` reaches `/auth` by SOFT navigation first —
  // carrying the App Router route cache across the identity change, which is
  // the exact defect the hard navigation exists to remove.
  const GUARDED = [
    'features/workspace/new/new-workspace-page.tsx',
    'app/(app)/projects/start/page.tsx',
  ];

  test('every signed-out guard checks isSigningOut() FIRST', () => {
    for (const file of GUARDED) {
      const body = code(file);
      expect(body).toContain("from '@/lib/auth/sign-out-sequence'");

      const bail = body.indexOf('if (isSigningOut()) return;');
      const guard = body.indexOf("if (!authLoading && !user) router.replace('/auth');");
      expect(bail).toBeGreaterThan(-1);
      expect(guard).toBeGreaterThan(bail);
    }
  });

  test('the latch is set before performSignOut awaits anything', () => {
    const body = slice(
      code('lib/auth/perform-sign-out.ts'),
      'export async function performSignOut()',
      '\n}\n',
    );
    const mark = body.indexOf('markSignOutStarted();');
    const firstAwait = body.indexOf('await ');
    expect(mark).toBeGreaterThan(-1);
    expect(firstAwait).toBeGreaterThan(mark);
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

/** The local modules an import specifier can name, in resolution order. */
function resolveLocal(specifier: string, fromFile: string): string | null {
  const base = specifier.startsWith('@/')
    ? resolve(WEB_SRC, specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(resolve(WEB_SRC, fromFile)), specifier)
      : null;
  if (!base) return null; // a package, not our source

  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    base,
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return relative(WEB_SRC, candidate);
    }
  }
  return null;
}

/**
 * Every first-party module reachable from `entries`, transitively.
 *
 * A fixed list of file paths is the wrong shape for this ban: it holds only for
 * the exact files somebody thought of. `resetClientState()` already calls into
 * `clear-local-storage.ts` and `current-account-store.ts`, and
 * `clear-local-storage.ts` is arguably the MORE natural home for "forget this
 * browser's user state" — so a fixed list would pass while the cookie died.
 * Walking the graph means a module cannot slip in behind the check.
 */
function importGraph(entries: string[]): string[] {
  const seen = new Set<string>();
  const queue = [...entries];

  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);

    const source = readFileSync(resolve(WEB_SRC, file), 'utf8');
    for (const match of source.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)) {
      const next = resolveLocal(match[1], file);
      if (next && !seen.has(next)) queue.push(next);
    }
  }

  return [...seen];
}

describe('the sign-out path leaves `kortix_last_project` alone', () => {
  // Load-bearing, not an oversight. The cookie is owner-bound
  // (`serializeLastProject`), so the next account cannot follow it, and the
  // middleware reads its OWNER half to attribute a bounce once identity
  // resolution has already returned `user: null` — which is what happens after
  // a logout and on the dominant session-expiry path. Deleting it on sign-out
  // un-attributes every post-logout bounce and re-opens the hole the
  // return-URL gate closes.
  // Two different bans, because they are two different mistakes.
  //
  // A module may NAME the cookie — `landing-destination.ts` declares the
  // constant and parses it — as long as it has no way to WRITE one. That is
  // checked as a capability, not as a hard-coded exemption, so the moment
  // somebody gives that module `cookies()` or `document.cookie` the ban applies
  // to it too.
  const COOKIE_NAMES = ['LAST_PROJECT_COOKIE', 'kortix_last_project'];
  // Task 5's symbol. A deleter by name — no module on this path may reach it,
  // capability argument or not.
  const DELETERS = ['clearLastProjectId'];

  /** Whether a module has any means of writing or deleting a cookie at all. */
  function canWriteCookies(file: string): boolean {
    const body = code(file);
    return (
      body.includes('next/headers') ||
      body.includes('document.cookie') ||
      body.includes('cookies()') ||
      body.includes('.cookies.set') ||
      body.includes('.cookies.delete')
    );
  }

  test('no module in the sign-out import GRAPH can delete the cookie', () => {
    const graph = importGraph([
      'lib/auth/perform-sign-out.ts',
      'lib/auth/sign-out-sequence.ts',
      'lib/auth/sign-out-actions.ts',
      'lib/utils/reset-client-state.ts',
    ]);

    // The walk has to actually reach past the entry points, or this test is a
    // fixed list wearing a graph's clothes. These two are the modules a future
    // "forget this browser's user state" change would most naturally land in,
    // and neither was covered by the path list this replaced.
    expect(graph).toContain('lib/utils/clear-local-storage.ts');
    expect(graph).toContain('stores/current-account-store.ts');
    expect(graph.length).toBeGreaterThan(6);

    for (const file of graph) {
      for (const deleter of DELETERS) {
        expect({ file, symbol: deleter, present: code(file).includes(deleter) }).toEqual({
          file,
          symbol: deleter,
          present: false,
        });
      }

      const named = COOKIE_NAMES.filter((name) => code(file).includes(name));
      if (named.length === 0) continue;
      expect({ file, named, writesCookies: canWriteCookies(file) }).toEqual({
        file,
        named,
        writesCookies: false,
      });
    }
  });

  test('no logout control names the cookie either', () => {
    // Direct, not transitive: these files import half the app, so their graphs
    // reach modules that legitimately own the cookie (the middleware's helpers).
    for (const control of CONTROLS) {
      for (const banned of [...COOKIE_NAMES, ...DELETERS]) {
        expect(code(control.file)).not.toContain(banned);
      }
    }
  });
});
