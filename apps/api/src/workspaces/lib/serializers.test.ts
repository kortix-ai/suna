import { describe, expect, test } from 'bun:test';

import { serializeWorkspace } from './serializers';

// `metadata` is nullable: packages/db/src/schema/kortix.ts:330 declares
// jsonb('metadata').default({}) with NO .notNull(), which is why
// serializeWorkspace guards it with `?.`.
function workspaceRow(metadata: Record<string, unknown> | null) {
  return {
    workspaceId: '11111111-1111-4111-8111-111111111111',
    accountId: '22222222-2222-4222-8222-222222222222',
    name: 'demo',
    repoUrl: 'https://github.com/acme/demo.git',
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    idempotencyKey: null,
    status: 'active' as const,
    secretDefaultStrategy: 'runtime' as const,
    metadata,
    sandboxProviderGeneration: 0,
    lastOpenedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

describe('serializeWorkspace icon', () => {
  test('exposes a valid metadata.icon as a top-level field', () => {
    expect(serializeWorkspace(workspaceRow({ icon: '🚀' })).icon).toBe('🚀');
  });

  test('is null when metadata has no icon', () => {
    expect(serializeWorkspace(workspaceRow({})).icon).toBeNull();
  });

  test('is null when metadata.icon is malformed', () => {
    expect(serializeWorkspace(workspaceRow({ icon: 'not-an-emoji' })).icon).toBeNull();
  });

  test('is null when metadata.icon is oversized', () => {
    expect(serializeWorkspace(workspaceRow({ icon: 'x'.repeat(5000) })).icon).toBeNull();
  });

  test('is null when metadata itself is null', () => {
    expect(serializeWorkspace(workspaceRow(null)).icon).toBeNull();
  });

  test('metadata defaults to {} on the serialized project when the row is null', () => {
    expect(serializeWorkspace(workspaceRow(null)).metadata).toEqual({});
  });
});

describe('serializeWorkspace — icon_glyph', () => {
  test('a stored glyph is exposed as a top-level field', () => {
    const row = workspaceRow({ icon_glyph: { name: 'Rocket', color: 'blue' } });
    expect(serializeWorkspace(row).icon_glyph).toEqual({ name: 'Rocket', color: 'blue' });
  });

  test('no glyph is null, not undefined', () => {
    // The contract declares it `.nullable()`, matching `icon` and
    // `last_opened_at`. Returning undefined would drop the key from the JSON
    // and break a client that destructures it.
    expect(serializeWorkspace(workspaceRow({})).icon_glyph).toBeNull();
    expect(serializeWorkspace(workspaceRow(null)).icon_glyph).toBeNull();
  });

  test('a malformed stored glyph normalizes to null on READ', () => {
    // This is the read-path guarantee: a row hand-edited in the database
    // cannot put an unrenderable value in front of the UI.
    const row = workspaceRow({ icon_glyph: { name: 'Skull', color: 'red' } });
    expect(serializeWorkspace(row).icon_glyph).toBeNull();
  });

  test('a glyph and an emoji on the same row both serialize', () => {
    // The write paths make this state unreachable, but the serializer must not
    // assume that — a row predating the invariant would otherwise throw.
    const row = workspaceRow({ icon: '🚀', icon_glyph: { name: 'Star', color: 'red' } });
    const out = serializeWorkspace(row);
    expect(out.icon).toBe('🚀');
    expect(out.icon_glyph).toEqual({ name: 'Star', color: 'red' });
  });
});
