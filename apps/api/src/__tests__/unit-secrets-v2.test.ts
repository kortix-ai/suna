/**
 * Unit tests for the secrets v2 identifier model's pure logic:
 *   - isValidIdentifier / identifierKeyConflicts (validation)
 *   - resolveGrantedSecretEnv (the whole agent-grant-by-identifier decision)
 *   - pickResolvedSecretRow (BYOK gateway shared-vs-private precedence)
 *
 * This is the SOLE authorization gate on agent secret access — there is no
 * resource-side agent allow-list and no per-secret member/group sharing.
 */
import { describe, expect, test } from 'bun:test';
import {
  AmbiguousSecretGrantError,
  identifierKeyConflicts,
  isValidIdentifier,
  pickResolvedSecretRow,
  resolveGrantedSecretEnv,
  type ResolvedProjectSecret,
} from '../projects/secrets';
import { agentMayUseEnv } from '../iam/agent-scope';
import type { AgentGrant } from '@kortix/db';

describe('isValidIdentifier', () => {
  test('accepts env-var-shaped keys (the default/migrated case)', () => {
    expect(isValidIdentifier('OPENAI_API_KEY')).toBe(true);
  });

  test('accepts profile-like identifiers with hyphens/dots', () => {
    expect(isValidIdentifier('GMAPS-primary')).toBe(true);
    expect(isValidIdentifier('gmaps.backup')).toBe(true);
  });

  test('rejects empty / leading-punctuation / overlong identifiers', () => {
    expect(isValidIdentifier('')).toBe(false);
    expect(isValidIdentifier('-leading-dash')).toBe(false);
    expect(isValidIdentifier('a'.repeat(129))).toBe(false);
  });
});

describe('identifierKeyConflicts', () => {
  test('no existing row → never a conflict (create path)', () => {
    expect(identifierKeyConflicts(null, 'GOOGLE_MAPS_API_KEY')).toBe(false);
  });

  test('same key re-submitted (value/no-op edit) → not a conflict', () => {
    expect(identifierKeyConflicts('GOOGLE_MAPS_API_KEY', 'GOOGLE_MAPS_API_KEY')).toBe(false);
  });

  test('different key under an existing identifier → conflict, rejected', () => {
    expect(identifierKeyConflicts('GOOGLE_MAPS_API_KEY', 'OPENAI_API_KEY')).toBe(true);
  });
});

const row = (identifier: string, key: string, value: string): ResolvedProjectSecret => ({
  identifier,
  key,
  value,
});

describe('resolveGrantedSecretEnv', () => {
  test('undefined grant (back-compat) behaves as "all"', () => {
    const { env, identifiers } = resolveGrantedSecretEnv(
      [row('OPENAI_API_KEY', 'OPENAI_API_KEY', 'sk-1')],
      undefined,
    );
    expect(env).toEqual({ OPENAI_API_KEY: 'sk-1' });
    expect(identifiers).toEqual(['OPENAI_API_KEY']);
  });

  test("'all' injects every identifier's key=value", () => {
    const { env } = resolveGrantedSecretEnv(
      [row('OPENAI_API_KEY', 'OPENAI_API_KEY', 'sk-1'), row('STRIPE_KEY', 'STRIPE_KEY', 'sk-2')],
      'all',
    );
    expect(env).toEqual({ OPENAI_API_KEY: 'sk-1', STRIPE_KEY: 'sk-2' });
  });

  test('explicit list narrows to only the granted identifiers (case-insensitive)', () => {
    const { env, identifiers } = resolveGrantedSecretEnv(
      [row('OPENAI_API_KEY', 'OPENAI_API_KEY', 'sk-1'), row('STRIPE_KEY', 'STRIPE_KEY', 'sk-2')],
      ['openai_api_key'],
    );
    expect(env).toEqual({ OPENAI_API_KEY: 'sk-1' });
    expect(identifiers).toEqual(['OPENAI_API_KEY']);
  });

  test('empty explicit list grants nothing', () => {
    const { env } = resolveGrantedSecretEnv([row('OPENAI_API_KEY', 'OPENAI_API_KEY', 'sk-1')], []);
    expect(env).toEqual({});
  });

  test('a granted identifier not present in the project is simply absent (no error)', () => {
    const { env } = resolveGrantedSecretEnv(
      [row('OPENAI_API_KEY', 'OPENAI_API_KEY', 'sk-1')],
      ['DELETED_IDENTIFIER'],
    );
    expect(env).toEqual({});
  });

  test("'all': two identifiers sharing a key resolve deterministically (alphabetically-first identifier wins), never throws", () => {
    const { env } = resolveGrantedSecretEnv(
      [
        row('GMAPS-primary', 'GOOGLE_MAPS_API_KEY', 'primary-val'),
        row('GMAPS-backup', 'GOOGLE_MAPS_API_KEY', 'backup-val'),
      ],
      'all',
    );
    // 'GMAPS-backup' < 'GMAPS-primary' alphabetically.
    expect(env).toEqual({ GOOGLE_MAPS_API_KEY: 'backup-val' });
  });

  test('explicit list granting TWO identifiers that share a key is ambiguous — throws', () => {
    expect(() =>
      resolveGrantedSecretEnv(
        [
          row('GMAPS-primary', 'GOOGLE_MAPS_API_KEY', 'primary-val'),
          row('GMAPS-backup', 'GOOGLE_MAPS_API_KEY', 'backup-val'),
        ],
        ['GMAPS-primary', 'GMAPS-backup'],
      ),
    ).toThrow(AmbiguousSecretGrantError);
  });

  test('explicit list granting ONE of two same-key identifiers is fine (the whole point of the model)', () => {
    const { env } = resolveGrantedSecretEnv(
      [
        row('GMAPS-primary', 'GOOGLE_MAPS_API_KEY', 'primary-val'),
        row('GMAPS-backup', 'GOOGLE_MAPS_API_KEY', 'backup-val'),
      ],
      ['GMAPS-backup'],
    );
    expect(env).toEqual({ GOOGLE_MAPS_API_KEY: 'backup-val' });
  });
});

describe('pickResolvedSecretRow — BYOK gateway shared-vs-private fallback', () => {
  const KEY = 'ANTHROPIC_API_KEY';
  const sharedRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
    identifier: KEY,
    ownerUserId: null,
    valueEnc: 'shared-value',
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  });
  const privateRow = (ownerUserId: string, overrides: Partial<Record<string, unknown>> = {}) => ({
    identifier: KEY,
    ownerUserId,
    valueEnc: `private-value-${ownerUserId}`,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  });

  test('no rows at all → null', () => {
    expect(pickResolvedSecretRow([], KEY, 'user-a')).toBeNull();
  });

  test('only a shared row → shared row resolves', () => {
    const shared = sharedRow();
    expect(pickResolvedSecretRow([shared], KEY, 'user-a')).toBe(shared);
  });

  test("own-session fallback: only the caller's own private row exists → it resolves", () => {
    const mine = privateRow('user-a');
    expect(pickResolvedSecretRow([mine], KEY, 'user-a')).toBe(mine);
  });

  test('shared key still wins when both a shared row and the caller\'s private row exist', () => {
    const shared = sharedRow();
    const mine = privateRow('user-a');
    expect(pickResolvedSecretRow([shared, mine], KEY, 'user-a')).toBe(shared);
  });

  test("another member's private row is never selected for a different caller (no shared configured)", () => {
    const someoneElses = privateRow('user-b');
    expect(pickResolvedSecretRow([someoneElses], KEY, 'user-a')).toBeNull();
  });

  test('no acting user (e.g. webhook-triggered session) never falls back to a private row', () => {
    const mine = privateRow('user-a');
    expect(pickResolvedSecretRow([mine], KEY, null)).toBeNull();
  });

  test('multiple identifiers sharing a KEY: the canonical (identifier === key) row wins among same-scope duplicates', () => {
    const canonical = sharedRow({ identifier: KEY, valueEnc: 'canonical' });
    const alias = sharedRow({ identifier: 'ANTHROPIC-backup', valueEnc: 'alias', updatedAt: new Date('2026-02-01T00:00:00Z') });
    expect(pickResolvedSecretRow([alias, canonical], KEY, 'user-a')).toBe(canonical);
  });
});

describe('agentMayUseEnv — the sole agent secret-access gate, by identifier', () => {
  const grant = (env: AgentGrant['env']): AgentGrant => ({ agent: 'a', kortixCli: [], connectors: [], env });

  test('no grant (non-agent token) → unrestricted', () => {
    expect(agentMayUseEnv(null, 'GMAPS-primary')).toBe(true);
  });

  test("grant.env omitted or 'all' → unrestricted", () => {
    expect(agentMayUseEnv(grant(undefined), 'GMAPS-primary')).toBe(true);
    expect(agentMayUseEnv(grant('all'), 'GMAPS-primary')).toBe(true);
  });

  test('explicit list gates by IDENTIFIER, not key, case-insensitively', () => {
    const g = grant(['gmaps-primary']);
    expect(agentMayUseEnv(g, 'GMAPS-primary')).toBe(true);
    expect(agentMayUseEnv(g, 'GMAPS-backup')).toBe(false);
  });

  test('empty list denies everything', () => {
    expect(agentMayUseEnv(grant([]), 'GMAPS-primary')).toBe(false);
  });
});
