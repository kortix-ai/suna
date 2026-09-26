import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { TEAMS_STOP_VERB, buildPlanCard } from '../channels/teams/cards';

// Every other Kortix surface can end a run the moment it goes wrong. In Teams
// the only lever was to wait out the 30-minute GC — and a wedged turn swallows
// every later message in the conversation until it fires (dev 2026-09-19: two
// messages lost over two days). These pin the button and who may press it.

const SESSION_ID = 'sess-live';
const TENANT_ID = 'tenant-1';
const CONVERSATION_ID = '19:abc@thread.tacv2';

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
const finalized: Array<Record<string, unknown>> = [];
const deleted: string[] = [];
let finalizeClaim = true;
const claims: string[] = [];
mock.module('../channels/teams/turn', () => ({
  loadTurn: async () => turn,
  claimFinalize: async (id: string) => {
    claims.push(id);
    return finalizeClaim;
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
const abortOpts: Array<{ requestedStop?: boolean } | undefined> = [];
mock.module('../projects/session-lifecycle/abort-runtime-turn', () => ({
  abortRuntimeTurn: async (id: string, opts?: { requestedStop?: boolean }) => {
    aborted.push(id);
    abortOpts.push(opts);
    if (abortResult instanceof Error) throw abortResult;
    return abortResult;
  },
}));

const liveTurn = (fromId: string) => ({
  tenantId: TENANT_ID,
  conversationId: CONVERSATION_ID,
  sessionId: SESSION_ID,
  finalized: false,
  originatingActivity: { from: { id: fromId, name: 'Ivan' } },
});

const load = async () => await import('../channels/teams/stop');

beforeEach(() => {
  participantRow = undefined;
  participantThrows = false;
  turn = liveTurn('29:owner');
  abortResult = true;
  finalizeClaim = true;
  claims.length = 0;
  finalized.length = 0;
  deleted.length = 0;
  aborted.length = 0;
});

afterEach(() => {
  mock.restore();
});

describe('buildPlanCard — the Stop affordance', () => {
  test('a turn with no session yet carries no Stop button', () => {
    // `startTurn` posts the live card before the session exists. There is
    // nothing to stop until it does, and a button that cannot name a session
    // would only fail when pressed.
    const card = buildPlanCard('Working on it', []) as { actions?: unknown[] };
    expect(card.actions).toBeUndefined();
  });

  test('once the session is known, Stop carries its id', () => {
    const card = buildPlanCard('Working on it', [], SESSION_ID) as {
      actions: Array<{ type: string; title: string; verb: string; data: Record<string, unknown> }>;
    };
    expect(card.actions).toHaveLength(1);
    expect(card.actions[0].type).toBe('Action.Execute');
    expect(card.actions[0].title).toBe('Stop');
    expect(card.actions[0].verb).toBe(TEAMS_STOP_VERB);
    // The invoke that comes back names no turn of its own, so the id has to
    // travel on the card.
    expect(card.actions[0].data).toEqual({ verb: TEAMS_STOP_VERB, sessionId: SESSION_ID });
  });
});

describe('stopTeamsTurn', () => {
  test('the person whose message is running may stop it', async () => {
    const { stopTeamsTurn } = await load();

    const outcome = await stopTeamsTurn({ sessionId: SESSION_ID, teamsUserId: '29:owner', byName: 'Ivan' });

    expect(outcome).toEqual({ stopped: true, stoppedRuntime: true });
    expect(aborted).toEqual([SESSION_ID]);
    // A person asked for this stop: the turn must not read as a failure.
    expect(abortOpts.at(-1)).toEqual({ requestedStop: true });
    expect(finalized).toEqual([{ title: 'Stopped', answer: 'Stopped by Ivan.', unfinished: true }]);
    expect(deleted).toEqual([SESSION_ID]);
  });

  test('the sender is recognised by the AAD id every caller passes', async () => {
    // A real Teams activity carries both ids. Callers pass
    // `teamsUserId(activity)` — the AAD object id — so matching `from.id`
    // alone refused the sender whenever no participant row existed.
    turn = {
      ...liveTurn('29:sender'),
      originatingActivity: { from: { id: '29:sender', aadObjectId: 'aad-sender', name: 'Mia' } },
    };
    participantRow = undefined;
    const { stopTeamsTurn } = await load();

    expect(await stopTeamsTurn({ sessionId: SESSION_ID, teamsUserId: 'aad-sender' })).toEqual({
      stopped: true,
      stoppedRuntime: true,
    });
  });

  test('another user`s AAD id does not pass as the sender', async () => {
    turn = {
      ...liveTurn('29:sender'),
      originatingActivity: { from: { id: '29:sender', aadObjectId: 'aad-sender' } },
    };
    participantRow = undefined;
    const { stopTeamsTurn } = await load();

    expect((await stopTeamsTurn({ sessionId: SESSION_ID, teamsUserId: 'aad-someone-else' })).stopped).toBe(false);
  });

  test('an approved participant may stop a turn they did not start', async () => {
    // Under `project_open` the session owner and the person waiting are
    // routinely different people.
    participantRow = { status: 'approved' };
    const { stopTeamsTurn } = await load();

    expect(await stopTeamsTurn({ sessionId: SESSION_ID, teamsUserId: '29:someone-else' })).toEqual({
      stopped: true,
      stoppedRuntime: true,
    });
  });

  test('a bystander is refused, and nothing is aborted or closed', async () => {
    participantRow = { status: 'pending' };
    const { stopTeamsTurn } = await load();

    const outcome = await stopTeamsTurn({ sessionId: SESSION_ID, teamsUserId: '29:bystander' });

    expect(outcome.stopped).toBe(false);
    expect(aborted).toEqual([]);
    expect(finalized).toEqual([]);
    expect(deleted).toEqual([]);
  });

  test('a denied participant is refused too', async () => {
    participantRow = { status: 'denied' };
    const { stopTeamsTurn } = await load();

    expect((await stopTeamsTurn({ sessionId: SESSION_ID, teamsUserId: '29:denied' })).stopped).toBe(false);
  });

  test('an unresolvable participant lookup refuses rather than assumes', async () => {
    // Fail CLOSED: the worst case is a bystander waiting for a run to end,
    // not a bystander ending someone else's work.
    participantThrows = true;
    const { stopTeamsTurn } = await load();

    expect((await stopTeamsTurn({ sessionId: SESSION_ID, teamsUserId: '29:unknown' })).stopped).toBe(false);
  });

  test('an anonymous presser is refused before any lookup', async () => {
    const { stopTeamsTurn } = await load();

    expect((await stopTeamsTurn({ sessionId: SESSION_ID, teamsUserId: '' })).stopped).toBe(false);
  });

  test('a finished turn says so instead of aborting a runtime again', async () => {
    turn = { ...liveTurn('29:owner'), finalized: true };
    const { stopTeamsTurn } = await load();

    const outcome = await stopTeamsTurn({ sessionId: SESSION_ID, teamsUserId: '29:owner' });

    expect(outcome).toEqual({ stopped: false, notice: 'That run has already finished.' });
    expect(aborted).toEqual([]);
  });

  test('a turn that no longer exists is not an error', async () => {
    turn = null;
    const { stopTeamsTurn } = await load();

    expect((await stopTeamsTurn({ sessionId: SESSION_ID, teamsUserId: '29:owner' })).stopped).toBe(false);
  });

  test('an unreachable runtime still closes the card, and says which happened', async () => {
    // A parked or already-gone sandbox needs no abort, but the ledger must
    // close either way — a card left open is what swallows the next message.
    abortResult = false;
    const { stopTeamsTurn } = await load();

    expect(await stopTeamsTurn({ sessionId: SESSION_ID, teamsUserId: '29:owner' })).toEqual({
      stopped: true,
      stoppedRuntime: false,
    });
    expect(deleted).toEqual([SESSION_ID]);
  });

  test('an abort that throws never escapes the stop', async () => {
    abortResult = new Error('sandbox gone');
    const { stopTeamsTurn } = await load();

    expect((await stopTeamsTurn({ sessionId: SESSION_ID, teamsUserId: '29:owner' })).stopped).toBe(true);
    expect(finalized).toHaveLength(1);
  });

  test('the finalize is claimed BEFORE the runtime is touched', async () => {
    // The abort makes OpenCode end the turn, which relays back as
    // `relayTurnEnd(status: 'error')` and claims the same row. Claiming first
    // is what stops a deliberate Stop being repainted "Run failed" by the
    // failure it caused.
    const order: string[] = [];
    claims.push = ((id: string) => {
      order.push('claim');
      return Array.prototype.push.call(claims, id);
    }) as never;
    aborted.push = ((id: string) => {
      order.push('abort');
      return Array.prototype.push.call(aborted, id);
    }) as never;
    const { stopTeamsTurn } = await load();

    await stopTeamsTurn({ sessionId: SESSION_ID, teamsUserId: '29:owner' });

    expect(order).toEqual(['claim', 'abort']);
  });

  test('a turn that settled between the load and the claim is not painted over', async () => {
    finalizeClaim = false;
    const { stopTeamsTurn } = await load();

    const outcome = await stopTeamsTurn({ sessionId: SESSION_ID, teamsUserId: '29:owner' });

    expect(outcome).toEqual({ stopped: false, notice: 'That run has already finished.' });
    expect(aborted).toEqual([]);
    expect(finalized).toEqual([]);
  });

  test('a refused presser never claims the turn', async () => {
    participantRow = { status: 'pending' };
    const { stopTeamsTurn } = await load();

    await stopTeamsTurn({ sessionId: SESSION_ID, teamsUserId: '29:bystander' });

    expect(claims).toEqual([]);
  });

  test('the abort reaches the runtime BEFORE the card is settled', async () => {
    // A card that says "stopped" over a turn that is still running is the
    // worse lie, so the order is load-bearing.
    const order: string[] = [];
    aborted.push = ((id: string) => {
      order.push('abort');
      return Array.prototype.push.call(aborted, id);
    }) as never;
    finalized.push = ((opts: Record<string, unknown>) => {
      order.push('finalize');
      return Array.prototype.push.call(finalized, opts);
    }) as never;
    const { stopTeamsTurn } = await load();

    await stopTeamsTurn({ sessionId: SESSION_ID, teamsUserId: '29:owner' });

    expect(order).toEqual(['abort', 'finalize']);
  });

  test('a stop with no name still reads as a sentence', async () => {
    const { stopTeamsTurn } = await load();

    await stopTeamsTurn({ sessionId: SESSION_ID, teamsUserId: '29:owner', byName: '   ' });

    expect(finalized[0]).toEqual({ title: 'Stopped', answer: 'Stopped.', unfinished: true });
  });
});
