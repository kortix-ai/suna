import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { projects } from '@kortix/db';

import { SLACK_STOP_ACTION } from '../channels/slack/stop-action';
import { config } from '../config';
import { chatIdentityStub } from './helpers/chat-identity-stub';

// Slack had no Stop at all. A turn that wedges holds its OpenCode assistant
// message open, and while it does every later prompt in the thread is accepted
// and never runs — the failure Teams hit on dev 2026-09-19, where two of the
// user's messages vanished over two days. The only way out was the 30-minute
// GC. Teams got a Stop button; this is its Slack twin.

const SESSION_ID = 'sess-live';
const TEAM = 'T1';
const THREAD = '10.10';

// The project's account, which the owner and manager check needs, and the
// presser's row on the thread. An approved participant row must never read
// as a grant to stop: joining lets a person prompt, not end another's run.
let projectRow: { accountId: string } | undefined;
let participantRow: { status: string } | undefined;
let dbThrows = false;
mock.module('../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (dbThrows) throw new Error('pool exhausted');
            const row = table === projects ? projectRow : participantRow;
            return row ? [row] : [];
          },
        }),
      }),
    }),
  },
}));

// Whether the presser may still stop runs in the project (a linked account
// with project.session.stop), and what was asked.
let stopActor: { userId: string } | { reason: 'unlinked' | 'not_member' } = { userId: 'user-1' };
let actorThrows = false;
const actorChecks: Array<{ user: string; projectId: string; action: string }> = [];
mock.module('../channels/core/identity', () =>
  chatIdentityStub({
    resolveProjectChatActor: async (user: { platformUserId: string }, projectId: string, action: string) => {
      actorChecks.push({ user: user.platformUserId, projectId, action });
      if (actorThrows) throw new Error('pool exhausted');
      return stopActor;
    },
  }),
);

// The API's stop rule: owner or manager standing, and the running turn's
// prompter. Default: neither, so only the sender may stop.
let standing = false;
const standingChecks: Array<Record<string, string>> = [];
let runningTurn: { messageId: string | null } | null = { messageId: 'msg-1' };
let prompter: string | null = null;
mock.module('../projects/surface', () => ({
  sessionLifecycleStandingFor: async (input: Record<string, string>) => {
    standingChecks.push(input);
    return standing;
  },
  readRunningTurn: async () => runningTurn,
  turnPrompterOf: async (_sessionId: string, messageId: string | null) => (messageId ? prompter : null),
}));

let turn: Record<string, unknown> | null = null;
let claim = true;
const claims: string[] = [];
const finalized: Array<Record<string, unknown>> = [];
const deleted: string[] = [];
mock.module('../channels/slack/turn', () => ({
  loadTurn: async () => turn,
  claimFinalize: async (id: string) => {
    claims.push(id);
    return claim;
  },
  finalizeTurn: async (_h: unknown, opts: Record<string, unknown>) => {
    finalized.push(opts);
  },
  deleteTurn: async (id: string) => {
    deleted.push(id);
  },
}));

let abortResult: boolean | Error = true;
const aborted: string[] = [];
const abortOpts: Array<{ requestedStop?: boolean; stoppedBy?: string | null } | undefined> = [];
mock.module('../projects/session-lifecycle/abort-runtime-turn', () => ({
  abortRuntimeTurn: async (id: string, opts?: { requestedStop?: boolean; stoppedBy?: string | null }) => {
    aborted.push(id);
    abortOpts.push(opts);
    if (abortResult instanceof Error) throw abortResult;
    return abortResult;
  },
}));

const liveTurn = (user: string) => ({
  teamId: TEAM,
  channel: 'C1',
  ts: '11.11',
  triggerTs: THREAD,
  projectId: 'proj-1',
  sessionId: SESSION_ID,
  finalized: false,
  originatingEvent: { user, ts: THREAD, channel: 'C1' },
});

const load = async () => await import('../channels/slack/stop');
const requireIdentity = config.SLACK_REQUIRE_USER_IDENTITY;

beforeEach(() => {
  projectRow = { accountId: 'acct-1' };
  participantRow = undefined;
  dbThrows = false;
  stopActor = { userId: 'user-1' };
  actorThrows = false;
  actorChecks.length = 0;
  standing = false;
  standingChecks.length = 0;
  runningTurn = { messageId: 'msg-1' };
  prompter = null;
  turn = liveTurn('U_OWNER');
  claim = true;
  abortResult = true;
  claims.length = 0;
  finalized.length = 0;
  deleted.length = 0;
  aborted.length = 0;
  abortOpts.length = 0;
});

afterEach(() => {
  config.SLACK_REQUIRE_USER_IDENTITY = requireIdentity;
  mock.restore();
});

describe('stopSlackTurn', () => {
  test('the person whose message is running may stop it', async () => {
    const { stopSlackTurn } = await load();

    const outcome = await stopSlackTurn({ sessionId: SESSION_ID, slackUserId: 'U_OWNER', byName: '<@U_OWNER>' });

    expect(outcome).toEqual({ stopped: true, stoppedRuntime: true });
    expect(aborted).toEqual([SESSION_ID]);
    // A person asked for this stop: the turn must not read as a failure.
    // ...and it names the Kortix user who asked, for the turn's record.
    expect(abortOpts.at(-1)).toEqual({ requestedStop: true, stoppedBy: 'user-1' });
    expect(finalized).toEqual([{ title: 'Stopped', answer: 'Stopped by <@U_OWNER>.', unfinished: true }]);
    expect(deleted).toEqual([SESSION_ID]);
  });

  test('someone else in the thread may not stop a run they did not start', async () => {
    // Being approved on the thread lets a person prompt the session. It does
    // not let them end another person's run: that is the prompter's, the
    // session owner's or a project manager's call, as on every other surface.
    participantRow = { status: 'approved' };
    const { stopSlackTurn } = await load();

    expect(await stopSlackTurn({ sessionId: SESSION_ID, slackUserId: 'U_OTHER' })).toEqual({
      stopped: false,
      notice: 'Only the person who started this run, the session owner or a project manager can stop it.',
    });
    expect(standingChecks).toEqual([
      { userId: 'user-1', accountId: 'acct-1', projectId: 'proj-1', sessionId: SESSION_ID },
    ]);
    expect(claims).toEqual([]);
    expect(aborted).toEqual([]);
    expect(finalized).toEqual([]);
  });

  test('the session owner or a project manager may stop a run they did not start', async () => {
    standing = true;
    stopActor = { userId: 'user-manager' };
    const { stopSlackTurn } = await load();

    expect(await stopSlackTurn({ sessionId: SESSION_ID, slackUserId: 'U_MANAGER', byName: '<@U_MANAGER>' })).toEqual({
      stopped: true,
      stoppedRuntime: true,
    });
    expect(abortOpts.at(-1)).toEqual({ requestedStop: true, stoppedBy: 'user-manager' });
    expect(finalized).toEqual([{ title: 'Stopped', answer: 'Stopped by <@U_MANAGER>.', unfinished: true }]);
  });

  test('the linked user who prompted the running turn from another surface may stop it', async () => {
    // A member prompted this channel-bound session from the web: the card was
    // drawn for the thread's message, but the run is theirs.
    stopActor = { userId: 'user-web' };
    prompter = 'user-web';
    const { stopSlackTurn } = await load();

    expect((await stopSlackTurn({ sessionId: SESSION_ID, slackUserId: 'U_WEB' })).stopped).toBe(true);
    expect(abortOpts.at(-1)).toEqual({ requestedStop: true, stoppedBy: 'user-web' });
  });

  test('another linked member is not the prompter', async () => {
    participantRow = { status: 'approved' };
    stopActor = { userId: 'user-other' };
    prompter = 'user-web';
    const { stopSlackTurn } = await load();

    expect((await stopSlackTurn({ sessionId: SESSION_ID, slackUserId: 'U_OTHER' })).stopped).toBe(false);
    expect(aborted).toEqual([]);
  });

  test('an owner or manager without a live link, or without project.session.stop, is refused', async () => {
    standing = true;
    for (const reason of ['not_member', 'unlinked'] as const) {
      stopActor = { reason };
      const { stopSlackTurn } = await load();
      expect((await stopSlackTurn({ sessionId: SESSION_ID, slackUserId: 'U_MANAGER' })).stopped).toBe(false);
    }
    // A project that no longer exists has no owner or manager to ask about.
    stopActor = { userId: 'user-manager' };
    projectRow = undefined;
    const { stopSlackTurn } = await load();
    expect((await stopSlackTurn({ sessionId: SESSION_ID, slackUserId: 'U_MANAGER' })).stopped).toBe(false);
    // Standing is never asked for a person the link does not name.
    expect(standingChecks).toEqual([]);
    expect(aborted).toEqual([]);
  });

  test('the sender must still be allowed to stop runs in the project', async () => {
    for (const reason of ['not_member', 'unlinked'] as const) {
      stopActor = { reason };
      const { stopSlackTurn } = await load();
      expect((await stopSlackTurn({ sessionId: SESSION_ID, slackUserId: 'U_OWNER' })).stopped).toBe(false);
    }
    expect(actorChecks).toEqual([
      { user: 'U_OWNER', projectId: 'proj-1', action: 'project.session.stop' },
      { user: 'U_OWNER', projectId: 'proj-1', action: 'project.session.stop' },
    ]);
    expect(aborted).toEqual([]);
    expect(finalized).toEqual([]);
  });

  test('without required identities the sender stops unlinked, and nobody else does', async () => {
    // The thread runs as the installer then, so the sender needs no link and
    // the stop names no Kortix user.
    config.SLACK_REQUIRE_USER_IDENTITY = false;
    stopActor = { reason: 'unlinked' };
    const { stopSlackTurn } = await load();

    expect((await stopSlackTurn({ sessionId: SESSION_ID, slackUserId: 'U_OTHER' })).stopped).toBe(false);
    expect(aborted).toEqual([]);
    expect((await stopSlackTurn({ sessionId: SESSION_ID, slackUserId: 'U_OWNER' })).stopped).toBe(true);
    expect(abortOpts.at(-1)).toEqual({ requestedStop: true, stoppedBy: null });
  });

  test('an unlinked bystander is refused, and nothing is claimed, aborted or closed', async () => {
    stopActor = { reason: 'unlinked' };
    const { stopSlackTurn } = await load();

    expect((await stopSlackTurn({ sessionId: SESSION_ID, slackUserId: 'U_BYSTANDER' })).stopped).toBe(false);
    expect(claims).toEqual([]);
    expect(aborted).toEqual([]);
    expect(finalized).toEqual([]);
  });

  test('an unresolvable lookup refuses rather than assumes', async () => {
    actorThrows = true;
    const { stopSlackTurn } = await load();
    expect((await stopSlackTurn({ sessionId: SESSION_ID, slackUserId: 'U_OWNER' })).stopped).toBe(false);

    // A manager's standing needs the project's account: that lookup fails too.
    actorThrows = false;
    dbThrows = true;
    standing = true;
    expect((await stopSlackTurn({ sessionId: SESSION_ID, slackUserId: 'U_MANAGER' })).stopped).toBe(false);
    expect(aborted).toEqual([]);
  });

  test('an anonymous presser is refused before any lookup', async () => {
    const { stopSlackTurn } = await load();

    expect((await stopSlackTurn({ sessionId: SESSION_ID, slackUserId: '' })).stopped).toBe(false);
    expect(actorChecks).toEqual([]);
  });

  test('the finalize is claimed BEFORE the runtime is touched', async () => {
    // The abort makes OpenCode end the turn, which relays back as
    // `relayTurnEnd(status: 'error')` and claims the same row. Claiming first
    // is what stops a deliberate Stop being repainted "Run failed".
    const order: string[] = [];
    claims.push = ((id: string) => {
      order.push('claim');
      return Array.prototype.push.call(claims, id);
    }) as never;
    aborted.push = ((id: string) => {
      order.push('abort');
      return Array.prototype.push.call(aborted, id);
    }) as never;
    finalized.push = ((o: Record<string, unknown>) => {
      order.push('finalize');
      return Array.prototype.push.call(finalized, o);
    }) as never;
    const { stopSlackTurn } = await load();

    await stopSlackTurn({ sessionId: SESSION_ID, slackUserId: 'U_OWNER' });

    expect(order).toEqual(['claim', 'abort', 'finalize']);
  });

  test('a turn that settled between the load and the claim is not painted over', async () => {
    claim = false;
    const { stopSlackTurn } = await load();

    const outcome = await stopSlackTurn({ sessionId: SESSION_ID, slackUserId: 'U_OWNER' });

    expect(outcome).toEqual({ stopped: false, notice: 'That run has already finished.' });
    expect(aborted).toEqual([]);
    expect(finalized).toEqual([]);
  });

  test('a finished or missing turn says so instead of aborting again', async () => {
    turn = { ...liveTurn('U_OWNER'), finalized: true };
    const { stopSlackTurn } = await load();
    expect((await stopSlackTurn({ sessionId: SESSION_ID, slackUserId: 'U_OWNER' })).stopped).toBe(false);

    turn = null;
    expect((await stopSlackTurn({ sessionId: SESSION_ID, slackUserId: 'U_OWNER' })).stopped).toBe(false);
    expect(aborted).toEqual([]);
  });

  test('an unreachable runtime still closes the message, and says which happened', async () => {
    abortResult = false;
    const { stopSlackTurn } = await load();

    expect(await stopSlackTurn({ sessionId: SESSION_ID, slackUserId: 'U_OWNER' })).toEqual({
      stopped: true,
      stoppedRuntime: false,
    });
    expect(deleted).toEqual([SESSION_ID]);
  });

  test('an abort that throws never escapes the stop', async () => {
    abortResult = new Error('sandbox gone');
    const { stopSlackTurn } = await load();

    expect((await stopSlackTurn({ sessionId: SESSION_ID, slackUserId: 'U_OWNER' })).stopped).toBe(true);
    expect(finalized).toHaveLength(1);
  });

  test('the action id is the one the live plan draws and interactivity routes', () => {
    expect(SLACK_STOP_ACTION).toBe('stop_run');
  });
});
