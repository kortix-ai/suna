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

const { loadEnvSyncDurableState, persistEnvSyncDurableState, recordDaemonBootForEnvSync } = await import(
  './env-sync-durable-state'
);

/** The literal SQL text of a fragment, without its bound values. */
function sqlText(fragment: unknown): string {
  if (!(fragment instanceof SQL)) throw new Error('expected a drizzle SQL fragment');
  return fragment.queryChunks
    .map((chunk) => {
      const value = (chunk as { value?: unknown }).value;
      return Array.isArray(value) ? value.join('') : '';
    })
    .join('');
}

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

  test('a row with both keys and the record version → the record', async () => {
    selectedRow = { config: { envSyncSignature: 'sig-a', envSyncAppliedAtMs: 1_700_000, envSyncRecordVersion: 2 } };
    expect(await loadEnvSyncDurableState('sess-1')).toEqual({
      signature: 'sig-a',
      appliedAtMs: 1_700_000,
    });
  });

  // Written before the boot fence existed: a daemon restart after it left no
  // boot to compare against, so it may describe a process that is gone.
  test('a record without the record version → null', async () => {
    selectedRow = { config: { envSyncSignature: 'sig-a', envSyncAppliedAtMs: 1_700_000 } };
    expect(await loadEnvSyncDurableState('sess-1')).toBeNull();
  });

  test('a malformed value (wrong type) → null, never a crash', async () => {
    selectedRow = { config: { envSyncSignature: 42, envSyncAppliedAtMs: 'not-a-number' } };
    expect(await loadEnvSyncDurableState('sess-1')).toBeNull();
  });

  test('a null config column → null', async () => {
    selectedRow = { config: null };
    expect(await loadEnvSyncDurableState('sess-1')).toBeNull();
  });

  // A daemon process that booted after the push seeded its env from the boot
  // env: the record describes a process that no longer exists.
  test('a record applied before the recorded daemon boot → null', async () => {
    selectedRow = {
      config: { envSyncSignature: 'sig-a', envSyncAppliedAtMs: 1_700_000, envSyncRecordVersion: 2, envSyncDaemonBootAtMs: 1_700_001 },
    };
    expect(await loadEnvSyncDurableState('sess-1')).toBeNull();
  });

  test('a record applied in the same millisecond as the boot → null (the push may have hit the old process)', async () => {
    selectedRow = {
      config: { envSyncSignature: 'sig-a', envSyncAppliedAtMs: 1_700_000, envSyncRecordVersion: 2, envSyncDaemonBootAtMs: 1_700_000 },
    };
    expect(await loadEnvSyncDurableState('sess-1')).toBeNull();
  });

  test('a record applied after the recorded daemon boot → the record', async () => {
    selectedRow = {
      config: { envSyncSignature: 'sig-a', envSyncAppliedAtMs: 1_700_002, envSyncRecordVersion: 2, envSyncDaemonBootAtMs: 1_700_001 },
    };
    expect(await loadEnvSyncDurableState('sess-1')).toEqual({ signature: 'sig-a', appliedAtMs: 1_700_002 });
  });

  test('a malformed boot value is ignored, never a crash', async () => {
    selectedRow = {
      config: { envSyncSignature: 'sig-a', envSyncAppliedAtMs: 1_700_000, envSyncRecordVersion: 2, envSyncDaemonBootAtMs: 'soon' },
    };
    expect(await loadEnvSyncDurableState('sess-1')).toEqual({ signature: 'sig-a', appliedAtMs: 1_700_000 });
  });
});

describe('recordDaemonBootForEnvSync', () => {
  test('merges the boot time atomically and never moves it back', async () => {
    await recordDaemonBootForEnvSync('sess-1', 1_700_900);
    expect(updateCalls).toHaveLength(1);
    expect(boundValues(updateCalls[0]!.config)).toContain(1_700_900);
    const text = sqlText(updateCalls[0]!.config);
    expect(text).toContain("jsonb_build_object('envSyncDaemonBootAtMs'");
    // A late write of an OLDER boot (a slow replica) keeps the newer one.
    expect(text).toContain('GREATEST(');
    // The env-sync record keys are untouched: the boot fences them at read time.
    expect(text).not.toContain('envSyncSignature');
  });
});

describe('persistEnvSyncDurableState', () => {
  test('merges the signature, timestamp and record version atomically into config', async () => {
    await persistEnvSyncDurableState('sess-1', 'sig-b', 1_700_500);
    expect(updateCalls).toHaveLength(1);
    const values = boundValues(updateCalls[0]!.config);
    expect(values).toContain('sig-b');
    expect(values).toContain(1_700_500);
    expect(values).toContain(2);
    expect(sqlText(updateCalls[0]!.config)).toContain("'envSyncRecordVersion'");
  });
});
