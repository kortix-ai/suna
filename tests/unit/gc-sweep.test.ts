import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/core/env';
import {
  BROWSER_TEST_EMAIL_DOMAINS,
  resolveGcEmailDomains,
  runIdEmailPrefix,
  selectReclaimable,
} from '../src/fixtures/gc';

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
