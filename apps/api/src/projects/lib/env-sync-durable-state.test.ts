// `env-sync-durable-state.ts` persists the "last applied env-sync signature"
// on `session_sandboxes.config`, the same jsonb bag `markSandboxLlmGatewayMode`
// already writes atomically (sandbox-env-sync.ts) — so a DIFFERENT API replica
// can read what THIS replica last applied. See `env-sync-skip-decision.ts` for
// why that durability is load-bearing.
//
// The write uses an atomic SQL jsonb merge (COALESCE(...) || jsonb_build_object(...)),
// same pattern as `markSandboxLlmGatewayMode`, so a concurrent writer of a
// DIFFERENT `config` key (llmGatewayEnabled, serviceKey) can never be
// clobbered by a read-modify-write race. This suite asserts on the actual
// bound values inside the built `SQL` fragment (drizzle's `queryChunks`)
// rather than re-implementing a fake SQL engine.
import { SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let selectedRow: { config: Record<string, unknown> | null } | null = null;
let updateCalls: Array<{ config: unknown; sessionId: string | null }> = [];
let capturedWhereSessionId: string | null = null;

mock.module('../../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (selectedRow ? [selectedRow] : []),
        }),
      }),
    }),
    update: () => ({
      set: (patch: { config: unknown; updatedAt: unknown }) => ({
        where: async () => {
          updateCalls.push({ config: patch.config, sessionId: capturedWhereSessionId });
        },
      }),
    }),
  },
}));

const { loadEnvSyncDurableState, persistEnvSyncDurableState } = await import(
  './env-sync-durable-state'
);

/** Pull the raw JS values bound into an `env-sync-durable-state.ts` SQL merge
 *  fragment, in the order they were interpolated (skips the literal string
 *  chunks). Mirrors how a real Postgres driver would bind them. */
function boundValues(fragment: unknown): unknown[] {
  if (!(fragment instanceof SQL)) throw new Error('expected a drizzle SQL fragment');
  return fragment.queryChunks.filter((chunk) => !(chunk && typeof chunk === 'object' && 'value' in (chunk as object) && Array.isArray((chunk as { value: unknown }).value)));
}

beforeEach(() => {
  selectedRow = null;
  updateCalls = [];
  capturedWhereSessionId = null;
});

describe('loadEnvSyncDurableState', () => {
  test('no row → null', async () => {
    selectedRow = null;
    expect(await loadEnvSyncDurableState('sess-1')).toBeNull();
  });

  test('a row with no env-sync keys yet → null', async () => {
    selectedRow = { config: { serviceKey: 'svc' } };
    expect(await loadEnvSyncDurableState('sess-1')).toBeNull();
  });

  test('a row with both keys → the record', async () => {
    selectedRow = { config: { envSyncSignature: 'sig-a', envSyncAppliedAtMs: 1_700_000 } };
    expect(await loadEnvSyncDurableState('sess-1')).toEqual({
      signature: 'sig-a',
      appliedAtMs: 1_700_000,
    });
  });

  test('a malformed value (wrong type) → null, never a crash', async () => {
    selectedRow = { config: { envSyncSignature: 42, envSyncAppliedAtMs: 'not-a-number' } };
    expect(await loadEnvSyncDurableState('sess-1')).toBeNull();
  });

  test('a null config column → null', async () => {
    selectedRow = { config: null };
    expect(await loadEnvSyncDurableState('sess-1')).toBeNull();
  });
});

describe('persistEnvSyncDurableState', () => {
  test('merges the signature and timestamp atomically into config', async () => {
    await persistEnvSyncDurableState('sess-1', 'sig-b', 1_700_500);
    expect(updateCalls).toHaveLength(1);
    const values = boundValues(updateCalls[0]!.config);
    expect(values).toContain('sig-b');
    expect(values).toContain(1_700_500);
  });
});
