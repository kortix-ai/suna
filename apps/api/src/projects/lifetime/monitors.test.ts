/**
 * BOUNDED SANDBOX LIFETIME — the monitors' shapes and the alert arithmetic.
 *
 * The SQL itself is exercised against a real PostgreSQL, with real rows, in
 * packages/db/scripts/sandbox-deadline-migration.integration.test.ts — a mocked
 * driver would happily accept a query Postgres rejects, which is the one thing
 * a monitor must never do (it would go quiet and read as healthy).
 *
 * What is worth pinning HERE is the arithmetic an alert threshold is written
 * against, and the promise that neither monitor can be slowed down by the thing
 * it monitors.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type KilledWithLiveTurn, rePromptAfterDeadlineStopRate } from './monitors';

function m2(overrides: Partial<KilledWithLiveTurn> = {}): KilledWithLiveTurn {
  return {
    stoppedWithRecentProgress: 0,
    deadlineStops: 0,
    rePromptedWithin10Min: 0,
    runCapStops: 0,
    ...overrides,
  };
}

describe('rePromptAfterDeadlineStopRate — the lagging, user-visible indicator', () => {
  test('is null when nothing was stopped, NOT zero', () => {
    // "0% of nothing" and "0% of 300" are different facts. Collapsing them is
    // how a broken pipeline reads as a healthy one — and this is the alert the
    // whole "did we kill someone's turn" question rests on.
    expect(rePromptAfterDeadlineStopRate(m2())).toBeNull();
  });

  test('computes the rate the 5% alert is written against', () => {
    expect(
      rePromptAfterDeadlineStopRate(m2({ deadlineStops: 100, rePromptedWithin10Min: 3 })),
    ).toBe(0.03);
  });

  test('a fleet-wide mid-turn kill reads as 1.0, not as a rounding artefact', () => {
    expect(
      rePromptAfterDeadlineStopRate(m2({ deadlineStops: 40, rePromptedWithin10Min: 40 })),
    ).toBe(1);
  });
});

describe('the monitors cannot be starved by what they monitor', () => {
  test('neither talks to a provider', () => {
    // A monitor that can be slowed down or 429'd by the provider is a monitor
    // that goes quiet exactly when it matters — and this repo has a documented
    // Daytona 429 history plus a maintenance loop that once hung for days on an
    // unbounded provider call.
    const source = readFileSync(resolve(import.meta.dir, 'monitors.ts'), 'utf8');
    expect(source).not.toContain('platform/providers');
    expect(source).not.toContain('getProvider');
  });

  test('M2 keys on metadata.deadlineStop, which only an ENFORCING stop writes', () => {
    // This is what makes M2 a real assertion in shadow mode rather than a
    // placeholder: it must read 0 until enforcement is on, so a non-zero value
    // means something is stamping stops that should not exist yet.
    const source = readFileSync(resolve(import.meta.dir, 'monitors.ts'), 'utf8');
    expect(source).toContain("'deadlineStop'");
  });
});
