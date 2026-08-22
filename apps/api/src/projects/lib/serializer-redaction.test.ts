import { describe, expect, test } from 'bun:test';
import { serializeSession } from './serializers';

/**
 * A row a caller cannot ACCESS must not carry that session's content.
 *
 * Session inventory removes rows the caller cannot open. This serializer stays
 * fail-closed because another caller can still pass `canAccess:false`. Such a
 * row must not carry metadata, prompts, titles, or secret allowlists.
 */
const row = (over: Record<string, unknown> = {}) =>
  ({
    sessionId: '11111111-1111-4111-8111-111111111111',
    accountId: 'a',
    projectId: 'p',
    branchName: 'b',
    baseRef: 'main',
    sandboxProvider: 'daytona',
    sandboxId: 's',
    sandboxUrl: null,
    opencodeSessionId: null,
    agentName: 'default',
    status: 'running',
    error: null,
    createdBy: 'wrapper',
    visibility: 'private',
    origin: 'backend',
    originRef: 'legacy-reference',
    secretsAllowlist: ['STRIPE_KEY'],
    connectorBindingsInheritUnbound: false,
    metadata: { initial_prompt: 'my private prompt', source: 'backend' },
    createdAt: new Date('2026-07-21T00:00:00.000Z'),
    updatedAt: new Date('2026-07-21T00:00:00.000Z'),
    ...over,
  }) as never;

describe('serializeSession redaction', () => {
  test('an inaccessible row carries no metadata or allowlist', () => {
    const out = serializeSession(row(), { canAccess: false }) as Record<string, unknown>;
    expect(out.can_access).toBe(false);
    expect(out.metadata).toEqual({});
    expect(out).not.toHaveProperty('end_user_ref');
    expect(out).not.toHaveProperty('origin_ref');
    expect(out.secrets_allowlist).toBeNull();
  });

  test('an inaccessible row leaks no CONVERSATION-DERIVED field either', () => {
    // name / custom_name / opencode_sessions are all computed FROM metadata
    // before the redaction, so redacting the metadata object alone left the
    // OpenCode-synced title (which summarises the conversation) and the
    // conversation-tree snapshot exposed.
    const out = serializeSession(
      row({
        metadata: {
          initial_prompt: 'secret',
          name: 'Migrating the payroll database',
          custom_name: 'Payroll migration',
          opencode_sessions: [{ id: 'oc1', title: 'Migrating the payroll database' }],
        },
      }),
      { canAccess: false },
    ) as Record<string, unknown>;
    expect(out.name).toBeNull();
    expect(out.custom_name).toBeNull();
    expect(out.opencode_sessions).toEqual([]);
  });

  test('an ACCESSIBLE row keeps its title and conversation tree', () => {
    const out = serializeSession(
      row({ metadata: { name: 'Migrating the payroll database', opencode_sessions: [{ id: 'oc1' }] } }),
      { canAccess: true },
    ) as Record<string, unknown>;
    expect(out.name).toBe('Migrating the payroll database');
    expect(out.opencode_sessions).toEqual([{ id: 'oc1' }]);
  });

  test('defensive redaction preserves only non-content identity fields', () => {
    const out = serializeSession(row(), { canAccess: false }) as Record<string, unknown>;
    expect(out.session_id).toBe('11111111-1111-4111-8111-111111111111');
    expect(out.status).toBe('running');
    expect(out.created_by).toBe('wrapper');
  });

  test('an accessible legacy row omits attribution fields', () => {
    const out = serializeSession(row(), { canAccess: true }) as Record<string, unknown>;
    expect(out.metadata).toEqual({ initial_prompt: 'my private prompt', source: 'backend' });
    expect(out).not.toHaveProperty('end_user_ref');
    expect(out).not.toHaveProperty('origin_ref');
    expect(out.secrets_allowlist).toEqual(['STRIPE_KEY']);
  });

  test('the default (no ctx) stays accessible — single-session reads are already gated', () => {
    const out = serializeSession(row()) as Record<string, unknown>;
    expect(out.can_access).toBe(true);
    expect(out).not.toHaveProperty('end_user_ref');
    expect(out).not.toHaveProperty('origin_ref');
  });
});
