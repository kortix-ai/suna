// continueSession() titles the OpenCode REST session it is delivering into.
//
// Same mocking caveat as ./continue-session-deleted-guard.test.ts: engine.ts's
// heavier dependencies are stubbed so its top-level imports resolve, and
// `mock.module` is process-global, so this file must be run on its own.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions, projects } from '@kortix/db';

const SESSION_ID = 'sess-title-hook-1';
const ACCOUNT_ID = 'acct-1';
const PROJECT_ID = 'proj-1';

let sessionRow: Record<string, unknown> | null = null;
let titleCalls: Array<Record<string, unknown>> = [];
let actor: string | null = 'automation-user-1';

mock.module('../../../config', () => ({ config: {}, SANDBOX_VERSION: 'test' }));

mock.module('../../../shared/db', () => ({
  hasDatabase: () => true,
  db: {
    select: (_proj: unknown) => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === projectSessions) return sessionRow ? [sessionRow] : [];
            if (table === projects) return [{ projectId: PROJECT_ID, accountId: ACCOUNT_ID }];
            return [];
          },
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  },
}));

mock.module('../../session-title-generate', () => ({
  generateSessionTitleFromFirstPrompt: async (input: Record<string, unknown>) => {
    titleCalls.push(input);
  },
}));

mock.module('../../../sandbox-proxy/routes/preview', () => ({
  forwardToSandbox: async () => {
    throw new Error('forwardToSandbox: not expected in this test');
  },
}));
mock.module('../../lib/sessions', () => ({
  createProjectSession: async () => {
    throw new Error('createProjectSession: not expected in this test');
  },
}));
mock.module('../../routes/shared', () => ({
  openSession: async () => {
    throw new Error('openSession: reached — the title hook already fired');
  },
}));
mock.module('../actor', () => ({
  resolveProjectAutomationActor: async () => actor,
}));
mock.module('../backpressure', () => ({
  sessionBackpressureState: async () => ({ shouldQueue: false, reason: null }),
}));
mock.module('../store', () => ({
  claimCreateSessionCommand: async () => {
    throw new Error('not expected in this test');
  },
  claimDueLifecycleCommands: async () => {
    throw new Error('not expected in this test');
  },
  enqueueContinueSessionCommand: async () => {
    throw new Error('not expected in this test');
  },
  markCommandFailed: async () => {
    throw new Error('not expected in this test');
  },
  markCommandQueued: async () => {
    throw new Error('not expected in this test');
  },
  markCommandSucceeded: async () => {
    throw new Error('not expected in this test');
  },
  resultFromExistingCommand: () => {
    throw new Error('not expected in this test');
  },
}));

const { continueSession } = await import('../engine');

beforeEach(() => {
  sessionRow = null;
  titleCalls = [];
  actor = 'automation-user-1';
});

async function deliver(metadata: Record<string, unknown>, text: string) {
  sessionRow = { accountId: ACCOUNT_ID, projectId: PROJECT_ID, status: 'running', metadata };
  await expect(continueSession({ sessionId: SESSION_ID, text } as never)).rejects.toThrow(
    /openSession/,
  );
}

describe('continueSession — server-side delivery titles the session', () => {
  test('a REST session is titled', async () => {
    await deliver({ runtime_transport: 'rest' }, 'bump the node version in CI');

    expect(titleCalls).toHaveLength(1);
    expect(titleCalls[0]?.firstPromptText).toBe('bump the node version in CI');
    expect(titleCalls[0]?.userId).toBe('automation-user-1');
  });

  test('an explicit command.userId is preferred over the resolved automation actor', async () => {
    sessionRow = {
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      status: 'running',
      metadata: {},
    };
    await expect(
      continueSession({ sessionId: SESSION_ID, text: 'hello', userId: 'user-42' } as never),
    ).rejects.toThrow(/openSession/);
    expect(titleCalls[0]?.userId).toBe('user-42');
  });

  test('no actor → returns pending and never titles', async () => {
    actor = null;
    sessionRow = {
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      status: 'running',
      metadata: {},
    };

    expect(await continueSession({ sessionId: SESSION_ID, text: 'hello' } as never)).toBe(
      'pending',
    );
    expect(titleCalls).toEqual([]);
  });
});
