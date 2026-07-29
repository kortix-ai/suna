/**
 * BOUNDED SANDBOX LIFETIME — the one-off remediation script's non-SQL half.
 *
 * The SELECTION RULE is SQL and is tested against a real PostgreSQL with real
 * rows in packages/db/scripts/sandbox-deadline-migration.integration.test.ts
 * ("the remediation plan never selects a box that is doing work"). A mocked
 * driver would confirm nothing about a WHERE clause.
 *
 * What is worth pinning here is everything a mistyped command line depends on:
 * that DRY RUN IS THE DEFAULT, and that the plan a human reads never contains
 * a customer identifier — this repo is public and that output gets pasted into
 * issues.
 *
 * Lives under src/ rather than next to the script because apps/api's runner
 * discovers tests with `find src -name '*.test.ts'`; a test in scripts/ would
 * never run in CI, which for a script that stops production sandboxes is not
 * an acceptable place to put its only safety assertions.
 */
import { describe, expect, mock, test } from 'bun:test';

let rows: Record<string, unknown>[] = [];

mock.module('../../shared/db', () => ({
  db: { execute: async () => rows },
}));
mock.module('../../platform/providers', () => ({
  getProvider: () => ({
    stop: async () => {
      throw new Error('a unit test must never reach a provider');
    },
  }),
}));
mock.module('../reaping/sandbox-state-sync', () => ({
  applyStoppedState: async () => {
    throw new Error('a unit test must never stop a sandbox');
  },
}));

const { buildPlan, parseArgs } = await import('../../../scripts/remediate-wedged-sandboxes');

describe('parseArgs — the defaults are the safe ones', () => {
  test('DRY RUN IS THE DEFAULT', () => {
    expect(parseArgs([]).apply).toBe(false);
  });

  test('the caps default to a paced drain, not the whole fleet', () => {
    const options = parseArgs([]);
    expect(options.max).toBe(25);
    expect(options.perAccount).toBe(5);
    expect(options.minAgeHours).toBe(12);
    // Unpaced provider calls produced the snapshot rebuild storm and Daytona
    // 429s (PR #5193); a bulk drain is exactly that shape.
    expect(options.pauseMs).toBe(2000);
  });

  test('--apply is opt-in and explicit', () => {
    expect(parseArgs(['--apply']).apply).toBe(true);
  });

  test('a malformed numeric flag throws rather than silently defaulting', () => {
    // Silently falling back to 25 when the operator typed `--max 2 5` would
    // stop 25 boxes they did not ask for.
    expect(() => parseArgs(['--max', 'lots'])).toThrow(/--max must be a non-negative number/);
    expect(() => parseArgs(['--per-account', '-1'])).toThrow();
  });
});

describe('buildPlan — what a human ends up reading', () => {
  test('never emits an account, project or sandbox uuid', async () => {
    // This is a PUBLIC repo and this output gets pasted into issues and Slack.
    // A short stable ref is enough to see the concentration — one account holds
    // 117 of 187 boxes — without identifying the customer.
    rows = [
      {
        sandbox_id: '11111111-2222-3333-4444-555555555555',
        session_id: 'sess-1',
        account_id: '99999999-8888-7777-6666-555555555555',
        provider: 'daytona',
        external_id: 'box-1',
        status: 'active',
        metadata: { source: 'trigger:cron' },
        age_hours: 208.4,
        last_usage_age_ms: null,
        last_relay_age_ms: null,
      },
    ];
    const [plan] = await buildPlan(parseArgs([]));
    expect(plan?.accountRef).toBe('acct-99999999');
    expect(JSON.stringify(plan)).not.toContain('99999999-8888-7777-6666-555555555555');
  });

  test('reports "never" as null rather than as a huge number', async () => {
    // 156 of 187 running boxes have never emitted a usage event. Rendering that
    // as some enormous age would read as "very stale" instead of "no signal of
    // this kind exists", which are different facts for a BYOK box.
    rows = [
      {
        sandbox_id: 'a',
        session_id: 's',
        account_id: '00000000-0000-0000-0000-000000000000',
        provider: 'platinum',
        external_id: 'box-byok',
        status: 'active',
        metadata: {},
        age_hours: 100,
        last_usage_age_ms: null,
        last_relay_age_ms: 120_000,
      },
    ];
    const [plan] = await buildPlan(parseArgs([]));
    expect(plan?.lastUsageAgeHours).toBeNull();
    expect(plan?.lastRelayAgeHours).toBe(0);
  });

  test('carries metadata.source through, defaulting to unknown', async () => {
    rows = [
      {
        sandbox_id: 'a',
        session_id: 's',
        account_id: '00000000-0000-0000-0000-000000000000',
        provider: 'daytona',
        external_id: 'box-1',
        status: 'active',
        metadata: {},
        age_hours: 20,
        last_usage_age_ms: null,
        last_relay_age_ms: null,
      },
    ];
    expect((await buildPlan(parseArgs([])))[0]?.source).toBe('unknown');
  });
});
