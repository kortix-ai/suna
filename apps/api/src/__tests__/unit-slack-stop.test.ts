import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { SLACK_STOP_ACTION } from '../channels/slack/stop-action';

// Slack had no Stop at all. A turn that wedges holds its OpenCode assistant
// message open, and while it does every later prompt in the thread is accepted
// and never runs — the failure Teams hit on dev 2026-09-19, where two of the
// user's messages vanished over two days. The only way out was the 30-minute
// GC. Teams got a Stop button; this is its Slack twin.

const SESSION_ID = 'sess-live';
const TEAM = 'T1';
const THREAD = '10.10';

let participantRow: { status: string } | undefined;
let participantThrows = false;
mock.module('../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if (participantThrows) throw new Error('pool exhausted');
            return participantRow ? [participantRow] : [];
          },
        }),
      }),
    }),
  },
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
mock.module('../projects/session-lifecycle/abort-runtime-turn', () => ({
  abortRuntimeTurn: async (id: string) => {
    aborted.push(id);
    if (abortResult instanceof Error) throw abortResult;
    return abortResult;
  },
}));

const liveTurn = (user: string) => ({
  teamId: TEAM,
  channel: 'C1',
  ts: '11.11',
  triggerTs: THREAD,
  sessionId: SESSION_ID,
  finalized: false,
  originatingEvent: { user, ts: THREAD, channel: 'C1' },
});

const load = async () => await import('../channels/slack/stop');

beforeEach(() => {
  participantRow = undefined;
  participantThrows = false;
  turn = liveTurn('U_OWNER');
  claim = true;
  abortResult = true;
  claims.length = 0;
  finalized.length = 0;
  deleted.length = 0;
  aborted.length = 0;
});

afterEach(() => {
  mock.restore();
});

describe('stopSlackTurn', () => {
  test('the person whose message is running may stop it', async () => {
    const { stopSlackTurn } = await load();

    const outcome = await stopSlackTurn({ sessionId: SESSION_ID, slackUserId: 'U_OWNER', byName: '<@U_OWNER>' });

    expect(outcome).toEqual({ stopped: true, stoppedRuntime: true });
    expect(aborted).toEqual([SESSION_ID]);
    expect(finalized).toEqual([{ title: 'Stopped', answer: 'Stopped by <@U_OWNER>.', unfinished: true }]);
    expect(deleted).toEqual([SESSION_ID]);
  });

  test('an approved participant may stop a turn they did not start', async () => {
    participantRow = { status: 'approved' };
    const { stopSlackTurn } = await load();

    expect((await stopSlackTurn({ sessionId: SESSION_ID, slackUserId: 'U_OTHER' })).stopped).toBe(true);
  });

  test('a bystander is refused, and nothing is claimed, aborted or closed', async () => {
    participantRow = { status: 'pending' };
    const { stopSlackTurn } = await load();

    expect((await stopSlackTurn({ sessionId: SESSION_ID, slackUserId: 'U_BYSTANDER' })).stopped).toBe(false);
    expect(claims).toEqual([]);
    expect(aborted).toEqual([]);
    expect(finalized).toEqual([]);
  });

  test('an unresolvable lookup refuses rather than assumes', async () => {
    participantThrows = true;
    const { stopSlackTurn } = await load();

    expect((await stopSlackTurn({ sessionId: SESSION_ID, slackUserId: 'U_UNKNOWN' })).stopped).toBe(false);
  });

  test('an anonymous presser is refused before any lookup', async () => {
    const { stopSlackTurn } = await load();

    expect((await stopSlackTurn({ sessionId: SESSION_ID, slackUserId: '' })).stopped).toBe(false);
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

  test('a thread whose turn has no thread id refuses a non-sender', async () => {
    turn = { ...liveTurn('U_OWNER'), triggerTs: '', originatingEvent: { user: 'U_OWNER' } };
    const { stopSlackTurn } = await load();

    expect((await stopSlackTurn({ sessionId: SESSION_ID, slackUserId: 'U_OTHER' })).stopped).toBe(false);
    // The sender themselves is still allowed — that check never needs a thread.
    expect((await stopSlackTurn({ sessionId: SESSION_ID, slackUserId: 'U_OWNER' })).stopped).toBe(true);
  });

  test('the action id is the one the live plan draws and interactivity routes', () => {
    expect(SLACK_STOP_ACTION).toBe('stop_run');
  });
});
