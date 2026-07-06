/**
 * Unit tests for `buildSecretView` under the secrets v2 identifier model.
 * Authorization is centralized on the agent grant — this view carries no
 * per-secret sharing/inheritance signal anymore (secret sharing was retired).
 * The only remaining per-user nuance is the personal ("mine") override, used
 * today by the CODEX_AUTH_JSON per-user provider login.
 */
import { describe, expect, test } from 'bun:test';
import { buildSecretView } from '../projects/lib/serializers';

const OTHER = 'u-other';

function sharedRow(overrides: Partial<Record<string, unknown>> = {}): any {
  return {
    secretId: 's-1',
    projectId: 'p-1',
    identifier: 'STRIPE_KEY',
    name: 'STRIPE_KEY',
    valueEnc: 'enc',
    scope: 'runtime',
    ownerUserId: null,
    active: true,
    createdBy: OTHER,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function personalRow(overrides: Partial<Record<string, unknown>> = {}): any {
  return {
    secretId: 's-p',
    projectId: 'p-1',
    identifier: 'CODEX_AUTH_JSON',
    name: 'CODEX_AUTH_JSON',
    valueEnc: 'enc',
    scope: 'runtime',
    ownerUserId: 'u-me',
    active: true,
    createdBy: 'u-me',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('buildSecretView — identifier model', () => {
  test('a configured shared secret is usable and carries its identifier + key', () => {
    const v = buildSecretView({
      identifier: 'STRIPE_KEY',
      name: 'STRIPE_KEY',
      shared: sharedRow(),
      canManageShared: false,
    });
    expect(v.identifier).toBe('STRIPE_KEY');
    expect(v.name).toBe('STRIPE_KEY');
    expect(v.configured).toBe(true);
    expect(v.effective_source).toBe('shared');
    expect((v as any).usable_by_me).toBeUndefined();
    expect((v as any).share_scope).toBeUndefined();
    expect((v as any).agent_scope).toBeUndefined();
  });

  test('two identifiers may share the same key — each view is independent', () => {
    const primary = buildSecretView({
      identifier: 'GMAPS-primary',
      name: 'GOOGLE_MAPS_API_KEY',
      shared: sharedRow({ identifier: 'GMAPS-primary', name: 'GOOGLE_MAPS_API_KEY', secretId: 's-a' }),
      canManageShared: false,
    });
    const backup = buildSecretView({
      identifier: 'GMAPS-backup',
      name: 'GOOGLE_MAPS_API_KEY',
      shared: sharedRow({ identifier: 'GMAPS-backup', name: 'GOOGLE_MAPS_API_KEY', secretId: 's-b' }),
      canManageShared: false,
    });
    expect(primary.identifier).not.toBe(backup.identifier);
    expect(primary.name).toBe(backup.name);
    expect(primary.secret_id).not.toBe(backup.secret_id);
  });

  test('a personal-only row (no shared value yet) is not configured, but IS usable via mine', () => {
    const v = buildSecretView({
      identifier: 'CODEX_AUTH_JSON',
      name: 'CODEX_AUTH_JSON',
      personal: personalRow(),
      canManageShared: false,
    });
    expect(v.configured).toBe(false);
    expect(v.effective_source).toBe('mine');
  });

  test('a personal override (CODEX_AUTH_JSON) wins when active', () => {
    const v = buildSecretView({
      identifier: 'CODEX_AUTH_JSON',
      name: 'CODEX_AUTH_JSON',
      shared: sharedRow({ identifier: 'CODEX_AUTH_JSON', name: 'CODEX_AUTH_JSON' }),
      personal: personalRow(),
      canManageShared: false,
    });
    expect(v.mine).toEqual({ active: true, updated_at: '2026-01-01T00:00:00.000Z' });
    expect(v.effective_source).toBe('mine');
  });

  test('an inactive personal override falls back to the shared value', () => {
    const v = buildSecretView({
      identifier: 'CODEX_AUTH_JSON',
      name: 'CODEX_AUTH_JSON',
      shared: sharedRow({ identifier: 'CODEX_AUTH_JSON', name: 'CODEX_AUTH_JSON' }),
      personal: personalRow({ active: false }),
      canManageShared: false,
    });
    expect(v.effective_source).toBe('shared');
  });

  test('can_manage_shared is false for system (KORTIX_*) secrets regardless of role', () => {
    const v = buildSecretView({
      identifier: 'KORTIX_INTERNAL',
      name: 'KORTIX_INTERNAL',
      shared: sharedRow({ identifier: 'KORTIX_INTERNAL', name: 'KORTIX_INTERNAL' }),
      canManageShared: true,
    });
    expect(v.system).toBe(true);
    expect(v.can_manage_shared).toBe(false);
  });
});
