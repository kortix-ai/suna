import { beforeEach, describe, expect, test } from 'bun:test';

import { AcpSessionIdentityConflictError, persistAcpSessionIdentity } from './acp-session-identity';

type Metadata = Record<string, unknown>;

let storedMetadata: Metadata | null;
let updateCalls: Metadata[];

function fakeDb() {
  return {
    transaction: async (run: (tx: unknown) => Promise<unknown>) =>
      run({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => ({
                for: async () => (storedMetadata ? [{ metadata: storedMetadata }] : []),
              }),
            }),
          }),
        }),
        update: () => ({
          set: (updates: Metadata) => ({
            where: async () => {
              updateCalls.push(updates);
              storedMetadata = updates.metadata as Metadata;
            },
          }),
        }),
      }),
  } as never;
}

beforeEach(() => {
  storedMetadata = {
    runtime_transport: 'acp',
    runtime_harness: 'codex',
    acp_server_id: 'server-1',
    unrelated: 'preserved',
  };
  updateCalls = [];
});

describe('persistAcpSessionIdentity', () => {
  test('persists one distinct harness-native session id and preserves metadata', async () => {
    const identity = await persistAcpSessionIdentity(
      { db: fakeDb() },
      {
        projectId: 'project-1',
        projectSessionId: 'project-session-1',
        acpServerId: 'server-1',
        runtimeHarness: 'codex',
        acpSessionId: 'codex-session-1',
      },
    );

    expect(identity).toEqual({
      acp_server_id: 'server-1',
      runtime_harness: 'codex',
      acp_session_id: 'codex-session-1',
    });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.metadata).toEqual({
      runtime_transport: 'acp',
      runtime_harness: 'codex',
      acp_server_id: 'server-1',
      acp_session_id: 'codex-session-1',
      unrelated: 'preserved',
    });
  });

  test('accepts the same harness-native session id without another write', async () => {
    storedMetadata = {
      ...storedMetadata,
      acp_session_id: 'codex-session-1',
    };

    const identity = await persistAcpSessionIdentity(
      { db: fakeDb() },
      {
        projectId: 'project-1',
        projectSessionId: 'project-session-1',
        acpServerId: 'server-1',
        runtimeHarness: 'codex',
        acpSessionId: 'codex-session-1',
      },
    );

    expect(identity.acp_session_id).toBe('codex-session-1');
    expect(updateCalls).toHaveLength(0);
  });

  test('exposes the already-stored session id on the immutability conflict', async () => {
    storedMetadata = {
      ...storedMetadata,
      acp_session_id: 'codex-native-winner',
    };

    await expect(
      persistAcpSessionIdentity(
        { db: fakeDb() },
        {
          projectId: 'project-1',
          projectSessionId: 'project-session-1',
          acpServerId: 'server-1',
          runtimeHarness: 'codex',
          acpSessionId: 'codex-native-loser',
        },
      ),
    ).rejects.toMatchObject({
      code: 'ACP_SESSION_ID_CONFLICT',
      storedAcpSessionId: 'codex-native-winner',
    });
    expect(updateCalls).toHaveLength(0);
  });

  for (const [name, metadata, input, code] of [
    [
      'rejects REST sessions',
      { runtime_transport: 'rest', runtime_harness: 'opencode', acp_server_id: 'server-1' },
      { acpServerId: 'server-1', runtimeHarness: 'opencode', acpSessionId: 'native-1' },
      'ACP_TRANSPORT_REQUIRED',
    ],
    [
      'rejects a changed ACP server id',
      { runtime_transport: 'acp', runtime_harness: 'codex', acp_server_id: 'server-1' },
      { acpServerId: 'server-2', runtimeHarness: 'codex', acpSessionId: 'native-1' },
      'ACP_SERVER_ID_MISMATCH',
    ],
    [
      'rejects a changed harness',
      { runtime_transport: 'acp', runtime_harness: 'codex', acp_server_id: 'server-1' },
      { acpServerId: 'server-1', runtimeHarness: 'claude', acpSessionId: 'native-1' },
      'ACP_HARNESS_MISMATCH',
    ],
    [
      'rejects replacement of the harness-native session id',
      {
        runtime_transport: 'acp',
        runtime_harness: 'codex',
        acp_server_id: 'server-1',
        acp_session_id: 'native-original',
      },
      { acpServerId: 'server-1', runtimeHarness: 'codex', acpSessionId: 'native-replacement' },
      'ACP_SESSION_ID_CONFLICT',
    ],
    [
      'rejects an overloaded server and harness-native session id',
      { runtime_transport: 'acp', runtime_harness: 'codex', acp_server_id: 'server-1' },
      { acpServerId: 'server-1', runtimeHarness: 'codex', acpSessionId: 'server-1' },
      'ACP_IDENTITY_OVERLOAD',
    ],
  ] as const) {
    test(name, async () => {
      storedMetadata = metadata;

      try {
        await persistAcpSessionIdentity(
          { db: fakeDb() },
          {
            projectId: 'project-1',
            projectSessionId: 'project-session-1',
            ...input,
          },
        );
        throw new Error('expected persistence to reject');
      } catch (error) {
        expect(error).toBeInstanceOf(AcpSessionIdentityConflictError);
        expect((error as AcpSessionIdentityConflictError).code).toBe(code);
      }
      expect(updateCalls).toHaveLength(0);
    });
  }

  test('rejects a blank harness-native session id before a database call', async () => {
    await expect(
      persistAcpSessionIdentity(
        { db: fakeDb() },
        {
          projectId: 'project-1',
          projectSessionId: 'project-session-1',
          acpServerId: 'server-1',
          runtimeHarness: 'codex',
          acpSessionId: '   ',
        },
      ),
    ).rejects.toMatchObject({ code: 'ACP_SESSION_ID_REQUIRED' });
    expect(updateCalls).toHaveLength(0);
  });
});
