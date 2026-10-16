import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { projects } from '@kortix/db';

import { TEAMS_STOP_VERB, buildPlanCard } from '../channels/teams/cards';
import { config } from '../config';
import { chatIdentityStub } from './helpers/chat-identity-stub';

// Every other Kortix surface can end a run the moment it goes wrong. In Teams
// the only lever was to wait out the 30-minute GC — and a wedged turn swallows
// every later message in the conversation until it fires (dev 2026-09-19: two
// messages lost over two days). These pin the button and who may press it.

const SESSION_ID = 'sess-live';
const TENANT_ID = 'tenant-1';
const CONVERSATION_ID = '19:abc@thread.tacv2';

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
const abortOpts: Array<{ requestedStop?: boolean; stoppedBy?: string | null } | undefined> = [];
mock.module('../projects/session-lifecycle/abort-runtime-turn', () => ({
  abortRuntimeTurn: async (id: string, opts?: { requestedStop?: boolean; stoppedBy?: string | null }) => {
    aborted.push(id);
    abortOpts.push(opts);
    if (abortResult instanceof Error) throw abortResult;
    return abortResult;
  },
}));

const liveTurn = (fromId: string) => ({
  tenantId: TENANT_ID,
  conversationId: CONVERSATION_ID,
  projectId: 'proj-1',
  sessionId: SESSION_ID,
  finalized: false,
  originatingActivity: { from: { id: fromId, name: 'Ivan' } },
});

const load = async () => await import('../channels/teams/stop');
const requireIdentity = config.TEAMS_REQUIRE_USER_IDENTITY;
const REFUSED = 'Only the person who started this run, the session owner or a project manager can stop it.';

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
  turn = liveTurn('29:owner');
  abortResult = true;
  finalizeClaim = true;
  claims.length = 0;
  finalized.length = 0;
  deleted.length = 0;
  aborted.length = 0;
  abortOpts.length = 0;
});

afterEach(() => {
  config.TEAMS_REQUIRE_USER_IDENTITY = requireIdentity;
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
    // ...and it names the Kortix user who asked, for the turn's record.
    expect(abortOpts.at(-1)).toEqual({ requestedStop: true, stoppedBy: 'user-1' });
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
    const { stopTeamsTurn } = await load();

    expect((await stopTeamsTurn({ sessionId: SESSION_ID, teamsUserId: 'aad-someone-else' })).stopped).toBe(false);
  });

  test('someone else in the conversation may not stop a run they did not start', async () => {
    // Under `project_open` any project member may prompt the session, and an
    // approved joiner may under `owner_approval`. Neither may end another
    // person's run: that is the prompter's, the session owner's or a project
    // manager's call, as on every other surface.
    participantRow = { status: 'approved' };
    const { stopTeamsTurn } = await load();

    expect(await stopTeamsTurn({ sessionId: SESSION_ID, teamsUserId: '29:someone-else' })).toEqual({
      stopped: false,
      notice: REFUSED,
    });
    expect(standingChecks).toEqual([
      { userId: 'user-1', accountId: 'acct-1', projectId: 'proj-1', sessionId: SESSION_ID },
    ]);
    expect(claims).toEqual([]);
    expect(aborted).toEqual([]);
    expect(finalized).toEqual([]);
    expect(deleted).toEqual([]);
  });

  test('the session owner or a project manager may stop a run they did not start', async () => {
    standing = true;
    stopActor = { userId: 'user-manager' };
    const { stopTeamsTurn } = await load();

    expect(await stopTeamsTurn({ sessionId: SESSION_ID, teamsUserId: 'aad-manager', byName: 'Ana' })).toEqual({
      stopped: true,
      stoppedRuntime: true,
    });
    expect(abortOpts.at(-1)).toEqual({ requestedStop: true, stoppedBy: 'user-manager' });
    expect(finalized).toEqual([{ title: 'Stopped', answer: 'Stopped by Ana.', unfinished: true }]);
  });

  test('the linked user who prompted the running turn from another surface may stop it', async () => {
    // A member prompted this channel-bound session from the web: the card was
    // drawn for the conversation's message, but the run is theirs.
    stopActor = { userId: 'user-web' };
    prompter = 'user-web';
    const { stopTeamsTurn } = await load();

    expect((await stopTeamsTurn({ sessionId: SESSION_ID, teamsUserId: 'aad-web' })).stopped).toBe(true);
    expect(abortOpts.at(-1)).toEqual({ requestedStop: true, stoppedBy: 'user-web' });
  });

  test('another linked member is not the prompter, and no running turn has one', async () => {
    participantRow = { status: 'approved' };
    stopActor = { userId: 'user-other' };
    prompter = 'user-web';
    const { stopTeamsTurn } = await load();
    expect((await stopTeamsTurn({ sessionId: SESSION_ID, teamsUserId: 'aad-other' })).stopped).toBe(false);

    stopActor = { userId: 'user-web' };
    runningTurn = null;
    expect((await stopTeamsTurn({ sessionId: SESSION_ID, teamsUserId: 'aad-web' })).stopped).toBe(false);
    expect(aborted).toEqual([]);
  });

  test('an unlinked bystander is refused, and nothing is aborted or closed', async () => {
    stopActor = { reason: 'unlinked' };
    const { stopTeamsTurn } = await load();

    const outcome = await stopTeamsTurn({ sessionId: SESSION_ID, teamsUserId: '29:bystander' });

    expect(outcome).toEqual({ stopped: false, notice: REFUSED });
    expect(standingChecks).toEqual([]);
    expect(aborted).toEqual([]);
    expect(finalized).toEqual([]);
    expect(deleted).toEqual([]);
  });

  test('the sender must still be allowed to stop runs in the project', async () => {
    // Removed from the project after sending, or never linked: refused, and
    // the check asks for project.session.stop on the turn's own project.
    for (const reason of ['not_member', 'unlinked'] as const) {
      stopActor = { reason };
      const { stopTeamsTurn } = await load();
      expect((await stopTeamsTurn({ sessionId: SESSION_ID, teamsUserId: '29:owner' })).stopped).toBe(false);
    }
    expect(actorChecks).toEqual([
      { user: '29:owner', projectId: 'proj-1', action: 'project.session.stop' },
      { user: '29:owner', projectId: 'proj-1', action: 'project.session.stop' },
    ]);
    expect(aborted).toEqual([]);
    expect(finalized).toEqual([]);
  });

  test('an owner or manager without a live link, or without project.session.stop, is refused', async () => {
    standing = true;
    for (const reason of ['not_member', 'unlinked'] as const) {
      stopActor = { reason };
      const { stopTeamsTurn } = await load();
      expect((await stopTeamsTurn({ sessionId: SESSION_ID, teamsUserId: 'aad-manager' })).stopped).toBe(false);
    }
    // A project that no longer exists has no owner or manager to ask about.
    stopActor = { userId: 'user-manager' };
    projectRow = undefined;
    const { stopTeamsTurn } = await load();
    expect((await stopTeamsTurn({ sessionId: SESSION_ID, teamsUserId: 'aad-manager' })).stopped).toBe(false);
    // Standing is never asked for a person the link does not name.
    expect(standingChecks).toEqual([]);
    expect(aborted).toEqual([]);
  });

  test('without required identities the sender stops unlinked, and nobody else does', async () => {
    // The conversation runs as the installer then, so the sender needs no
    // link and the stop names no Kortix user.
    config.TEAMS_REQUIRE_USER_IDENTITY = false;
    stopActor = { reason: 'unlinked' };
    const { stopTeamsTurn } = await load();

    expect((await stopTeamsTurn({ sessionId: SESSION_ID, teamsUserId: '29:someone-else' })).stopped).toBe(false);
    expect(aborted).toEqual([]);
    expect((await stopTeamsTurn({ sessionId: SESSION_ID, teamsUserId: '29:owner' })).stopped).toBe(true);
    expect(abortOpts.at(-1)).toEqual({ requestedStop: true, stoppedBy: null });
  });

  test('an unresolvable lookup refuses rather than assumes', async () => {
    // Fail CLOSED: the worst case is a bystander waiting for a run to end,
    // not a bystander ending someone else's work.
    actorThrows = true;
    const { stopTeamsTurn } = await load();
    expect((await stopTeamsTurn({ sessionId: SESSION_ID, teamsUserId: '29:owner' })).stopped).toBe(false);

    // A manager's standing needs the project's account: that lookup fails too.
    actorThrows = false;
    dbThrows = true;
    standing = true;
    expect((await stopTeamsTurn({ sessionId: SESSION_ID, teamsUserId: 'aad-manager' })).stopped).toBe(false);
    expect(aborted).toEqual([]);
  });

  test('an anonymous presser is refused before any lookup', async () => {
    const { stopTeamsTurn } = await load();

    expect((await stopTeamsTurn({ sessionId: SESSION_ID, teamsUserId: '' })).stopped).toBe(false);
    expect(actorChecks).toEqual([]);
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
    stopActor = { reason: 'unlinked' };
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
