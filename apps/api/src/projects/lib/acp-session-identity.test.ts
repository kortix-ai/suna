/**
 * `persistAcpSessionIdentity()` — the ONE write path for the ACP
 * `RuntimeSessionIdentity` triple (WS3-P1-a). Before this module existed,
 * `routes/acp.ts` (interactive) and `session-lifecycle/engine.ts` (headless)
 * each hand-rolled an identical read-current-metadata -> spread -> overwrite
 * `{ runtime_protocol, runtime_id, acp_session_id }` -> bump `updatedAt`
 * sequence. These tests pin that behavior byte-identically at the function
 * level, plus the grounding invariant's overload guard.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import {
  AcpSessionIdentityOverloadError,
  persistAcpSessionIdentity,
} from './acp-session-identity';

type UpdateCall = { updates: Record<string, unknown> };
type WhereCond = { queryChunks?: unknown[] } | undefined;

let selectMetadataResult: Record<string, unknown> | null;
let updateCalls: UpdateCall[];
let selectCalls: number;
let selectWhereConds: WhereCond[];
let updateWhereConds: WhereCond[];

function fakeDb() {
  return {
    select: (_proj?: unknown) => ({
      from: (_table: unknown) => ({
        where: (cond: WhereCond) => ({
          limit: async () => {
            selectCalls += 1;
            selectWhereConds.push(cond);
            return selectMetadataResult ? [{ metadata: selectMetadataResult }] : [];
          },
        }),
      }),
    }),
    update: (_table: unknown) => ({
      set: (updates: Record<string, unknown>) => ({
        where: async (cond: WhereCond) => {
          updateWhereConds.push(cond);
          updateCalls.push({ updates });
        },
      }),
    }),
  } as never;
}

beforeEach(() => {
  selectMetadataResult = {};
  updateCalls = [];
  selectCalls = 0;
  selectWhereConds = [];
  updateWhereConds = [];
});

describe('persistAcpSessionIdentity — the one write path', () => {
  test('writes exactly runtime_protocol/runtime_id/acp_session_id, merged onto existing metadata, with updatedAt bumped', async () => {
    selectMetadataResult = { some_other_key: 'preserved', runtime_protocol: 'stale' };
    const before = Date.now();

    await persistAcpSessionIdentity({ db: fakeDb() }, {
      projectSessionId: 'sess-1',
      runtimeId: 'rt-1',
      acpSessionId: 'acp-abc',
    });

    expect(updateCalls).toHaveLength(1);
    const { metadata, updatedAt } = updateCalls[0]!.updates as {
      metadata: Record<string, unknown>;
      updatedAt: Date;
    };
    expect(metadata).toEqual({
      some_other_key: 'preserved',
      runtime_protocol: 'acp',
      runtime_id: 'rt-1',
      acp_session_id: 'acp-abc',
    });
    expect(updatedAt).toBeInstanceOf(Date);
    expect(updatedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  test('projectSessionId (the row PK) never appears in the SET payload — the row identity is never overwritten', async () => {
    await persistAcpSessionIdentity({ db: fakeDb() }, {
      projectSessionId: 'sess-1',
      runtimeId: 'rt-1',
      acpSessionId: 'acp-abc',
    });
    const { metadata } = updateCalls[0]!.updates as { metadata: Record<string, unknown> };
    expect(Object.keys(updateCalls[0]!.updates).sort()).toEqual(['metadata', 'updatedAt']);
    expect(metadata.projectSessionId).toBeUndefined();
    expect(metadata.session_id).toBeUndefined();
  });

  test('a null current-row select still produces a write with just the three keys (no crash on missing row)', async () => {
    selectMetadataResult = null;
    await persistAcpSessionIdentity({ db: fakeDb() }, {
      projectSessionId: 'sess-1',
      runtimeId: 'rt-1',
      acpSessionId: 'acp-abc',
    });
    const { metadata } = updateCalls[0]!.updates as { metadata: Record<string, unknown> };
    expect(metadata).toEqual({
      runtime_protocol: 'acp',
      runtime_id: 'rt-1',
      acp_session_id: 'acp-abc',
    });
  });

  test('opts.projectId (interactive shape) builds a structurally different WHERE than the no-opts (headless) shape', async () => {
    await persistAcpSessionIdentity({ db: fakeDb() }, {
      projectSessionId: 'sess-1',
      runtimeId: 'rt-1',
      acpSessionId: 'acp-abc',
    }, { projectId: 'proj-1' });
    const withProjectId = selectWhereConds[0];
    const withProjectIdUpdate = updateWhereConds[0];

    selectWhereConds = [];
    updateWhereConds = [];
    updateCalls = [];
    await persistAcpSessionIdentity({ db: fakeDb() }, {
      projectSessionId: 'sess-1',
      runtimeId: 'rt-1',
      acpSessionId: 'acp-abc',
    });
    const withoutProjectId = selectWhereConds[0];
    const withoutProjectIdUpdate = updateWhereConds[0];

    // Both WHERE clauses are real drizzle SQL fragments (`and(eq(...), eq(...))`
    // vs a bare `eq(...)`) — their internal chunk counts differ, which is
    // enough to pin "the query shape changed" without depending on drizzle's
    // internal representation staying byte-identical across versions.
    expect(withProjectId?.queryChunks?.length).not.toBe(withoutProjectId?.queryChunks?.length);
    expect(withProjectIdUpdate?.queryChunks?.length).not.toBe(withoutProjectIdUpdate?.queryChunks?.length);
    // select and update build the WHERE the same way within a single call.
    expect(withProjectId?.queryChunks?.length).toBe(withProjectIdUpdate?.queryChunks?.length);
    expect(withoutProjectId?.queryChunks?.length).toBe(withoutProjectIdUpdate?.queryChunks?.length);
  });

  test('re-persisting the same acpSessionId (session/load idempotency) produces the same metadata both times — a no-op in effect', async () => {
    selectMetadataResult = { runtime_protocol: 'acp', runtime_id: 'rt-1', acp_session_id: 'acp-abc' };
    await persistAcpSessionIdentity({ db: fakeDb() }, {
      projectSessionId: 'sess-1',
      runtimeId: 'rt-1',
      acpSessionId: 'acp-abc',
    });
    const first = updateCalls[0]!.updates.metadata;

    updateCalls = [];
    // A second call with an identical identity — as session/load re-confirming
    // the same acpSessionId would produce, if a call site ever invoked this on
    // load (today neither does; see engine.ts's `if (acpSessionId) { call('session/load', ...) }`
    // branch, which never calls this function at all).
    await persistAcpSessionIdentity({ db: fakeDb() }, {
      projectSessionId: 'sess-1',
      runtimeId: 'rt-1',
      acpSessionId: 'acp-abc',
    });
    const second = updateCalls[0]!.updates.metadata;
    expect(second).toEqual(first as Record<string, unknown>);
  });

  test('overload guard: acpSessionId === runtimeId throws AcpSessionIdentityOverloadError and performs ZERO db operations', async () => {
    await expect(
      persistAcpSessionIdentity({ db: fakeDb() }, {
        projectSessionId: 'sess-1',
        runtimeId: 'same-value',
        acpSessionId: 'same-value',
      }),
    ).rejects.toBeInstanceOf(AcpSessionIdentityOverloadError);
    expect(selectCalls).toBe(0);
    expect(updateCalls).toHaveLength(0);
  });

  test('overload guard does not trip on legitimate today-shaped values (distinct random-ID namespaces)', async () => {
    // Interactive shape: runtimeId === the Kortix sessionId (a randomUUID()),
    // acpSessionId === a harness-minted session/new id. Never equal in
    // practice — pinned here as a concrete non-colliding example.
    await expect(
      persistAcpSessionIdentity({ db: fakeDb() }, {
        projectSessionId: 'sess-1',
        runtimeId: '11111111-2222-4333-8444-555555555555',
        acpSessionId: 'claude-code-session-9f2a',
      }),
    ).resolves.toBeUndefined();

    // Headless shape: runtimeId === the daemon-reported ACP server id.
    await expect(
      persistAcpSessionIdentity({ db: fakeDb() }, {
        projectSessionId: 'sess-2',
        runtimeId: 'acp-server-77',
        acpSessionId: 'harness-session-abc123',
      }),
    ).resolves.toBeUndefined();
  });
});
