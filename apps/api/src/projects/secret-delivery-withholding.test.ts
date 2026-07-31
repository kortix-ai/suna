import { describe, expect, test } from 'bun:test';

import { type ResolvedProjectSecret, withholdUndeliverable } from './secrets';

const row = (
  identifier: string,
  key: string,
  extra: Partial<ResolvedProjectSecret> = {},
): ResolvedProjectSecret => ({
  identifier,
  key,
  value: `value-of-${identifier}`,
  ...extra,
});

/** The env map as `resolveGrantedSecretEnv` would have produced it. */
const envFor = (rows: ResolvedProjectSecret[]): Record<string, string> =>
  Object.fromEntries(rows.map((r) => [r.key, r.value]));

describe('withholdUndeliverable', () => {
  test('a project with no strategies set is byte-identical to before', () => {
    // The back-compat guarantee. Every existing row has strategy `runtime` (the
    // column default) or, for a row read before the column existed, undefined —
    // and neither may remove anything.
    const rows = [row('gmail', 'GMAIL_TOKEN'), row('stripe', 'STRIPE_KEY', { strategy: 'runtime' })];
    const env = envFor(rows);
    withholdUndeliverable(rows, env, 'sess-1');
    expect(env).toEqual({ GMAIL_TOKEN: 'value-of-gmail', STRIPE_KEY: 'value-of-stripe' });
  });

  test('DENIED is withheld — the whole point', () => {
    const rows = [row('gmail', 'GMAIL_TOKEN'), row('stripe', 'STRIPE_KEY', { strategy: 'denied' })];
    const env = envFor(rows);
    withholdUndeliverable(rows, env, 'sess-1');
    expect(env).toEqual({ GMAIL_TOKEN: 'value-of-gmail' });
    expect(env.STRIPE_KEY).toBeUndefined();
  });

  test('denied is withheld even with no session — nothing can resurrect it', () => {
    const rows = [row('stripe', 'STRIPE_KEY', { strategy: 'denied' })];
    const env = envFor(rows);
    withholdUndeliverable(rows, env, null);
    expect(env).toEqual({});
  });

  test('a BROKER row is withheld when there is no session to mint a handle against', () => {
    // Fail closed. Falling back to plaintext here would defeat the entire
    // mechanism at exactly the moment it is hardest to notice.
    const rows = [row('anthropic', 'ANTHROPIC_API_KEY', { strategy: 'broker' })];
    const env = envFor(rows);
    withholdUndeliverable(rows, env, null);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test('THE SHARED KEY: a live runtime row keeps the KEY its denied sibling shares', () => {
    // Two identifiers may resolve to ONE env KEY — deliberate, so an agent can be
    // granted one specific value among several candidates for the same variable.
    // Dropping the KEY because one of them is denied would break a session that
    // is legitimately using the other.
    const rows = [
      row('gmaps-primary', 'GMAPS_KEY', { strategy: 'denied' }),
      row('gmaps-backup', 'GMAPS_KEY', { strategy: 'runtime' }),
    ];
    const env = { GMAPS_KEY: 'value-of-gmaps-backup' };
    withholdUndeliverable(rows, env, 'sess-1');
    expect(env.GMAPS_KEY).toBe('value-of-gmaps-backup');
  });

  test('...but a KEY every identifier denies IS dropped', () => {
    const rows = [
      row('gmaps-primary', 'GMAPS_KEY', { strategy: 'denied' }),
      row('gmaps-backup', 'GMAPS_KEY', { strategy: 'denied' }),
    ];
    const env = { GMAPS_KEY: 'whichever-won' };
    withholdUndeliverable(rows, env, 'sess-1');
    expect(env.GMAPS_KEY).toBeUndefined();
  });

  test('a KEY absent from env is not resurrected by a deliverable row', () => {
    // The agent grant may already have excluded it upstream. This function only
    // ever narrows; it must never add.
    const rows = [row('gmail', 'GMAIL_TOKEN', { strategy: 'runtime' })];
    const env: Record<string, string> = {};
    withholdUndeliverable(rows, env, 'sess-1');
    expect(env).toEqual({});
  });

  test('an empty row set leaves env untouched', () => {
    const env = { SOMETHING: 'x' };
    withholdUndeliverable([], env, 'sess-1');
    expect(env).toEqual({ SOMETHING: 'x' });
  });
});

describe('only GRANTED rows may vote on a shared key (Strix HIGH)', () => {
  test('an UNGRANTED runtime sibling cannot keep a denied secret alive', () => {
    // The hole: `env` is produced by resolveGrantedSecretEnv, which drops rows
    // outside the agent grant. Feeding the FULL row set to the withholding pass
    // let one of those dropped rows mark a shared KEY deliverable — so the KEY
    // survived holding the DENIED sibling's plaintext, which is the one value
    // that must never reach the box.
    //
    // The caller now passes only the granted rows. This test models what the
    // caller is required to hand over.
    const denied = row('gmaps-primary', 'GMAPS_KEY', { strategy: 'denied' });
    const ungrantedSibling = row('gmaps-backup', 'GMAPS_KEY', { strategy: 'runtime' });
    const env = { GMAPS_KEY: denied.value };

    // Only `denied` was granted, so only it is passed in.
    withholdUndeliverable([denied], env, 'sess-1');
    expect(env.GMAPS_KEY).toBeUndefined();

    // Sanity: had the ungranted sibling been included, the key would survive —
    // which is precisely the bug.
    const envIfBuggy = { GMAPS_KEY: denied.value };
    withholdUndeliverable([denied, ungrantedSibling], envIfBuggy, 'sess-1');
    expect(envIfBuggy.GMAPS_KEY).toBe(denied.value);
  });
});
