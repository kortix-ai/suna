/**
 * Source-level tripwires for the billing decision layer.
 *
 * `billing-gate-state.ts` has carried a docblock since PR #5141 naming the exact
 * defect — "the sidebar keyed off the raw balance" — that this repo then shipped
 * again anyway, and which produced a permanent red "Out of credits" alert on a
 * fully-running account for an entire billing period.
 *
 * Prose does not enforce anything. These tests do. They are deliberately crude
 * greps: the point is not to be clever, it is to fail loudly the moment a new
 * surface starts answering a billing question for itself.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const WEB_SRC = join(import.meta.dir, '..', '..');

/** The module that is ALLOWED to make these decisions, plus its own tests. */
const DECISION_LAYER = [
  join('lib', 'billing', 'billing-gate-state.ts'),
  join('lib', 'billing', 'billing-gate-state.test.ts'),
  join('lib', 'billing', 'billing-source-rules.test.ts'),
];

/**
 * Surfaces that legitimately RENDER a balance rather than deciding on it: admin
 * tables, ledger rows, transaction lists, and the store adapters that reshape
 * the number for display. Reading a balance is fine. Branching on it is not.
 */
const DISPLAY_ONLY = [
  join('app', 'admin'),
  join('features', 'billing', 'credit-transactions.tsx'),
  join('features', 'billing', 'transactions-table.tsx'),
  join('features', 'billing', 'account-overview.tsx'),
  join('stores', 'subscription-store.tsx'),
  join('hooks', 'billing'),
];

/**
 * Files that MATCH billing strings coming back from the API rather than
 * authoring them — Sentry noise filters keyed on the server's 402 message.
 * They are consumers of the wire format, not billing surfaces.
 */
const ERROR_NOISE_FILTERS = [
  join('lib', 'browser-error-noise.ts'),
  join('app', 'sentry-ignore-errors.test.ts'),
  'sentry.client.config.ts',
];

/**
 * Strip comments and import lines before scanning.
 *
 * Every one of these rules describes the SHIPPED behaviour of a file, and each
 * fix here deliberately leaves behind a comment quoting the bad pattern it
 * replaced — that history is the most valuable thing in these files and must
 * not be what trips the tripwire. Only executable source is scanned.
 */
function executableSource(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|import\b)/.test(line))
    .join('\n');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const FILES = walk(WEB_SRC).map((path) => ({
  path,
  rel: path.slice(WEB_SRC.length + 1),
  source: executableSource(readFileSync(path, 'utf8')),
}));

function candidates(exempt: string[]) {
  return FILES.filter(
    (file) => ![...DECISION_LAYER, ...exempt].some((allowed) => file.rel.startsWith(allowed)),
  );
}

describe('a balance is never turned into a decision outside the decision layer', () => {
  // `credits.total > 0`, `credits?.total <= 0`, `balance < 5`, and friends.
  const COMPARISON = /(credits\??\.total|\bbalance\b)\s*(<=|>=|<|>)\s*-?\d/;

  test('no surface compares a wallet balance against a numeric literal', () => {
    const offenders = candidates(DISPLAY_ONLY)
      .filter((file) => COMPARISON.test(file.source))
      .map((file) => file.rel);

    // The sidebar's `balance <= 0 ? 'empty' : balance < LOW_BALANCE_USD` is the
    // shape this catches. If you are here because a new file tripped it: the
    // answer is `walletSeverity()` / `billingStateAllowsRun()`, not a number.
    expect(offenders).toEqual([]);
  });
});

describe('no component writes its own billing prose', () => {
  const OWNED_STRINGS = [
    'Out of credits',
    'Low balance',
    'Payment issue on your plan',
    'seats are unaffected',
  ];

  test('the strings billingModalCopy/walletAlertCopy own appear nowhere else', () => {
    const offenders: string[] = [];
    for (const file of candidates(ERROR_NOISE_FILTERS)) {
      for (const owned of OWNED_STRINGS) {
        if (file.source.includes(owned)) offenders.push(`${file.rel} :: "${owned}"`);
      }
    }

    // A component that writes its own billing copy is a component that can
    // contradict the server — which is how a modal came to say "your Team plan
    // and seats are unaffected" to accounts with no seats, and "Out of credits"
    // to accounts with money. Import the copy instead.
    expect(offenders).toEqual([]);
  });
});

describe('the wallet-floor bypass stays deleted', () => {
  test('nothing on the web re-derives "a paying subscription may run without credit"', () => {
    const offenders = candidates([])
      .filter((file) => /bypass(es)?WalletFloor|bypassesTheFloor/i.test(file.source))
      .map((file) => file.rel);

    expect(offenders).toEqual([]);
  });

  test('the client fallback does not resurrect the per-seat exemption', () => {
    // The removed line was:
    //   if (accountHasLiveSubscription(state) && billing_model === 'per_seat')
    //     return 'active';
    // A rolling deploy is exactly when it would have mattered: an old API sends
    // no `billing_state`, the fallback runs, and a drained Team account renders
    // as runnable against a server that has already started 402ing it.
    const source = readFileSync(
      join(WEB_SRC, 'lib', 'billing', 'billing-gate-state.ts'),
      'utf8',
    );
    const fallback = source.slice(
      source.indexOf('Fallback derivation'),
      source.indexOf("return 'no_subscription';"),
    );
    expect(fallback).not.toMatch(/billing_model\s*===\s*'per_seat'[\s\S]{0,40}return 'active'/);
  });
});
