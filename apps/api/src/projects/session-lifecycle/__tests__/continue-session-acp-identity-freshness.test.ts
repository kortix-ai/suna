// continueSession() snapshots the session row BEFORE the readiness wait, which
// can run for minutes and is re-entered by every requeued delivery. In that
// window the browser-side SDK controller can win the `session/new` race and
// write `metadata.acp_session_id`. Reusing the stale snapshot makes this
// delivery mint a SECOND harness-native session, and the CAS guard in
// ../../lib/acp-session-identity.ts then 409s it with ACP_SESSION_ID_CONFLICT.
// The send closure therefore re-reads the id from the row at attempt time.
//
// Same mocking caveat as ./continue-session-title.test.ts: engine.ts's heavier
// dependencies are stubbed so its top-level imports resolve, and `mock.module`
// is process-global, so this file must be run on its own.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions, projects } from '@kortix/db';

const SESSION_ID = 'sess-acp-freshness-1';
const ACCOUNT_ID = 'acct-1';
const PROJECT_ID = 'proj-1';

let storedMetadata: Record<string, unknown> = {};
let mintDuringReadinessWait: string | null = null;
let deliveredWith: Array<Record<string, unknown>> = [];

mock.module('../../../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === projectSessions) {
              return [
                {
                  accountId: ACCOUNT_ID,
                  projectId: PROJECT_ID,
                  status: 'running',
                  sandboxProvider: 'daytona',
                  baseRef: 'main',
                  agentName: null,
                  opencodeSessionId: null,
                  metadata: { ...storedMetadata },
                },
              ];
            }
            if (table === projects) return [{ projectId: PROJECT_ID, accountId: ACCOUNT_ID }];
            return [];
          },
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  },
}));

const realTitleGenerate = await import('../../session-title-generate');
mock.module('../../session-title-generate', () => ({
  ...realTitleGenerate,
  generateSessionTitleFromFirstPrompt: async () => {},
}));

const realShared = await import('../../routes/shared');
mock.module('../../routes/shared', () => ({
  ...realShared,
  openSession: async () => {
    if (mintDuringReadinessWait) {
      storedMetadata = { ...storedMetadata, acp_session_id: mintDuringReadinessWait };
      mintDuringReadinessWait = null;
    }
    return {
      stage: 'ready',
      sandbox: { external_id: 'sandbox-external-1' },
      opencode_session_id: 'opencode-session-1',
      retriable: false,
    };
  },
}));

mock.module('../headless-acp', () => ({
  deliverHeadlessAcpPrompt: async (input: Record<string, unknown>) => {
    deliveredWith.push(input);
    return { ok: true, acpSessionId: input.acpSessionId };
  },
  queueInitialAcpPrompt: async () => {},
  shouldScheduleInitialAcpPrompt: () => false,
}));

const { continueSession } = await import('../engine');

beforeEach(() => {
  storedMetadata = {
    runtime_transport: 'acp',
    runtime_harness: 'codex',
    acp_server_id: SESSION_ID,
  };
  mintDuringReadinessWait = null;
  deliveredWith = [];
});

describe('continueSession — ACP delivery reads the session id at send time', () => {
  test('a session id minted during the readiness wait is loaded, not re-minted', async () => {
    mintDuringReadinessWait = 'codex-native-winner';

    const outcome = await continueSession({
      source: 'ui',
      sessionId: SESSION_ID,
      text: 'inspect this repo',
      userId: 'user-1',
    });

    expect(outcome).toBe('delivered');
    expect(deliveredWith).toHaveLength(1);
    expect(deliveredWith[0]).toMatchObject({
      acpServerId: SESSION_ID,
      acpSessionId: 'codex-native-winner',
      runtimeHarness: 'codex',
    });
  });

  test('a session id already stored at snapshot time is still used', async () => {
    storedMetadata = { ...storedMetadata, acp_session_id: 'codex-native-existing' };

    const outcome = await continueSession({
      source: 'ui',
      sessionId: SESSION_ID,
      text: 'inspect this repo',
      userId: 'user-1',
    });

    expect(outcome).toBe('delivered');
    expect(deliveredWith[0]).toMatchObject({ acpSessionId: 'codex-native-existing' });
  });

  test('an unminted ACP session still passes null so the first delivery mints one', async () => {
    const outcome = await continueSession({
      source: 'ui',
      sessionId: SESSION_ID,
      text: 'inspect this repo',
      userId: 'user-1',
    });

    expect(outcome).toBe('delivered');
    expect(deliveredWith[0]).toMatchObject({ acpSessionId: null });
  });
});
