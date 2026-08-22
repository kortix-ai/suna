import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/core/env';
import {
  BROWSER_TEST_EMAIL_DOMAINS,
  type GcDb,
  gcDbSsl,
  isSessionReclaimed,
  listLiveSessions,
  ownedAccountIdsViaDb,
  resolveGcEmailDomains,
  revokeAccountTokens,
  runIdEmailPrefix,
  selectReclaimable,
} from '../src/fixtures/gc';

/** Records every statement so a test can assert what the sweep actually ran. */
function fakeDb(rows: any[] = []): GcDb & { calls: Array<{ text: string; values?: unknown[] }> } {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  return {
    calls,
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values });
      return { rows };
    },
    async end() {},
  };
}

const env = { testEmailDomain: 'ke2e.kortix.test' } as Env;

afterEach(() => {
  delete process.env.KE2E_GC_EMAIL_DOMAINS;
});

describe('gc email domains', () => {
  it('sweeps the ke2e domain and the browser suite domains', () => {
    // Before this list the filter was `%@ke2e.kortix.test` only, so the sweep
    // reclaimed ZERO Playwright accounts.
    const domains = resolveGcEmailDomains(env);
    expect(domains).toContain('ke2e.kortix.test');
    for (const domain of BROWSER_TEST_EMAIL_DOMAINS) expect(domains).toContain(domain);
  });

  it('is overridable and de-duplicated', () => {
    process.env.KE2E_GC_EMAIL_DOMAINS = '@one.test, two.test ,one.test';
    expect(resolveGcEmailDomains(env)).toEqual(['one.test', 'two.test']);
  });

  it('refuses a domain that is not reserved', () => {
    process.env.KE2E_GC_EMAIL_DOMAINS = 'kortix.com';
    expect(() => resolveGcEmailDomains(env)).toThrow('only reserved TLDs');
  });
});

describe('gc selection', () => {
  const at = (iso: string) => Date.parse(iso);
  const users = [
    { id: 'u1', email: 'e2e-4242-a1b2-owner-x@ke2e.kortix.test', created_at: '2026-08-19T12:00:00Z' },
    { id: 'u2', email: 'e2e-9999-c3d4-owner-y@ke2e.kortix.test', created_at: '2026-08-19T12:00:00Z' },
    { id: 'u3', email: 'old-account@ke2e.kortix.test', created_at: '2026-08-01T00:00:00Z' },
    { id: 'u4', email: 'billing-browser-1@example.test', created_at: '2026-08-01T00:00:00Z' },
  ];

  it('reclaims one run at any age without touching a concurrent run', () => {
    const selected = selectReclaimable(users, { runId: '4242' }).map((u) => u.id);
    expect(selected).toEqual(['u1']);
  });

  it('reclaims by age when no run id is given', () => {
    const selected = selectReclaimable(users, { cutoff: at('2026-08-10T00:00:00Z') }).map(
      (u) => u.id,
    );
    expect(selected).toEqual(['u3', 'u4']);
  });

  it('unions the run id and the age window when both are given', () => {
    const selected = selectReclaimable(users, {
      cutoff: at('2026-08-10T00:00:00Z'),
      runId: '4242',
    }).map((u) => u.id);
    expect(selected).toEqual(['u1', 'u3', 'u4']);
  });

  it('selects nothing when neither filter matches', () => {
    expect(selectReclaimable(users, { runId: 'nope' })).toEqual([]);
  });

  it('matches the run-scoped prefix principals.ts actually mints', () => {
    // principals.ts:36 — `e2e-${runId}-${label}-…@${env.testEmailDomain}`.
    expect(runIdEmailPrefix('4242-api1')).toBe('e2e-4242-api1-');
    expect(
      selectReclaimable(
        [{ id: 'u5', email: 'e2e-4242-api1-owner-z@ke2e.kortix.test' }],
        { runId: '4242' },
      ),
    ).toHaveLength(1);
  });
});

describe('gc database connection', () => {
  it('uses no TLS locally and a permissive chain against Supabase', () => {
    // Supabase's direct Postgres endpoint presents a chain Node's default trust
    // store rejects; that rejection killed both sweeps on run 32222342409.
    expect(gcDbSsl('postgres://u:p@127.0.0.1:54322/postgres')).toBe(false);
    expect(gcDbSsl('postgres://u:p@localhost:54322/postgres')).toBe(false);
    expect(gcDbSsl('postgres://u:p@db.abc.supabase.co:5432/postgres')).toEqual({
      rejectUnauthorized: false,
    });
  });
});

describe('gc token revocation', () => {
  it('sets BOTH status and revoked_at', async () => {
    // The sweep used to stamp revoked_at alone while validateAccountToken gated
    // on status alone, so 186 "Connector Session" tokens kept authenticating
    // after a "successful" revoke.
    const db = fakeDb([{ token_id: 't1' }, { token_id: 't2' }]);

    const revoked = await revokeAccountTokens(db, ['acct-1', 'acct-2']);

    expect(revoked).toBe(2);
    const sql = db.calls[0]!.text;
    expect(sql).toContain("status = 'revoked'");
    expect(sql).toContain('revoked_at = now()');
    expect(db.calls[0]!.values).toEqual([['acct-1', 'acct-2']]);
  });

  it('also heals a row already left status=active with revoked_at set', async () => {
    const db = fakeDb([]);
    await revokeAccountTokens(db, ['acct-1']);
    expect(db.calls[0]!.text).toContain("revoked_at IS NULL OR status = 'active'");
  });

  it('runs no statement when the user owns nothing', async () => {
    const db = fakeDb([]);
    expect(await revokeAccountTokens(db, [])).toBe(0);
    expect(db.calls).toHaveLength(0);
  });
});

describe('gc live-session lookup', () => {
  it('selects a live session AND a settled session whose box is still alive', async () => {
    // Run 32231251280 left 47 sessions whose project_sessions row was already
    // settled but whose session_sandboxes row still carried an external_id.
    const db = fakeDb([{ session_id: 's1', project_id: 'p1' }]);

    const sessions = await listLiveSessions(db, ['acct-1']);

    expect(sessions).toEqual([{ sessionId: 's1', projectId: 'p1' }]);
    const sql = db.calls[0]!.text;
    expect(sql).toContain("s.status IN ('queued', 'branching', 'provisioning', 'running')");
    expect(sql).toContain("sb.external_id IS NOT NULL");
    expect(sql).toContain("sb.status IN ('provisioning', 'active', 'error')");
  });

  it('runs no statement when the user owns nothing', async () => {
    const db = fakeDb([]);
    expect(await listLiveSessions(db, [])).toEqual([]);
    expect(db.calls).toHaveLength(0);
  });
});

describe('gc owned accounts', () => {
  it('reads owner memberships straight from the database', async () => {
    // The API path needs a password grant the Playwright lane's users do not
    // have; this one works wherever KE2E_DATABASE_URL is set.
    const db = fakeDb([{ account_id: 'acct-1' }, { account_id: 'acct-2' }]);

    expect(await ownedAccountIdsViaDb(db, 'user-1')).toEqual(['acct-1', 'acct-2']);
    expect(db.calls[0]!.text).toContain("account_role = 'owner'");
    expect(db.calls[0]!.values).toEqual(['user-1']);
  });
});

describe('gc stop-response classification', () => {
  it('counts already-stopped and already-gone as reclaimed', () => {
    expect(isSessionReclaimed(200)).toBe(true);
    expect(isSessionReclaimed(204)).toBe(true);
    // 409 "not running" and 404 "gone" ARE the desired end state — counting them
    // as failures would make a clean sweep look broken.
    expect(isSessionReclaimed(409)).toBe(true);
    expect(isSessionReclaimed(404)).toBe(true);
  });

  it('counts a refusal or a server error as not reclaimed', () => {
    expect(isSessionReclaimed(401)).toBe(false);
    expect(isSessionReclaimed(403)).toBe(false);
    expect(isSessionReclaimed(500)).toBe(false);
    expect(isSessionReclaimed(502)).toBe(false);
  });
});
