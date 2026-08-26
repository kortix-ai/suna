import { describe, expect, test } from 'bun:test';
import {
  LIST_OMITTED_SESSION_METADATA_KEYS,
  serializeSession,
} from './serializers';

/**
 * The inventory LIST drops the write-only heavy metadata keys; the
 * single-session read keeps metadata whole.
 *
 * On a real 60-session project those five keys are 57% of the whole list body
 * (`initial_prompt` alone 36%), and the sidebar re-fetches the list several
 * times per session open. No client reads any of them back — verified by an
 * exhaustive read-side sweep of apps/web, apps/mobile, packages/sdk and
 * apps/whitelabel-demo (2026-08-26). These tests pin BOTH halves of that
 * contract: the five go, and everything a client actually reads stays.
 */
const CLIENT_READ_METADATA = {
  // Read off the LIST response by apps/web.
  pending_prompt: 'recover me',
  session_name: 'legacy title',
  last_activity_at: '2026-08-26T00:00:00.000Z',
  spawned_by_session: '22222222-2222-4222-8222-222222222222',
  legacy_migration: { from: 'suna' },
  source: 'slack',
  trigger_source: 'cron',
  trigger_type: 'cron',
  trigger_slug: 'nightly-watch',
  // Read off the SINGLE-session response.
  sandbox_slug: 'essentia',
  opencode_model: 'kortix/codex/gpt-5.6-sol',
  warm: true,
};

const HEAVY_METADATA = {
  initial_prompt: 'a very long operator prompt '.repeat(40),
  payload_summary: { cron: { schedule: '0 6 * * *' } },
  session_start_timeline: { totalMs: 698, marks: [{ label: 'kicked', atMs: 698 }] },
  audit_v2: { actor_type: 'system', delegation_depth: 0 },
  remote_branch: { branch: 'b', status: 'ready' },
};

const row = (over: Record<string, unknown> = {}) =>
  ({
    sessionId: '11111111-1111-4111-8111-111111111111',
    accountId: 'a',
    projectId: 'p',
    branchName: 'b',
    baseRef: 'main',
    sandboxProvider: 'e2b',
    sandboxId: 's',
    sandboxUrl: null,
    opencodeSessionId: null,
    agentName: 'default',
    status: 'stopped',
    error: null,
    createdBy: 'u1',
    visibility: 'private',
    origin: 'user',
    originRef: null,
    secretsAllowlist: null,
    connectorBindingsInheritUnbound: false,
    metadata: { ...HEAVY_METADATA, ...CLIENT_READ_METADATA },
    createdAt: new Date('2026-08-26T00:00:00.000Z'),
    updatedAt: new Date('2026-08-26T00:00:00.000Z'),
    ...over,
  }) as never;

describe('list metadata trimming', () => {
  test('the list drops every write-only heavy key', () => {
    const out = serializeSession(row(), { trimListMetadata: true }) as Record<string, unknown>;
    const metadata = out.metadata as Record<string, unknown>;

    for (const key of LIST_OMITTED_SESSION_METADATA_KEYS) {
      expect(metadata).not.toHaveProperty(key);
    }
  });

  test('the list keeps every key a client actually reads', () => {
    const out = serializeSession(row(), { trimListMetadata: true }) as Record<string, unknown>;
    const metadata = out.metadata as Record<string, unknown>;

    for (const [key, value] of Object.entries(CLIENT_READ_METADATA)) {
      expect(metadata[key]).toEqual(value);
    }
  });

  test('the single-session read still returns metadata whole', () => {
    const out = serializeSession(row()) as Record<string, unknown>;

    expect(out.metadata).toEqual({ ...HEAVY_METADATA, ...CLIENT_READ_METADATA });
  });

  test('trimming never mutates the row it was handed', () => {
    const source = row();
    const before = JSON.stringify((source as { metadata: unknown }).metadata);
    serializeSession(source, { trimListMetadata: true });

    expect(JSON.stringify((source as { metadata: unknown }).metadata)).toBe(before);
  });

  test('an inaccessible row is still empty, trimmed or not', () => {
    const out = serializeSession(row(), {
      canAccess: false,
      trimListMetadata: true,
    }) as Record<string, unknown>;

    expect(out.metadata).toEqual({});
  });

  test('a row with none of the heavy keys is passed through unchanged', () => {
    const metadata = { ...CLIENT_READ_METADATA };
    const out = serializeSession(row({ metadata }), {
      trimListMetadata: true,
    }) as Record<string, unknown>;

    // Same object, not a defensive copy: the trim only allocates when it has
    // something to remove, which is the common case for a plain user session.
    expect(out.metadata).toBe(metadata);
  });
});
