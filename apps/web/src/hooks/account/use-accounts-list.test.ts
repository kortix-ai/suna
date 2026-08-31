import { describe, expect, mock, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `useAccountsList` is the ONE reader of the account list, and the reason it
 * exists is a live cross-account defect, not tidiness.
 *
 * Before it, 13 components each hand-typed `useQuery({ queryKey: ['accounts'],
 * queryFn: listAccounts, staleTime: 60_000 })`. That literal carries no user,
 * so one document that saw two users held ONE cache entry for both. `/new`
 * resolves its create target out of that list, so a leftover single-account
 * list belonging to the PREVIOUS user made `POST /projects/provision` go out
 * with a foreign `account_id` under the new user's JWT — a 403.
 *
 * Eight of those 13 readers also had no `enabled` gate at all, so they fired
 * before `useAuth()` had resolved and wrote whatever came back into the shared
 * slot. Both halves of the fix — the user-scoped key and the identity gate —
 * are asserted here against the REAL object the hook hands `useQuery`, not
 * against its source text.
 */

// ── the pure half: options builder ──────────────────────────────────────────

const { accountsListQueryOptions, ACCOUNTS_STALE_TIME } = await import('./use-accounts-list');

describe('accountsListQueryOptions', () => {
  test('partitions the cache entry by signed-in user', () => {
    const a = accountsListQueryOptions('user_a').queryKey;
    const b = accountsListQueryOptions('user_b').queryKey;
    expect(a).not.toEqual(b as never);
    expect(a).toContain('user_a');
    expect(b).not.toContain('user_a');
  });

  // G2, fail closed. `undefined` is the real pre-auth render, not a
  // hypothetical: `AuthProvider` publishes `user: null` for at least one paint.
  test('is DISABLED while the signed-in user is unknown', () => {
    expect(accountsListQueryOptions(undefined).enabled).toBe(false);
    expect(accountsListQueryOptions(null).enabled).toBe(false);
  });

  test('is enabled once the user is known', () => {
    expect(accountsListQueryOptions('user_a').enabled).toBe(true);
  });

  // Two callers (`command-palette`, `add-to-project-modal`) only want the list
  // while a surface is open. Their condition must AND with the identity gate,
  // never replace it.
  test("ANDs the caller's own gate with the identity gate", () => {
    expect(accountsListQueryOptions('user_a', false).enabled).toBe(false);
    expect(accountsListQueryOptions('user_a', true).enabled).toBe(true);
    expect(accountsListQueryOptions(undefined, true).enabled).toBe(false);
  });

  // One shared freshness contract. `staleTime` is per-observer in React Query,
  // so 13 hand-written copies could drift apart and re-fetch each other's
  // entry; one constant is what makes "13 readers, one request" true.
  test('pins one shared staleTime for every reader', () => {
    expect(ACCOUNTS_STALE_TIME).toBe(60_000);
    expect(accountsListQueryOptions('user_a').staleTime).toBe(60_000);
  });
});

// ── the wired half: what the hook actually hands useQuery ────────────────────

describe('useAccountsList — the object handed to useQuery', () => {
  async function callHook(
    user: { id: string } | null,
    options?: Parameters<typeof import('./use-accounts-list').useAccountsList>[0],
  ) {
    const realQuery = await import('@tanstack/react-query');
    const realSdk = await import('@kortix/sdk');
    let captured: Record<string, unknown> | null = null;

    mock.module('@/features/providers/auth-provider', () => ({ useAuth: () => ({ user }) }));
    mock.module('@tanstack/react-query', () => ({
      ...realQuery,
      useQuery: (opts: Record<string, unknown>) => {
        captured = opts;
        return { data: undefined, isLoading: false };
      },
    }));

    const mod = await import('./use-accounts-list');
    mod.useAccountsList(options);
    if (!captured) throw new Error('useQuery was never called');
    return { captured: captured as Record<string, unknown>, listAccounts: realSdk.listAccounts };
  }

  test('keys the query by the signed-in user id', async () => {
    const { captured } = await callHook({ id: 'user_a' });
    expect(captured.queryKey).toContain('user_a');
  });

  test('two users never share a cache entry', async () => {
    const a = await callHook({ id: 'user_a' });
    const b = await callHook({ id: 'user_b' });
    expect(a.captured.queryKey).not.toEqual(b.captured.queryKey as never);
  });

  test('does not run at all while the user is unknown', async () => {
    const { captured } = await callHook(null);
    expect(captured.enabled).toBe(false);
  });

  test("ANDs a caller's gate with the identity gate", async () => {
    expect((await callHook({ id: 'user_a' }, { enabled: false })).captured.enabled).toBe(false);
    expect((await callHook(null, { enabled: true })).captured.enabled).toBe(false);
    expect((await callHook({ id: 'user_a' }, { enabled: true })).captured.enabled).toBe(true);
  });

  test('fetches through the SDK listAccounts, not a hand-rolled request', async () => {
    const { captured, listAccounts } = await callHook({ id: 'user_a' });
    expect(captured.queryFn).toBe(listAccounts);
  });

  // `/projects/start` is the one reader that retried; keeping its retry budget
  // is what makes this migration a key change and not a behaviour change (G1).
  test('passes a caller retry budget through, and sets none otherwise', async () => {
    expect((await callHook({ id: 'user_a' }, { retry: 3 })).captured.retry).toBe(3);
    expect((await callHook({ id: 'user_a' })).captured.retry).toBeUndefined();
  });
});

describe('useAccountsQueryKey', () => {
  // The two `setQueryData` writers seed the SAME entry the readers read. If
  // this key and the hook's key could ever differ, a freshly created account
  // would be written into a slot nothing renders.
  test('is byte-identical to the key useAccountsList reads', async () => {
    const realQuery = await import('@tanstack/react-query');
    let captured: Record<string, unknown> | null = null;

    mock.module('@/features/providers/auth-provider', () => ({
      useAuth: () => ({ user: { id: 'user_a' } }),
    }));
    mock.module('@tanstack/react-query', () => ({
      ...realQuery,
      useQuery: (opts: Record<string, unknown>) => {
        captured = opts;
        return { data: undefined };
      },
    }));

    const mod = await import('./use-accounts-list');
    mod.useAccountsList();
    expect(mod.useAccountsQueryKey()).toEqual(
      (captured as unknown as Record<string, unknown>).queryKey as never,
    );
  });
});

// ── the migration is total, and stays total ─────────────────────────────────

/**
 * Default-deny scan, the same shape as `packages/sdk/src/react/
 * query-key-literals.test.ts`. `apps/web/eslint.config.mjs` also bans this
 * literal, but eslint is a separate command from `bun test`; this makes a
 * reintroduced literal fail the SAME gate a broken unit test would.
 *
 * A PARTIAL migration is the thing being guarded against, not a stylistic
 * preference: two keyspaces for one resource means
 * `invalidateQueries({ queryKey: ['accounts'] })` from an unconverted surface
 * silently misses the user-scoped entry every reader is now on, and the list
 * renders stale with no error anywhere.
 */
function tsFilesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsFilesUnder(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("the bare ['accounts'] query key is gone from apps/web", () => {
  const SRC = join(import.meta.dir, '..', '..');

  test('no file constructs a query key from the bare accounts literal', () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(SRC)) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      for (const line of code.split('\n')) {
        // `'accounts'` only, never `'account'`: `['account', accountId]` is a
        // DIFFERENT, still-live family (one account's detail row, keyed by
        // account id, which already carries its own scope). Widening this to
        // `accounts?` swept nine of those in and would have turned a defect
        // fix into an unrelated migration.
        if (/queryKey:\s*\[\s*['"]accounts['"]/.test(line)) offenders.push(`${file}: ${line.trim()}`);
        if (/(setQueryData|getQueryData)\s*(<[^>]*>)?\(\s*\[\s*['"]accounts['"]\s*\]/.test(line)) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
