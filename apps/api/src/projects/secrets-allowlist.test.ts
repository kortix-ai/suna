// The per-session secrets allowlist is a pure NARROWING of the agent's secret
// grant. These tests pin that it can never WIDEN what a session receives — the
// whole security property — and that its canonical/conflict forms are correct.
import { describe, expect, test } from 'bun:test';
import {
  canonicalizeSecretsAllowlist,
  intersectSecretGrants,
  parseSessionSecretsAllowlist,
  resolveGrantedSecretEnv,
  secretKeyCollisionInAllowlist,
  secretsAllowlistPayloadConflicts,
  type ResolvedProjectSecret,
} from './secrets';

describe('intersectSecretGrants', () => {
  test('null/undefined allowlist is a passthrough (no session restriction)', () => {
    expect(intersectSecretGrants('all', null)).toBe('all');
    expect(intersectSecretGrants('all', undefined)).toBe('all');
    expect(intersectSecretGrants(['A', 'B'], null)).toEqual(['A', 'B']);
    expect(intersectSecretGrants(undefined, null)).toBeUndefined();
  });

  test('an "all"/undefined grant is narrowed to exactly the allowlist', () => {
    expect(intersectSecretGrants('all', ['A', 'B'])).toEqual(['A', 'B']);
    expect(intersectSecretGrants(undefined, ['A'])).toEqual(['A']);
    // [] means inject ZERO secrets even though the grant was "all".
    expect(intersectSecretGrants('all', [])).toEqual([]);
  });

  test('two lists intersect case-insensitively (only names in BOTH survive)', () => {
    expect(intersectSecretGrants(['A', 'B', 'C'], ['b', 'c', 'd'])).toEqual(['b', 'c']);
    expect(intersectSecretGrants(['STRIPE'], ['gmail'])).toEqual([]);
  });

  test('the result is ALWAYS a subset of the grant (never widens)', () => {
    const grant = ['GMAIL', 'STRIPE'];
    // An allowlist naming a secret the agent is NOT granted cannot add it back.
    const out = intersectSecretGrants(grant, ['GMAIL', 'AWS_ROOT']);
    expect(out).toEqual(['GMAIL']);
    expect(out).not.toContain('AWS_ROOT');
  });

  test('narrowing composes with resolveGrantedSecretEnv end-to-end', () => {
    const rows: ResolvedProjectSecret[] = [
      { identifier: 'GMAIL', key: 'GMAIL_TOKEN', value: 'g' },
      { identifier: 'STRIPE', key: 'STRIPE_KEY', value: 's' },
    ];
    // Agent grant 'all', session narrows to just GMAIL → only GMAIL_TOKEN injected.
    const narrowed = intersectSecretGrants('all', ['GMAIL']);
    const { env } = resolveGrantedSecretEnv(rows, narrowed);
    expect(env).toEqual({ GMAIL_TOKEN: 'g' });
  });
});

describe('canonicalizeSecretsAllowlist', () => {
  test('upper-cases, de-dupes, sorts; null stays null', () => {
    expect(canonicalizeSecretsAllowlist(['b', 'A', 'a'])).toEqual(['A', 'B']);
    expect(canonicalizeSecretsAllowlist([])).toEqual([]);
    expect(canonicalizeSecretsAllowlist(null)).toBeNull();
    expect(canonicalizeSecretsAllowlist(undefined)).toBeNull();
  });
});

describe('secretsAllowlistPayloadConflicts', () => {
  test('reorder / case / dupes do NOT conflict', () => {
    expect(secretsAllowlistPayloadConflicts(['A', 'B'], ['b', 'a'])).toBe(false);
    expect(secretsAllowlistPayloadConflicts(['A', 'A', 'B'], ['B', 'A'])).toBe(false);
  });
  test('a different identifier set conflicts', () => {
    expect(secretsAllowlistPayloadConflicts(['A'], ['A', 'B'])).toBe(true);
    expect(secretsAllowlistPayloadConflicts(['A'], ['B'])).toBe(true);
  });
  test('absence vs empty-list vs present are distinct', () => {
    expect(secretsAllowlistPayloadConflicts(null, [])).toBe(true);
    expect(secretsAllowlistPayloadConflicts(undefined, null)).toBe(false);
    expect(secretsAllowlistPayloadConflicts([], [])).toBe(false);
  });
});

describe('secretKeyCollisionInAllowlist', () => {
  const rows: ResolvedProjectSecret[] = [
    { identifier: 'GMAPS_PRIMARY', key: 'GOOGLE_MAPS_API_KEY', value: 'a' },
    { identifier: 'GMAPS_BACKUP', key: 'GOOGLE_MAPS_API_KEY', value: 'b' },
    { identifier: 'STRIPE', key: 'STRIPE_KEY', value: 's' },
  ];

  test('flags two allowlisted identifiers sharing one env KEY (would brick at boot)', () => {
    const c = secretKeyCollisionInAllowlist(rows, ['GMAPS_PRIMARY', 'GMAPS_BACKUP']);
    expect(c).toEqual({ key: 'GOOGLE_MAPS_API_KEY', identifiers: ['GMAPS_BACKUP', 'GMAPS_PRIMARY'] });
  });

  test('no collision when only one identifier per KEY is allowlisted', () => {
    expect(secretKeyCollisionInAllowlist(rows, ['GMAPS_PRIMARY', 'STRIPE'])).toBeNull();
    expect(secretKeyCollisionInAllowlist(rows, ['gmaps_backup'])).toBeNull(); // case-insensitive
    expect(secretKeyCollisionInAllowlist(rows, [])).toBeNull();
  });
});

describe('parseSessionSecretsAllowlist', () => {
  test('absent → ok/undefined; valid list passes through', () => {
    expect(parseSessionSecretsAllowlist(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseSessionSecretsAllowlist(['GMAIL', 'stripe-key'])).toEqual({
      ok: true,
      value: ['GMAIL', 'stripe-key'],
    });
    expect(parseSessionSecretsAllowlist([])).toEqual({ ok: true, value: [] });
  });
  test('rejects non-arrays, bad identifiers, and oversize lists', () => {
    expect(parseSessionSecretsAllowlist('GMAIL').ok).toBe(false);
    expect(parseSessionSecretsAllowlist([123]).ok).toBe(false);
    expect(parseSessionSecretsAllowlist(['has space']).ok).toBe(false);
    expect(parseSessionSecretsAllowlist(['_leading']).ok).toBe(false);
    expect(parseSessionSecretsAllowlist(Array.from({ length: 129 }, (_, i) => `S${i}`)).ok).toBe(
      false,
    );
  });
});
