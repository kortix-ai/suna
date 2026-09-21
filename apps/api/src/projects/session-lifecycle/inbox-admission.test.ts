import { describe, expect, test } from 'bun:test';
import {
  INBOX_BACKOFF_FREE_REFUSALS,
  INBOX_ORDER_BACKOFF_MS,
  INBOX_ORDER_MAX_BACKOFF_MS,
  admissionBackoffMs,
  admitInboxPrompt,
  sessionHoldsTurnAuthority,
  steerTargetTurn,
} from './inbox-admission';
import type { SessionLifecycleCommandRow } from './store';

const activeTurn = (token: string) => ({
  [token]: { token, state: 'active', opencodeSessionId: 'ses_1', messageId: 'msg_1', startedAtMs: 1 },
});

describe('sessionHoldsTurnAuthority', () => {
  test('a running box with a token-keyed active turn holds authority', () => {
    expect(
      sessionHoldsTurnAuthority({ status: 'active', metadata: { activeTurns: activeTurn('t1') } }),
    ).toBe(true);
  });

  test('a running box with the LEGACY single-turn record holds authority too', () => {
    // Rolling deploys still write `activeTurn`; `GET .../turn` and
    // `settleOrphanedSandboxTurns` both read this predicate, so it has to see
    // both shapes.
    expect(
      sessionHoldsTurnAuthority({
        status: 'provisioning',
        metadata: { activeTurn: { token: 't-legacy', state: 'delivering', opencodeSessionId: 'ses_1' } },
      }),
    ).toBe(true);
  });

  test('a STOPPED box holds no authority whatever its metadata still says', () => {
    // Metadata outlives the runtime. `settleOrphanedSandboxTurns` closes every
    // ledger row left open on a stopped box off exactly this predicate.
    expect(
      sessionHoldsTurnAuthority({ status: 'stopped', metadata: { activeTurns: activeTurn('t1') } }),
    ).toBe(false);
  });

  test('a running box with no turn record, and no box at all, hold nothing', () => {
    expect(sessionHoldsTurnAuthority({ status: 'active', metadata: {} })).toBe(false);
    expect(sessionHoldsTurnAuthority({ status: 'active', metadata: null })).toBe(false);
    expect(sessionHoldsTurnAuthority(null)).toBe(false);
  });
});

describe('steerTargetTurn', () => {
  const turn = (
    token: string,
    messageId: string | null,
    startedAtMs: number | null,
    state: 'active' | 'delivering' = 'active',
  ) => ({ token, state, opencodeSessionId: 'ses_1', messageId, startedAtMs });

  test('the NEWEST accepted turn is the response a steer goes into', () => {
    // A steer is its own `/prompt_async` POST, so the proxy records a second
    // `activeTurns` entry for it. OpenCode parents every later step on the
    // newest user message, so that entry — not the turn's original root — is
    // what the next prompt is read against.
    expect(
      steerTargetTurn([turn('a', 'msg_a', 10), turn('b', 'msg_b', 30), turn('c', 'msg_c', 20)]),
    ).toMatchObject({ token: 'b' });
  });

  test('a turn with no accepted message, and a DELIVERING turn, are not steer targets', () => {
    expect(steerTargetTurn([turn('a', null, 10)])).toBeNull();
    expect(steerTargetTurn([turn('a', 'msg_a', 10, 'delivering')])).toBeNull();
    expect(steerTargetTurn([])).toBeNull();
  });

  test('a LEGACY record with no start instant still steers, and loses to one that has a clock', () => {
    // `promptTypedOverTurn` already refuses to end a turn with no
    // `startedAtMs`; it must still be steerable, which is what it was before
    // turn records carried a clock at all.
    expect(steerTargetTurn([turn('legacy', 'msg_l', null)])).toMatchObject({ token: 'legacy' });
    expect(
      steerTargetTurn([turn('legacy', 'msg_l', null), turn('b', 'msg_b', 1)]),
    ).toMatchObject({ token: 'b' });
  });

  test('turns stamped in the same millisecond fall back to the newest wire id', () => {
    // Wire ids are time-ordered (`msg_<hex clock>`), so the greater id is the
    // later message. A total order here keeps the decision deterministic
    // instead of depending on jsonb key order.
    expect(
      steerTargetTurn([turn('a', 'msg_000000000002b', 5), turn('b', 'msg_000000000001a', 5)]),
    ).toMatchObject({ token: 'a' });
  });
});

const row = (overrides: Partial<SessionLifecycleCommandRow> = {}): SessionLifecycleCommandRow =>
  ({
    commandId: 'cmd-1',
    commandType: 'continue_session',
    sessionId: 'sess-1',
    createdAt: new Date('2026-08-18T00:00:00.000Z'),
    payload: { text: 'hi' },
    ...overrides,
  }) as SessionLifecycleCommandRow;

describe('admitInboxPrompt', () => {
  // WAS: 'only the head Quick Queue prompt requests a tool-boundary interrupt'.
  // The head Quick Queue prompt now STEERS into the live turn instead of asking
  // for it to be ended, so the interrupt it used to arm is not armed for it.
  // The rest of this test is unchanged and still binding: Queue List waits, and
  // a Quick Queue row behind an older prompt does neither.
  test('the head Quick Queue prompt steers; the others still wait', async () => {
    const box = { status: 'active', metadata: { activeTurns: activeTurn('t1') } };
    const readSandbox = async () => box;
    const hasInFlightPrompt = async () => false;
    const first = await admitInboxPrompt(row({ payload: { text: 'quick', placement: 'transcript' } }), {
      readSandbox,
      hasInFlightPrompt,
      hasOlderPendingPrompt: async () => false,
    });
    expect(first).toEqual({ admit: true });

    const composer = await admitInboxPrompt(row({ payload: { text: 'later', placement: 'composer' } }), {
      readSandbox,
      hasInFlightPrompt,
      hasOlderPendingPrompt: async () => false,
    });
    expect(composer).toEqual({
      admit: false,
      reason: 'turn_active',
      retryAfterMs: INBOX_ORDER_BACKOFF_MS,
    });

    const behind = await admitInboxPrompt(row({ payload: { text: 'behind', placement: 'transcript' } }), {
      readSandbox,
      hasInFlightPrompt,
      hasOlderPendingPrompt: async () => true,
    });
    expect(behind).not.toHaveProperty('interruptAtBoundary');
  });

  test('a Quick Queue prompt does not end the turn an earlier Quick Queue prompt started', async () => {
    // Reproduced 2026-09-18 on a real sandbox: a long turn A, then Quick Queue
    // prompts B, C, D. B interrupts A — that is Quick Queue. But C waits behind
    // B, becomes the head once B is delivered, and arms an interrupt against
    // B's OWN turn. D then does the same to C. Replies B and C ended
    // `MessageAbortedError` with zero characters; only D answered. N Quick
    // Queue prompts lost N-1 answers, on this branch and on main.
    //
    // WAS guarded by `turnStartedByQuickQueue` ("never end a turn that is a
    // Quick Queue prompt's answer"). That dep is REMOVED: it also refused the
    // case the owner requires — B is answering in streamed text, the user
    // types C OVER that text, and C must end it. What separates the two is not
    // who started the turn but WHEN the prompt was typed: C above was already
    // waiting before B's turn began, so it was never a reaction to B's answer.
    // A prompt created before the active turn started may not end it.
    const turnStartedAtMs = Date.parse('2026-09-18T10:00:05.000Z');
    const box = {
      status: 'active',
      metadata: {
        activeTurns: {
          tB: {
            token: 'tB',
            state: 'active',
            opencodeSessionId: 'ses_1',
            messageId: 'msg_B',
            startedAtMs: turnStartedAtMs,
          },
        },
      },
    };
    let phaseReads = 0;
    const deps = (over: Partial<Parameters<typeof admitInboxPrompt>[1]> = {}) => ({
      readSandbox: async () => box,
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async () => false,
      readLiveTurnPhase: async () => {
        phaseReads++;
        return 'text' as const;
      },
      ...over,
    });
    // C was typed while A was still running — two seconds BEFORE B's turn began.
    const quickC = row({
      commandId: 'cmd-C',
      createdAt: new Date(turnStartedAtMs - 2_000),
      payload: { text: 'C', placement: 'transcript' },
    });

    // B is streaming text, and C still does not end it: C steers.
    expect(await admitInboxPrompt(quickC, deps())).toEqual({ admit: true });
    // The runtime is not even asked — a prompt that cannot end the turn has no
    // use for the answer, and the read is a network round trip to the box.
    expect(phaseReads).toBe(0);

    // WAS: "the bound on steering is unchanged: one steer per turn", asserted
    // through the removed `turnAlreadySteered` dep. Quick Queue messages are
    // now MERGED INTO ONE ANSWER on purpose (`quick-queue-group.ts`), so the
    // one-steer bound is gone: a later Quick Queue head steers into the turn a
    // previous steer recorded, addressed to the NEWEST turn.
    const steeredTurns = {
      status: 'active',
      metadata: {
        activeTurns: {
          tB: {
            token: 'tB',
            state: 'active',
            opencodeSessionId: 'ses_1',
            messageId: 'msg_B',
            startedAtMs: turnStartedAtMs,
          },
          tSteer: {
            token: 'tSteer',
            state: 'active',
            opencodeSessionId: 'ses_1',
            messageId: 'msg_steer',
            startedAtMs: turnStartedAtMs + 1_000,
          },
        },
      },
    };
    expect(
      await admitInboxPrompt(quickC, deps({ readSandbox: async () => steeredTurns })),
    ).toEqual({ admit: true });
    expect(phaseReads).toBe(0);

    // A LEGACY turn record carries no start instant. "Typed over this
    // response" cannot be proven against a number nobody measured, so nothing
    // is ended.
    const legacyBox = {
      status: 'active',
      metadata: {
        activeTurn: { token: 'tL', state: 'active', opencodeSessionId: 'ses_1', messageId: 'msg_B' },
      },
    };
    expect(
      await admitInboxPrompt(
        row({ payload: { text: 'late', placement: 'transcript' } }),
        deps({ readSandbox: async () => legacyBox }),
      ),
    ).toEqual({ admit: true });
    expect(phaseReads).toBe(0);
  });

  describe('a prompt typed over STREAMING TEXT ends that response', () => {
    // THE OWNER'S REPORT, 2026-09-21, reproduced: send "tell me about pigeons",
    // wait five seconds into the answer, press Enter on "crow vs pigeon". The
    // steer was accepted and the UI showed it as working — and the pigeon essay
    // streamed on to its last character. "When I sent two prompts, the first
    // prompt response should be stopped immediately. This is only happening
    // with the text response not with the tool call thing."
    //
    // A steer is read at a STEP boundary. A tool call ends a step every few
    // seconds; a streamed markdown answer is ONE step with no boundary inside
    // it. So the head Quick Queue prompt asks what the turn is doing, and a
    // text stream gets the refusal that arms the daemon's interrupt — which
    // aborts at once when no tool is running — instead of `{ admit: true }`.
    const turnStartedAtMs = Date.parse('2026-09-21T09:00:00.000Z');
    const box = {
      status: 'active',
      metadata: {
        activeTurns: {
          t1: {
            token: 't1',
            state: 'active',
            opencodeSessionId: 'ses_1',
            messageId: 'msg_1',
            startedAtMs: turnStartedAtMs,
          },
        },
      },
    };
    type Deps = NonNullable<Parameters<typeof admitInboxPrompt>[1]>;
    const deps = (over: Partial<Deps> = {}): Deps => ({
      readSandbox: async () => box,
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async () => false,
      ...over,
    });
    // Typed five seconds into the answer.
    const typedOver = (payload: Record<string, unknown> = { placement: 'transcript' }) =>
      row({
        commandId: 'cmd-crow',
        actorUserId: 'user-1',
        createdAt: new Date(turnStartedAtMs + 5_000),
        payload: { text: 'crow vs pigeon', ...payload },
      } as Partial<SessionLifecycleCommandRow>);
    const plainWait = { admit: false, reason: 'turn_active', retryAfterMs: INBOX_ORDER_BACKOFF_MS } as const;

    test('text phase → refused with the interrupt, addressed to exactly the active turn', async () => {
      const reads: unknown[][] = [];
      const admission = await admitInboxPrompt(
        typedOver(),
        deps({
          readLiveTurnPhase: async (...args) => {
            reads.push(args);
            return 'text';
          },
        }),
      );
      expect(admission).toEqual({
        ...plainWait,
        interruptAtBoundary: { opencodeSessionId: 'ses_1', messageId: 'msg_1' },
      });
      // The read is scoped to the turn admission decided on, as the row's actor.
      expect(reads).toEqual([['sess-1', { opencodeSessionId: 'ses_1', messageId: 'msg_1' }, 'user-1']]);
    });

    test('a prompt created in the same millisecond the turn started counts as typed over it', async () => {
      const admission = await admitInboxPrompt(
        row({ createdAt: new Date(turnStartedAtMs), payload: { text: 'x', placement: 'transcript' } }),
        deps({ readLiveTurnPhase: async () => 'text' }),
      );
      expect(admission).toHaveProperty('interruptAtBoundary');
    });

    test('THE EXACT GUARANTEE: a prompt ends only a turn that started before it was typed — a burst loses at most one answer', async () => {
      // The text abort is IMMEDIATE, so B's turn starts about a second after
      // B's Enter. C typed two seconds after B is therefore created AFTER B's
      // turn began, and if B is already writing text, C ends it. That is the
      // owner's rule applied to B — C was typed over B's answer — and it is
      // intended. What the guard bounds is the cascade: D was typed before C's
      // turn began, so D cannot end C. N rapid prompts lose at most the first
      // successor's partial answer, not N-1 answers (2026-09-18).
      const turnFor = (token: string, messageId: string, startedAtMs: number) => ({
        status: 'active',
        metadata: {
          activeTurns: { [token]: { token, state: 'active', opencodeSessionId: 'ses_1', messageId, startedAtMs } },
        },
      });
      const text = { readLiveTurnPhase: async () => 'text' as const };
      const bTurnStartedAtMs = turnStartedAtMs;
      const quickC = row({
        commandId: 'cmd-C',
        createdAt: new Date(bTurnStartedAtMs + 1_000),
        payload: { text: 'C', placement: 'transcript' },
      });
      const quickD = row({
        commandId: 'cmd-D',
        createdAt: new Date(bTurnStartedAtMs + 2_000),
        payload: { text: 'D', placement: 'transcript' },
      });

      // C, typed one second into B's streamed answer, ends B.
      expect(
        await admitInboxPrompt(quickC, deps({ ...text, readSandbox: async () => turnFor('tB', 'msg_B', bTurnStartedAtMs) })),
      ).toEqual({ ...plainWait, interruptAtBoundary: { opencodeSessionId: 'ses_1', messageId: 'msg_B' } });

      // C's turn begins after D was typed. D does not end C's streamed answer.
      const cTurn = turnFor('tC', 'msg_C', bTurnStartedAtMs + 3_000);
      expect(await admitInboxPrompt(quickD, deps({ ...text, readSandbox: async () => cTurn }))).toEqual({
        admit: true,
      });
    });

    test('tool phase and every other phase → steers, exactly as before', async () => {
      expect(await admitInboxPrompt(typedOver(), deps({ readLiveTurnPhase: async () => 'tool' }))).toEqual({
        admit: true,
      });
      expect(await admitInboxPrompt(typedOver(), deps({ readLiveTurnPhase: async () => 'other' }))).toEqual({
        admit: true,
      });
    });

    test('text phase, but the prompt was waiting BEFORE this turn began → it does not end it', async () => {
      const waiting = row({
        createdAt: new Date(turnStartedAtMs - 1),
        payload: { text: 'queued earlier', placement: 'transcript' },
      });
      expect(await admitInboxPrompt(waiting, deps({ readLiveTurnPhase: async () => 'text' }))).toEqual({
        admit: true,
      });
    });

    // WAS: 'a turn that already took a steer is not ended either — the daemon
    // would refuse the arm as stale', asserted through `turnAlreadySteered`.
    // The dep is removed with the one-steer bound. The stale-arm concern it
    // named is now answered by WHICH turn admission addresses: after a steer
    // the newest `activeTurns` entry IS the steer's own message, so the phase
    // read and the interrupt are both addressed to the message the daemon
    // calls newest — never to the turn's stale root.
    test('after a steer, the phase read and the interrupt address the NEWEST turn', async () => {
      const steeredTurns = {
        status: 'active',
        metadata: {
          activeTurns: {
            t1: {
              token: 't1',
              state: 'active',
              opencodeSessionId: 'ses_1',
              messageId: 'msg_1',
              startedAtMs: turnStartedAtMs,
            },
            t2: {
              token: 't2',
              state: 'active',
              opencodeSessionId: 'ses_1',
              messageId: 'msg_steer',
              startedAtMs: turnStartedAtMs + 2_000,
            },
          },
        },
      };
      const reads: unknown[][] = [];
      expect(
        await admitInboxPrompt(
          typedOver(),
          deps({
            readSandbox: async () => steeredTurns,
            readLiveTurnPhase: async (...args) => {
              reads.push(args);
              return 'text';
            },
          }),
        ),
      ).toEqual({
        ...plainWait,
        interruptAtBoundary: { opencodeSessionId: 'ses_1', messageId: 'msg_steer' },
      });
      expect(reads).toEqual([
        ['sess-1', { opencodeSessionId: 'ses_1', messageId: 'msg_steer' }, 'user-1'],
      ]);
    });

    test('the phase read FAILS OPEN — a throw or a rejection steers, it never ends a response', async () => {
      expect(
        await admitInboxPrompt(
          typedOver(),
          deps({
            readLiveTurnPhase: () => {
              throw new Error('sync boom');
            },
          }),
        ),
      ).toEqual({ admit: true });
      expect(
        await admitInboxPrompt(
          typedOver(),
          deps({ readLiveTurnPhase: async () => Promise.reject(new Error('box unreachable')) }),
        ),
      ).toEqual({ admit: true });
      // A value outside the contract is not 'text'.
      expect(
        await admitInboxPrompt(
          typedOver(),
          deps({ readLiveTurnPhase: (async () => 'TEXT') as unknown as Deps['readLiveTurnPhase'] }),
        ),
      ).toEqual({ admit: true });
    });

    test('with no phase read wired at all it steers', async () => {
      expect(await admitInboxPrompt(typedOver(), deps())).toEqual({ admit: true });
    });

    test('Queue List and a row with no placement wait — no interrupt, and the phase is never read', async () => {
      let phaseReads = 0;
      const readLiveTurnPhase = async () => {
        phaseReads++;
        return 'text' as const;
      };
      expect(
        await admitInboxPrompt(typedOver({ placement: 'composer' }), deps({ readLiveTurnPhase })),
      ).toEqual(plainWait);
      expect(await admitInboxPrompt(typedOver({ placement: undefined }), deps({ readLiveTurnPhase }))).toEqual(
        plainWait,
      );
      expect(phaseReads).toBe(0);
    });

    test('a Quick Queue row that is NOT the head neither ends the text nor steers — and reads nothing', async () => {
      let phaseReads = 0;
      const readLiveTurnPhase = async () => {
        phaseReads++;
        return 'text' as const;
      };
      expect(
        await admitInboxPrompt(
          typedOver(),
          deps({ readLiveTurnPhase, hasOlderPendingPrompt: async () => true }),
        ),
      ).toEqual(plainWait);
      expect(
        await admitInboxPrompt(typedOver(), deps({ readLiveTurnPhase, hasInFlightPrompt: async () => true })),
      ).toEqual(plainWait);
      expect(phaseReads).toBe(0);
    });

    // WAS: 'two live turns are not ONE response — nothing is ended'. Two
    // recorded turns are now the ORDINARY state of a steered session: the steer
    // is its own `/prompt_async` POST, so the proxy records a second
    // `activeTurns` entry for it while OpenCode merges it into the one running
    // reply. Refusing on `turns.length !== 1` wedged every Quick Queue prompt
    // sent after the first steer until the turn ended. The newest turn is the
    // response, and it is what a prompt typed over it ends.
    test('two live turns: the NEWEST is the response, and it is the one that is ended', async () => {
      const twoTurns = {
        status: 'active',
        metadata: {
          activeTurns: {
            ...box.metadata.activeTurns,
            t2: {
              token: 't2',
              state: 'active',
              opencodeSessionId: 'ses_1',
              messageId: 'msg_2',
              startedAtMs: turnStartedAtMs + 1_000,
            },
          },
        },
      };
      expect(
        await admitInboxPrompt(
          typedOver(),
          deps({ readSandbox: async () => twoTurns, readLiveTurnPhase: async () => 'text' }),
        ),
      ).toEqual({
        ...plainWait,
        interruptAtBoundary: { opencodeSessionId: 'ses_1', messageId: 'msg_2' },
      });
    });

    test('a turn still DELIVERING is not steered into — only an accepted turn has a message to read', async () => {
      const delivering = {
        status: 'active',
        metadata: {
          activeTurns: {
            t9: {
              token: 't9',
              state: 'delivering',
              opencodeSessionId: 'ses_1',
              messageId: 'msg_9',
              startedAtMs: turnStartedAtMs + 9_000,
            },
          },
        },
      };
      expect(
        await admitInboxPrompt(
          typedOver(),
          deps({ readSandbox: async () => delivering, readLiveTurnPhase: async () => 'text' }),
        ),
      ).toEqual(plainWait);
    });
  });

  describe('a STEERING prompt is admitted INTO the live turn', () => {
    // Enter used to end the running response at its next tool boundary: the
    // in-progress answer came back `MessageAbortedError` with zero characters,
    // and a long tool call died wherever the boundary fell. A steering prompt
    // is instead placed INTO that turn, so the model reads it at its own safe
    // boundary and changes course without losing the work in front of it.
    //
    // Quick Queue IS steering; that is what the lane means. Queue List still
    // queues, and a prompt with no placement is not a correction to work in
    // flight, so it queues too.
    const box = { status: 'active', metadata: { activeTurns: activeTurn('t1') } };
    const deps = (over: Partial<Parameters<typeof admitInboxPrompt>[1]> = {}) => ({
      readSandbox: async () => box,
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async () => false,
      ...over,
    });
    const steering = (over: Record<string, unknown> = {}) =>
      row({ payload: { text: 'actually use Postgres', placement: 'transcript', ...over } });

    test('it is admitted, and nothing is armed against the running turn', async () => {
      expect(await admitInboxPrompt(steering(), deps())).toEqual({ admit: true });
    });

    // WAS: 'the SECOND steer of one turn waits instead — it never interrupts
    // either', which asserted the removed one-steer-per-turn bound through
    // `turnAlreadySteered`. The 2026-09-04 loss that bound was defending
    // against ("HI"/"bye" merged into one step, only "bye" answered) is now
    // prevented by the grouped delivery itself: the merge is deliberate, the
    // hidden hint tells the model to answer every message, and only the last
    // message of a group opens a reply (`quick-queue-group.ts`).
    test('the SECOND Quick Queue head of one turn steers too — Quick Queue merges on purpose', async () => {
      const steeredTurns = {
        status: 'active',
        metadata: {
          activeTurns: {
            ...box.metadata.activeTurns,
            tSteer: {
              token: 'tSteer',
              state: 'active',
              opencodeSessionId: 'ses_1',
              messageId: 'msg_steer',
              startedAtMs: 2,
            },
          },
        },
      };
      expect(
        await admitInboxPrompt(steering(), deps({ readSandbox: async () => steeredTurns })),
      ).toEqual({ admit: true });
    });

    test('the rest of the drain’s own GROUP is not "another delivery on the wire"', async () => {
      // Every row of a group is CLAIMED (`running`) when the head reaches
      // admission. Without the exemption the head reads its own group as a
      // sibling already on the wire and refuses itself for ever.
      const seen: Array<readonly string[]> = [];
      expect(
        await admitInboxPrompt(
          steering(),
          deps({
            hasInFlightPrompt: async (_sessionId, exceptCommandIds) => {
              seen.push(exceptCommandIds);
              return false;
            },
          }),
          { groupCommandIds: ['cmd-2', 'cmd-3'] },
        ),
      ).toEqual({ admit: true });
      expect(seen).toEqual([['cmd-1', 'cmd-2', 'cmd-3']]);
    });

    test('a prompt with NO placement is not a steer — it queues, and never interrupts', async () => {
      // A first prompt, an automation, an older producer. None of them is a
      // correction to work already running.
      expect(await admitInboxPrompt(row({ payload: { text: 'x' } }), deps())).toEqual({
        admit: false,
        reason: 'turn_active',
        retryAfterMs: INBOX_ORDER_BACKOFF_MS,
      });
    });

    test('a Queue List row never steers', async () => {
      expect(
        await admitInboxPrompt(row({ payload: { text: 'x', placement: 'composer' } }), deps()),
      ).toEqual({
        admit: false,
        reason: 'turn_active',
        retryAfterMs: INBOX_ORDER_BACKOFF_MS,
      });
    });

    test('a steering row BEHIND an older prompt waits its turn in the queue', async () => {
      // Order still binds. Only the head may be placed into the live turn.
      expect(
        await admitInboxPrompt(steering(), deps({ hasOlderPendingPrompt: async () => true })),
      ).toEqual({
        admit: false,
        reason: 'turn_active',
        retryAfterMs: INBOX_ORDER_BACKOFF_MS,
      });
    });
  });

  test('a LIVE TURN holds the prompt back — one queued message runs at a time', async () => {
    // THE RULE THIS GATE EXISTS FOR. OpenCode picks up new user messages at
    // STEP boundaries inside a running turn, and it "parents each step on the
    // newest user message and answers everything before it in that step"
    // (`forwarded-placement.ts`). So two prompts forwarded into one live turn
    // share ONE answer: reported 2026-09-04 as a 13-step turn followed by
    // "tell me HI" and "tell me bye" queued together, answered once, with
    // "HI" never spoken.
    //
    // Forwarding mid-turn was tried (4ee30a9c3b) to remove the wait between
    // queued messages, and this is the behaviour it bought. The wait it was
    // removing is gone anyway: `promoteNextInboxRow` is AWAITED on the
    // daemon's own `session.idle` relay (`r4.ts`), and the backoff below is a
    // 2s-capped fallback rather than the 30s ceiling that produced the
    // measured dead air.
    const box = { status: 'active', metadata: { activeTurns: { ...activeTurn('t1'), ...activeTurn('t2') } } };
    expect(sessionHoldsTurnAuthority(box)).toBe(true);

    const admission = await admitInboxPrompt(row(), {
      readSandbox: async () => box,
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async () => false,
    });
    expect(admission).toEqual({
      admit: false,
      reason: 'turn_active',
      retryAfterMs: INBOX_ORDER_BACKOFF_MS,
    });
  });

  test('a STOPPED box holds nothing back — stale metadata is not a live turn', async () => {
    // The gate reads the same predicate `GET .../turn` serves from, so a
    // parked box whose metadata still names a turn cannot wedge the queue.
    const admission = await admitInboxPrompt(row(), {
      readSandbox: async () => ({ status: 'stopped', metadata: { activeTurns: activeTurn('t1') } }),
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async () => false,
    });
    expect(admission).toEqual({ admit: true });
  });

  test('"send now" does NOT jump a live turn — it jumps the QUEUE', async () => {
    // Promotion reorders the line. It cannot put a second message in front of
    // a turn that is already running, because that is the merge above.
    const admission = await admitInboxPrompt(row({ result: { promoted: true } }), {
      readSandbox: async () => ({ status: 'active', metadata: { activeTurns: activeTurn('t1') } }),
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async () => false,
    });
    expect(admission).toEqual({
      admit: false,
      reason: 'turn_active',
      retryAfterMs: INBOX_ORDER_BACKOFF_MS,
    });
  });

  test('refuses when an OLDER prompt for the same session is still pending', async () => {
    // ORDER is the one thing admission still enforces: OpenCode queues by
    // ARRIVAL, so two concurrent forwards of one session would put the user's
    // own messages on the wire out of the order they typed them.
    const seen: Array<{ sessionId: string; row: SessionLifecycleCommandRow }> = [];
    const admission = await admitInboxPrompt(row(), {
      readSandbox: async () => null,
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async (sessionId, candidate) => {
        seen.push({ sessionId, row: candidate });
        return true;
      },
    });
    expect(admission).toEqual({
      admit: false,
      reason: 'older_prompt_pending',
      retryAfterMs: INBOX_ORDER_BACKOFF_MS,
    });
    // Scoped to the session, bounded by this row's own creation instant, and
    // never matching itself — a row that blocks on itself waits for ever.
    expect(seen).toEqual([
      {
        sessionId: 'sess-1',
        row: row(),
      },
    ]);
  });

  test('refuses when a sibling prompt is already ON THE WIRE', async () => {
    // A claimed row spends up to READY_DEADLINE_MS (5 min) inside
    // `continueSession` waiting for a cold box, with no turn and no message
    // written for any of it. Admitting a second prompt into that window puts
    // two deliveries of one session on the wire at once.
    const admission = await admitInboxPrompt(row(), {
      readSandbox: async () => null,
      hasInFlightPrompt: async () => true,
      hasOlderPendingPrompt: async () => false,
    });
    expect(admission).toEqual({
      admit: false,
      reason: 'older_prompt_pending',
      retryAfterMs: INBOX_ORDER_BACKOFF_MS,
    });
  });

  test('admits a session whose prompt is the oldest pending one', async () => {
    const admission = await admitInboxPrompt(row(), {
      readSandbox: async () => null,
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async () => false,
    });
    expect(admission).toEqual({ admit: true });
  });

  test('a row the user asked for BY NAME jumps the order gate', async () => {
    // "Send now" on one queued row: the user pointed at it and must get THAT
    // message, not the oldest one.
    const admission = await admitInboxPrompt(row({ result: { promoted: true } }), {
      readSandbox: async () => null,
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async () => true,
    });
    expect(admission).toEqual({ admit: true });
  });

  test('a promoted row still waits for a sibling prompt already ON THE WIRE', async () => {
    // "Send now" yields the ORDERING rule, not the one-prompt-at-a-time rule.
    const admission = await admitInboxPrompt(row({ result: { promoted: true } }), {
      readSandbox: async () => null,
      hasInFlightPrompt: async () => true,
      hasOlderPendingPrompt: async () => false,
    });
    expect(admission).toEqual({
      admit: false,
      reason: 'older_prompt_pending',
      retryAfterMs: INBOX_ORDER_BACKOFF_MS,
    });
  });

  test('the ordering backoff starts at 300ms and is capped at 2s — a refused row waits for the KICK, not the clock', async () => {
    // A refused row does not poll out a cold boot any more: the terminal relay
    // calls `promoteNextInboxRow`, which makes it due and drains it. This
    // curve only covers the gap a lost kick would leave, so it stays cheap and
    // never grows into the 27s / 45s / 75s of dead air a 30s ceiling produced
    // for three quick messages behind ~1s deliveries (dev, 2026-08-18).
    expect(INBOX_ORDER_BACKOFF_MS).toBe(300);
    expect(INBOX_ORDER_MAX_BACKOFF_MS).toBe(2_000);
    expect(INBOX_BACKOFF_FREE_REFUSALS).toBe(4);

    const curve = (refusals: number) =>
      admissionBackoffMs(INBOX_ORDER_BACKOFF_MS, INBOX_ORDER_MAX_BACKOFF_MS, refusals);
    expect(curve(0)).toBe(300);
    expect(curve(INBOX_BACKOFF_FREE_REFUSALS)).toBe(300);
    expect(curve(INBOX_BACKOFF_FREE_REFUSALS + 1)).toBe(600);
    expect(curve(9)).toBe(2_000);
    // Clamped BEFORE the shift: `2 ** 1e9` is Infinity, and a `Math.min` over
    // it would hand Infinity straight to a Date constructor.
    expect(curve(1e9)).toBe(2_000);
  });

  test('the refusal counter is what makes a waiting row back off further', async () => {
    const admission = await admitInboxPrompt(
      row({ result: { admission_reason: 'older_prompt_pending', admission_refusals: 99 } }),
      {
        readSandbox: async () => null,
        hasInFlightPrompt: async () => false,
        hasOlderPendingPrompt: async () => true,
      },
    );
    expect(admission).toEqual({
      admit: false,
      reason: 'older_prompt_pending',
      retryAfterMs: INBOX_ORDER_MAX_BACKOFF_MS,
    });
  });

  test('a command with no session id is admitted — the drain fails it honestly', async () => {
    // Refusing here would requeue it for ever; `executeQueuedContinue` already
    // dead-letters a row with no session.
    const admission = await admitInboxPrompt(row({ sessionId: null }), {
      readSandbox: async () => null,
      hasInFlightPrompt: async () => {
        throw new Error('must not read');
      },
      hasOlderPendingPrompt: async () => {
        throw new Error('must not read');
      },
    });
    expect(admission).toEqual({ admit: true });
  });
});

describe('missed turn-end recovery', () => {
  test('the queue head rechecks terminal authority and proceeds in the same claim', async () => {
    let ended = false;
    const result = await admitInboxPrompt(row(), {
      readSandbox: async () => ({ status: 'active', metadata: { activeTurns: ended ? {} : activeTurn('t1') } }),
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async () => false,
      reconcileTurn: async () => { ended = true; },
    });
    expect(ended).toBe(true);
    expect(result).toEqual({ admit: true });
  });
  test('later rows do not probe or bypass the head', async () => {
    let probes = 0;
    const result = await admitInboxPrompt(row(), {
      readSandbox: async () => ({ status: 'active', metadata: { activeTurns: activeTurn('t1') } }),
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async () => true,
      reconcileTurn: async () => { probes++; },
    });
    expect(probes).toBe(0);
    expect(result.admit).toBe(false);
  });
  test('a still-active or unreadable turn holds the head after the probe', async () => {
    const result = await admitInboxPrompt(row(), {
      readSandbox: async () => ({ status: 'active', metadata: { activeTurns: activeTurn('t1') } }),
      hasInFlightPrompt: async () => false,
      hasOlderPendingPrompt: async () => false,
      reconcileTurn: async () => {},
    });
    expect(result).toMatchObject({ admit: false, reason: 'turn_active' });
  });
});
