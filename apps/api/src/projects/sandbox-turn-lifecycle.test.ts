import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { mockConfigModule } from './reaping/test-support/mock-config';
import { renderSql as render } from './reaping/test-support/render-sql';
import { WIRE_MESSAGE_ID } from './wire-message-id';

let executed: string[] = [];
let executeResults: unknown[] = [];
let executeError: Error | null = null;
// Fails one specific statement in a multi-statement call. The ledger writes are
// appended after the authority write, so "the ledger is down" is only
// expressible per statement, not with the global `executeError`.
let executeErrorByIndex: Record<number, Error> = {};



mock.module('../config', () => mockConfigModule());
mock.module('../shared/db', () => ({
  db: {
    execute: async (query: unknown) => {
      const callIndex = executed.length;
      executed.push(render(query));
      const scoped = executeErrorByIndex[callIndex];
      if (scoped) throw scoped;
      if (executeError) throw executeError;
      return executeResults.shift() ?? [];
    },
    // The inbox consumption bookkeeping `acceptSandboxTurn` /
    // `completeSandboxTurn` write on the back of their authority writes. This
    // file asserts the AUTHORITY SQL, so the answer is "no inbox row"; without
    // the builder at all it threw into the swallow-and-log path, which is the
    // same result reached by hiding a real failure.
    update: () => ({
      set: () => ({ where: () => ({ returning: async () => [] }) }),
    }),
  },
}));

const {
  acceptSandboxTurn,
  abandonSandboxTurn,
  beginSandboxTurn,
  clearSandboxTurn,
  completeSandboxTurn,
  reconcileSandboxTurnDelivery,
  renewActiveSandboxTurn,
} = await import('./sandbox-turn-lifecycle');

const {
  extractTurnIdentity,
  initialSandboxTurnMetadata,
  prepareInitialSandboxTurn,
  storedSandboxTurns,
  turnCompletionAllowsQueuePromotion,
} = await import('./session-turn-ledger');

beforeEach(() => {
  executed = [];
  executeResults = [];
  executeError = null;
  executeErrorByIndex = {};
  process.env.KORTIX_SANDBOX_TURN_GRANT_MINUTES = '1';
  process.env.KORTIX_SANDBOX_TURN_DELIVERY_GRACE_MINUTES = '1';
});

describe('extractTurnIdentity', () => {
  test('uses the OpenCode root session and client message ID', () => {
    const body = new TextEncoder().encode(JSON.stringify({ messageID: 'msg_turn_1', parts: [] }));
    expect(
      extractTurnIdentity('/session/ses_root/prompt_async?directory=/workspace', body.buffer),
    ).toEqual({ runtimeSessionId: 'ses_root', messageId: 'msg_turn_1' });
  });

  test('a noReply prompt has no turn to track', () => {
    const noReply = new TextEncoder().encode(
      JSON.stringify({ messageID: 'msg_turn_1', parts: [], noReply: true }),
    );
    expect(extractTurnIdentity('/session/ses_root/prompt_async', noReply.buffer)).toBeNull();
    for (const flag of [{ noReply: false }, {}]) {
      const body = new TextEncoder().encode(
        JSON.stringify({ messageID: 'msg_turn_1', parts: [], ...flag }),
      );
      expect(extractTurnIdentity('/session/ses_root/prompt_async', body.buffer)).toEqual({
        runtimeSessionId: 'ses_root',
        messageId: 'msg_turn_1',
      });
    }
  });

  test('returns a null message ID for command turns that OpenCode identifies later', () => {
    expect(extractTurnIdentity('/session/ses_root/command', undefined)).toEqual({
      runtimeSessionId: 'ses_root',
      messageId: null,
    });
  });
});

describe('daemon-delivered initial turn authority', () => {
  test('mints one token-bound delivering record and OpenCode message identity', () => {
    const turn = prepareInitialSandboxTurn(1234);
    expect(turn.token).toBeString();
    expect(turn.messageId).toMatch(WIRE_MESSAGE_ID);
    expect(turn.startedAtMs).toBe(1234);
    expect(initialSandboxTurnMetadata(turn)).toEqual({
      token: turn.token,
      state: 'delivering',
      runtimeSessionId: null,
      opencodeSessionId: null,
      messageId: turn.messageId,
      startedAtMs: 1234,
    });
  });

  test('parses only a token-bound delivering record', () => {
    expect(
      storedSandboxTurns({
        activeTurns: {
          'turn-token': {
            token: 'turn-token',
            state: 'delivering',
            opencodeSessionId: 'ses_root',
            messageId: 'msg_turn_1',
          },
        },
      }).find((turn) => turn.state === 'delivering'),
    ).toEqual({
      token: 'turn-token',
      state: 'delivering',
      runtimeSessionId: 'ses_root',
      messageId: 'msg_turn_1',
      // A record written before `startedAtMs` existed carries no start instant.
      // Null, never a synthesized "now": GET .../turn publishes this instant,
      // and inventing one would report a start nobody measured.
      startedAtMs: null,
    });
    expect(
      storedSandboxTurns({
        activeTurns: { 'turn-token': { token: 'turn-token', state: 'active' } },
      }).find((turn) => turn.state === 'delivering'),
    ).toBeUndefined();
    expect(storedSandboxTurns(null)).toEqual([]);
  });

  test('keeps concurrent token-keyed turns independent', () => {
    expect(
      storedSandboxTurns({
        activeTurns: {
          'token-active': {
            token: 'token-active',
            state: 'active',
            opencodeSessionId: 'ses_a',
            messageId: 'msg_a',
            startedAtMs: 1700,
          },
          'token-delivering': {
            token: 'token-delivering',
            state: 'delivering',
            runtimeSessionId: 'ses_b',
            messageId: 'msg_b',
            // Not a number: a corrupt instant reads as "unknown", not as 1970.
            startedAtMs: 'soon',
          },
        },
      }),
    ).toEqual([
      {
        token: 'token-active',
        state: 'active',
        runtimeSessionId: 'ses_a',
        messageId: 'msg_a',
        startedAtMs: 1700,
      },
      {
        token: 'token-delivering',
        state: 'delivering',
        runtimeSessionId: 'ses_b',
        messageId: 'msg_b',
        startedAtMs: null,
      },
    ]);
  });

  test('ignores malformed or key-mismatched lifecycle authority', () => {
    expect(
      storedSandboxTurns({
        activeTurns: {
          expected: {
            token: 'different',
            state: 'active',
            opencodeSessionId: 'ses_root',
          },
          missingToken: { state: 'active', opencodeSessionId: 'ses_root' },
        },
        // The retired single-record arm is inert: only `activeTurns` is read.
        activeTurn: { token: 'legacy-token', state: 'active', opencodeSessionId: 'ses_root' },
      }),
    ).toEqual([]);
  });
});

describe('control-plane active-turn state', () => {
  test('begin records a delivering turn and grants only delivery grace', async () => {
    executeResults = [[{ live: true }]];
    expect(
      await beginSandboxTurn(
        { externalId: 'ext-1' },
        { token: 'turn-token', runtimeSessionId: 'ses_root', messageId: 'msg_turn_1' },
      ),
    ).toBe('granted');

    expect(executed).toHaveLength(1);
    expect(executed[0]).toContain('activeTurns');
    expect(executed[0]).toContain('delivering');
    expect(executed[0]).toContain('turn-token');
    expect(executed[0]).toContain('msg_turn_1');
    expect(executed[0]).toContain('60');
    expect(executed[0]).toContain('GREATEST');
    expect(executed[0]).not.toContain('active_since +');
    expect(executed[0]).toContain('lifecycleStopClaim');
  });

  test('begin fails closed when the durable record cannot be written', async () => {
    executeError = new Error('database unavailable');

    await expect(
      beginSandboxTurn(
        { externalId: 'ext-1' },
        { token: 'turn-token', runtimeSessionId: 'ses_root', messageId: 'msg_turn_1' },
      ),
    ).rejects.toThrow('database unavailable');
  });

  test('begin fails closed when the database driver returns an unknown result shape', async () => {
    executeResults = [{ unsupported: true }];

    await expect(
      beginSandboxTurn(
        { externalId: 'ext-1' },
        { token: 'turn-token', runtimeSessionId: 'ses_root', messageId: 'msg_turn_1' },
      ),
    ).rejects.toThrow('unsupported database result');
  });

  test('accept uses the token as a CAS and upgrades the record to active', async () => {
    executeResults = [[{ accepted: true }]];
    expect(
      await acceptSandboxTurn({ externalId: 'ext-1' }, 'turn-token', {
        runtimeSessionId: 'ses_root',
        messageId: 'msg_turn_1',
      }),
    ).toBe(true);

    expect(executed[0]).toContain("->>'token'");
    expect(executed[0]).toContain('turn-token');
    expect(executed[0]).toContain('active');
    expect(executed[0]).toContain('ses_root');
    expect(executed[0]).toContain('msg_turn_1');
    expect(executed[0]).toContain("IN ('delivering', 'active')");
    expect(executed[0]).toContain('GREATEST');
  });

  test('a fast terminal event wins over the later accept CAS', async () => {
    executeResults = [[]];
    expect(await acceptSandboxTurn({ externalId: 'ext-1' }, 'turn-token')).toBe(false);
  });

  test('abandon removes only the matching delivery record', async () => {
    await abandonSandboxTurn({ externalId: 'ext-1' }, 'turn-token');

    expect(executed[0]).toContain("->>'token'");
    expect(executed[0]).toContain('turn-token');
    expect(executed[0]).toContain('-  turn-token');
    // The record has to be read before it is erased: RETURNING sees the new row
    // version, so the entry the ledger settle needs is gone by then.
    expect(executed[0]).toContain('FOR UPDATE OF s');
    expect(executed[0]).toContain('AS turn');
  });
});

describe('terminal turn handling', () => {
  test.each([
    ['closed', true],
    ['already_closed', true],
    ['no_active_turn', true],
    ['identity_mismatch', false],
    ['non_terminal', false],
  ] as const)('%s queue promotion is %s', (outcome, expected) => {
    expect(turnCompletionAllowsQueuePromotion({ outcome })).toBe(expected);
  });

  test('an exact terminal identity reports closed', async () => {
    executeResults = [
      [
        {
          ended_turns: [
            {
              token: 'turn-token',
              opencodeSessionId: 'ses_root',
              messageId: 'msg_turn_1',
              startedAtMs: 1_700_000_000_000,
            },
          ],
          active_turn_count: 1,
          completed: true,
        },
      ],
    ];

    expect(
      await completeSandboxTurn('sess-1', 'idle', {
        runtimeSessionId: 'ses_root',
        messageId: 'msg_turn_1',
      }),
    ).toEqual({ outcome: 'closed', activeTurnCount: 1, closedTurnCount: 1 });
  });

  test('a sandbox row with a different active turn reports identity_mismatch', async () => {
    executeResults = [
      [
        {
          ended_turns: [],
          active_turn_count: 1,
          completed: true,
        },
      ],
    ];

    expect(
      await completeSandboxTurn('sess-1', 'idle', {
        runtimeSessionId: 'ses_root',
        messageId: 'msg_stale',
      }),
    ).toEqual({
      outcome: 'identity_mismatch',
      activeTurnCount: 1,
      closedTurnCount: 0,
    });
  });

  // What `end_error` ends up holding — a cause, a requested stop, and which one
  // wins — is decided by SQL, so it is asserted against a real Postgres in
  // `__tests__/integration-sandbox-turn-lifecycle.test.ts`. Here: only what this
  // mock can prove, which statements run at all.
  const MEMORY_GUARD = {
    name: 'SandboxMemoryGuard',
    message: 'sandbox memory at 97% (opencode 513 MB RSS of 3915 MB): turn stopped',
    isRetryable: false,
  };

  test('a late abort never overwrites the reason a turn already has', async () => {
    executeResults = [
      [{ ended_turns: [], active_turn_count: 0, completed: true }],
      [{ already_ended: true }],
    ];

    await completeSandboxTurn(
      'sess-1',
      'error',
      { runtimeSessionId: 'ses_root', messageId: 'msg_turn_1' },
      { name: 'MessageAbortedError', message: 'Aborted' },
    );

    expect(executed.some((query) => query.includes('UPDATE kortix.session_turns'))).toBe(false);
  });

  test('a retryable error is a retry, not an end: it closes nothing and records nothing', async () => {
    // The contract the daemon must respect: a guard frame for an ABORTED turn
    // that still said `error_retryable: true` was dropped right here.
    const result = await completeSandboxTurn(
      'sess-1',
      'error',
      { runtimeSessionId: 'ses_root', messageId: 'msg_turn_1' },
      { ...MEMORY_GUARD, isRetryable: true },
    );

    expect(result.outcome).toBe('non_terminal');
    expect(executed).toHaveLength(0);
  });

  test('a repeated terminal identity reports already_closed', async () => {
    executeResults = [
      [{ ended_turns: [], active_turn_count: 0, completed: true }],
      [{ already_ended: true }],
    ];

    expect(
      await completeSandboxTurn('sess-1', 'idle', {
        runtimeSessionId: 'ses_root',
        messageId: 'msg_turn_1',
      }),
    ).toEqual({ outcome: 'already_closed', activeTurnCount: 0, closedTurnCount: 0 });
  });

  test('a closed identity stays already_closed while a newer turn is active', async () => {
    executeResults = [
      [{ ended_turns: [], active_turn_count: 1, completed: true }],
      [{ already_ended: true }],
    ];

    expect(
      await completeSandboxTurn('sess-1', 'idle', {
        runtimeSessionId: 'ses_root',
        messageId: 'msg_old',
      }),
    ).toEqual({ outcome: 'already_closed', activeTurnCount: 1, closedTurnCount: 0 });
  });

  // PROD 2026-09-26: the API marked most first-prompt turns of a session
  // `abandoned` 9-30s after creation — a daemon boot-time reconciliation race,
  // fixed at the source in apps/kortix-sandbox-agent-server. This is the
  // defense-in-depth half: even if something abandons a turn prematurely, the
  // real completion that follows must overwrite it instead of being silently
  // dropped by the `already_closed` short-circuit.
  test('a genuine completion revives a message the ledger already marked abandoned', async () => {
    executeResults = [
      [{ ended_turns: [], active_turn_count: 0, completed: true }],
      [{ already_ended: true }],
    ];

    await completeSandboxTurn('sess-1', 'idle', {
      runtimeSessionId: 'ses_root',
      messageId: 'msg_turn_1',
    });

    const revive = executed.find((query) => query.includes("t.end_reason = 'abandoned'"));
    expect(revive).toBeDefined();
    expect(revive as string).toContain('completed');
    expect(revive as string).not.toContain('failed');
    expect(revive as string).toContain('msg_turn_1');
  });

  test('a genuine terminal failure also revives an abandoned message, as failed', async () => {
    executeResults = [
      [{ ended_turns: [], active_turn_count: 0, completed: true }],
      [{ already_ended: true }],
    ];

    await completeSandboxTurn(
      'sess-1',
      'error',
      { runtimeSessionId: 'ses_root', messageId: 'msg_turn_1' },
      { name: 'ModelError', message: 'upstream 500', isRetryable: false },
    );

    const revive = executed.find((query) => query.includes("t.end_reason = 'abandoned'"));
    expect(revive).toBeDefined();
    expect(revive as string).toContain('failed');
  });

  test('an abort never revives an abandoned message — it names the effect, not the cause', async () => {
    executeResults = [
      [{ ended_turns: [], active_turn_count: 0, completed: true }],
      [{ already_ended: true }],
    ];

    await completeSandboxTurn(
      'sess-1',
      'error',
      { runtimeSessionId: 'ses_root', messageId: 'msg_turn_1' },
      { name: 'MessageAbortedError', message: 'Aborted' },
    );

    expect(executed.some((query) => query.includes("t.end_reason = 'abandoned'"))).toBe(false);
  });

  test('terminal evidence with no live or historical turn reports no_active_turn', async () => {
    executeResults = [[{ ended_turns: [], active_turn_count: 0, completed: true }], []];

    expect(
      await completeSandboxTurn('sess-1', 'idle', {
        runtimeSessionId: 'ses_root',
        messageId: 'msg_unknown',
      }),
    ).toEqual({ outcome: 'no_active_turn', activeTurnCount: 0, closedTurnCount: 0 });
  });

  test('idle clears the matching message and shortens to the idle timeout', async () => {
    await completeSandboxTurn('sess-1', 'idle', {
      runtimeSessionId: 'ses_root',
      messageId: 'msg_turn_1',
    });

    expect(executed).toHaveLength(1);
    expect(executed[0]).toContain('msg_turn_1');
    expect(executed[0]).toContain('LEAST');
    expect(executed[0]).toContain("IN ('active', 'provisioning')");
    expect(executed[0]).not.toContain('GREATEST');
  });

  test('a stale terminal message cannot close a newer identified turn', async () => {
    await completeSandboxTurn('sess-1', 'idle', {
      runtimeSessionId: 'ses_root',
      messageId: 'msg_old',
    });

    expect(executed[0]).toContain("->>'messageId'");
    expect(executed[0]).toContain('msg_old');
  });

  test('a legacy terminal event without a message ID cannot close an identified turn', async () => {
    await completeSandboxTurn('sess-1', 'idle', {
      runtimeSessionId: 'ses_root',
      messageId: null,
    });

    expect(executed[0]).toContain("->>'messageId'");
    expect(executed[0]).toContain('IS NOT NULL');
    expect(executed[0]).toContain('CASE');
    expect(executed[0]).toContain('ELSE');
    expect(executed[0]).toContain('LEAST');
  });

  test('a retryable model error does not clear or shorten the turn', async () => {
    expect(
      await completeSandboxTurn(
        'sess-1',
        'error',
        { runtimeSessionId: 'ses_root', messageId: 'msg_turn_1' },
        { isRetryable: true },
      ),
    ).toEqual({ outcome: 'non_terminal', activeTurnCount: 0, closedTurnCount: 0 });

    expect(executed).toEqual([]);
  });
});

describe('maintenance renewal', () => {
  test('terminal recovery clears only the exact stored token', async () => {
    executeResults = [[{ cleared: true }]];

    expect(await clearSandboxTurn('sb-1', 'turn-token')).toBe(true);
    expect(executed[0]).toContain("->>'token'");
    expect(executed[0]).toContain('turn-token');
    expect(executed[0]).toContain('LEAST');
    expect(executed[0]).toContain('remaining');
  });
  test('positive OpenCode evidence promotes the exact delivery token', async () => {
    executeResults = [[{ accepted: true }]];

    expect(await reconcileSandboxTurnDelivery('sb-1', 'turn-token', 'active')).toBe('active');
    expect(executed[0]).toContain("->>'token'");
    expect(executed[0]).toContain('turn-token');
  });

  test('terminal OpenCode evidence removes the exact delivery token', async () => {
    executeResults = [[{ cleared: true }]];

    expect(await reconcileSandboxTurnDelivery('sb-1', 'turn-token', 'terminal')).toBe('inactive');
    expect(executed[0]).toContain("->>'token'");
    expect(executed[0]).toContain('LEAST');
  });

  test('an unreadable daemon preserves only the delivery grace already granted', async () => {
    expect(await reconcileSandboxTurnDelivery('sb-1', 'turn-token', 'unknown')).toBe('deferred');
    expect(executed).toEqual([]);
  });

  test('fresh evidence for the exact accepted turn renews the Kortix deadline', async () => {
    executeResults = [[{ renewed: true }]];
    expect(await renewActiveSandboxTurn('sb-1', 'turn-token')).toBe('renewed');

    expect(executed[0]).toContain('turn-token');
    expect(executed[0]).toContain("->>'state'");
    expect(executed[0]).toContain('active');
    expect(executed[0]).toContain('GREATEST');
    expect(executed[0]).toContain('60');
    expect(executed[0]).not.toContain('active_since +');
  });

  test('stale evidence for a different turn receives no renewal', async () => {
    executeResults = [[]];
    expect(await renewActiveSandboxTurn('sb-1', 'stale-token')).toBe('inactive');
  });
});

describe('session_turns ledger dual-write', () => {
  const OWNER = {
    sandbox_id: '11111111-1111-4111-8111-111111111111',
    session_id: 'sess-1',
    project_id: '22222222-2222-4222-8222-222222222222',
    account_id: '33333333-3333-4333-8333-333333333333',
  };

  test('beginSandboxTurn returns the ledger identity from the authority write', async () => {
    executeResults = [[{ ...OWNER, granted: true }]];
    await beginSandboxTurn(
      { externalId: 'ext-1' },
      { token: 'turn-token', runtimeSessionId: 'ses_root', messageId: 'msg_turn_1' },
    );

    expect(executed[0]).toContain('s.sandbox_id');
    expect(executed[0]).toContain('s.session_id');
    expect(executed[0]).toContain('s.project_id');
    expect(executed[0]).toContain('s.account_id');
  });

  test('beginSandboxTurn inserts a delivering ledger row', async () => {
    executeResults = [[{ ...OWNER, granted: true }]];
    expect(
      await beginSandboxTurn(
        { externalId: 'ext-1' },
        { token: 'turn-token', runtimeSessionId: 'ses_root', messageId: 'msg_turn_1' },
      ),
    ).toBe('granted');

    expect(executed).toHaveLength(2);
    expect(executed[1]).toContain('INSERT INTO kortix.session_turns');
    expect(executed[1]).toContain('delivering');
    expect(executed[1]).toContain('turn-token');
    expect(executed[1]).toContain('ON CONFLICT');
    // This INSERT is a SECOND round trip; a stop can commit before it lands and
    // would leave a row nothing could ever close. It therefore selects its
    // identity from the sandbox that still holds this token's authority, and
    // LOCKS that row so a stop mid-commit is waited for instead of raced.
    expect(executed[1]).toContain('FROM kortix.session_sandboxes');
    expect(executed[1]).toContain("s.status IN ('active', 'provisioning')");
    expect(executed[1]).toContain("s.metadata->'activeTurns'->");
    expect(executed[1]).toContain('FOR UPDATE');
    // Identity is read from that same locked row, never re-bound from the
    // authority write's RETURNING: one read cannot disagree with itself.
    expect(executed[1]).toContain('owner.session_id');
    expect(executed[1]).not.toContain('sess-1');
  });

  test('beginSandboxTurn skips the ledger when the authority write returned no identity', async () => {
    executeResults = [[{ live: true }]];
    expect(
      await beginSandboxTurn(
        { externalId: 'ext-1' },
        { token: 'turn-token', runtimeSessionId: 'ses_root', messageId: 'msg_turn_1' },
      ),
    ).toBe('granted');

    expect(executed).toHaveLength(1);
  });

  test('a failed ledger insert never fails the prompt path', async () => {
    executeResults = [[{ ...OWNER, granted: true }]];
    executeErrorByIndex = { 1: new Error('ledger down') };

    expect(
      await beginSandboxTurn(
        { externalId: 'ext-1' },
        { token: 'turn-token', runtimeSessionId: 'ses_root', messageId: 'msg_turn_1' },
      ),
    ).toBe('granted');
    expect(executed).toHaveLength(2);
  });

  test('acceptSandboxTurn upserts the ledger row to active', async () => {
    executeResults = [[{ ...OWNER, accepted: true }]];
    expect(
      await acceptSandboxTurn({ externalId: 'ext-1' }, 'turn-token', {
        runtimeSessionId: 'ses_root',
        messageId: 'msg_turn_1',
      }),
    ).toBe(true);

    expect(executed[1]).toContain('ON CONFLICT (turn_token) DO UPDATE');
    expect(executed[1]).toContain('active');
    expect(executed[1]).toContain('accepted_at');
    expect(executed[1]).toContain("state <> 'ended'");
  });

  test('acceptSandboxTurn creates the ledger row for a daemon-delivered initial turn', async () => {
    executeResults = [[{ ...OWNER, accepted: true }]];
    await acceptSandboxTurn({ externalId: 'ext-1' }, 'boot-token', {
      runtimeSessionId: 'ses_root',
      messageId: 'msg_boot',
    });

    // The boot turn is written straight into metadata by
    // initialSandboxTurnMetadata, so acceptance is its FIRST ledger write.
    expect(executed[1]).toContain('INSERT INTO kortix.session_turns');
    expect(executed[1]).toContain('boot-token');
    expect(executed[1]).toContain('msg_boot');
  });

  test("acceptSandboxTurn's insert carries the same authority guard as begin's", async () => {
    // Being an INSERT in a second round trip, it can open a row after a stop has
    // committed — a row on a parked box that no settle can ever reach again.
    executeResults = [[{ ...OWNER, accepted: true }]];
    await acceptSandboxTurn({ externalId: 'ext-1' }, 'boot-token', {
      runtimeSessionId: 'ses_root',
      messageId: 'msg_boot',
    });

    expect(executed[1]).toContain("s.status IN ('active', 'provisioning')");
    expect(executed[1]).toContain('FOR UPDATE');
    expect(executed[1]).toContain("s.metadata->'activeTurns'->");
    expect(executed[1]).not.toMatch(/'activeTurn'->/);
  });

  const ENDED_TURN = {
    token: 'turn-token',
    runtimeSessionId: 'ses_root',
    messageId: 'msg_turn_1',
    startedAtMs: 1_700_000_000_000,
  };

  test('completeSandboxTurn ends the ledger row instead of deleting it', async () => {
    executeResults = [[{ ...OWNER, ended_turns: [ENDED_TURN], completed: true }]];
    await completeSandboxTurn('sess-1', 'idle', {
      runtimeSessionId: 'ses_root',
      messageId: 'msg_turn_1',
    });

    expect(executed).toHaveLength(2);
    expect(executed[1]).toContain('INSERT INTO kortix.session_turns');
    expect(executed[1]).toContain('ON CONFLICT (turn_token) DO UPDATE');
    expect(executed[1]).toContain("state = 'ended'");
    expect(executed[1]).toContain('end_reason');
    expect(executed[1]).not.toContain('DELETE');
  });

  test('completeSandboxTurn writes history for a turn that has no ledger row yet', async () => {
    executeResults = [[{ ...OWNER, ended_turns: [ENDED_TURN], completed: true }]];
    await completeSandboxTurn('sess-1', 'idle', {
      runtimeSessionId: 'ses_root',
      messageId: 'msg_turn_1',
    });

    // A boot turn never passes through beginSandboxTurn, and beginSandboxTurn's
    // own INSERT is a second round trip a fast terminal end can beat. Both
    // leave nothing to UPDATE, so the settle has to be able to CREATE the row —
    // with the identity the erased metadata entry carried.
    expect(executed[1]).toContain('turn-token');
    expect(executed[1]).toContain('sess-1');
    expect(executed[1]).toContain('ses_root');
    expect(executed[1]).toContain('msg_turn_1');
    expect(executed[1]).toContain(new Date(ENDED_TURN.startedAtMs).toISOString());
  });

  test("completeSandboxTurn records 'failed' for an error end and 'completed' for idle", async () => {
    executeResults = [[{ ...OWNER, ended_turns: [ENDED_TURN], completed: true }]];
    await completeSandboxTurn('sess-1', 'error', {
      runtimeSessionId: 'ses_root',
      messageId: 'msg_turn_1',
    });
    expect(executed[1]).toContain('failed');

    executed = [];
    executeResults = [[{ ...OWNER, ended_turns: [ENDED_TURN], completed: true }]];
    await completeSandboxTurn('sess-1', 'idle', {
      runtimeSessionId: 'ses_root',
      messageId: 'msg_turn_1',
    });
    expect(executed[1]).toContain('completed');
  });

  test('completeSandboxTurn aggregates TOKENS, not metadata keys', async () => {
    executeResults = [[{ ...OWNER, ended_turns: [ENDED_TURN], completed: true }]];
    await completeSandboxTurn('sess-1', 'idle', {
      runtimeSessionId: 'ses_root',
      messageId: 'msg_turn_1',
    });

    // The map's KEY is its entry key, not the record's token; the aggregate
    // must carry the record's TOKEN instead, or the settle ends a row that
    // never existed. Asserting the ledger statement's text cannot prove this —
    // that statement is built from whatever this mock returned. The real guard
    // drives a mismatched key through real Postgres:
    // __tests__/integration-sandbox-turn-lifecycle.test.ts, "a map key that
    // does not match the token settles the ledger row under the token".
    expect(executed[0]).toContain("entry.value->>'token'");
    expect(executed[0]).toContain("'token', selected.token");
    expect(executed[0]).toContain('ended_turns');
  });

  test('completeSandboxTurn skips the ledger when the authority write returned no identity', async () => {
    executeResults = [[{ ended_turns: [ENDED_TURN], completed: true }]];
    await completeSandboxTurn('sess-1', 'idle', {
      runtimeSessionId: 'ses_root',
      messageId: 'msg_turn_1',
    });

    expect(executed).toHaveLength(1);
  });

  test('abandonSandboxTurn settles the ledger row as abandoned', async () => {
    executeResults = [
      [
        {
          ...OWNER,
          turn: {
            token: 'turn-token',
            state: 'delivering',
            opencodeSessionId: 'ses_root',
            messageId: 'msg_turn_1',
            startedAtMs: 1_700_000_000_000,
          },
          abandoned: true,
        },
      ],
    ];

    expect(await abandonSandboxTurn({ externalId: 'ext-1' }, 'turn-token')).toBe(true);

    // Without this the row beginSandboxTurn inserted stays 'delivering' for
    // ever, and every failed delivery (preview.ts 3xx/401/503/4xx/unreachable,
    // turn-stream.ts turn_abandoned) leaves one behind.
    expect(executed).toHaveLength(2);
    expect(executed[1]).toContain('INSERT INTO kortix.session_turns');
    expect(executed[1]).toContain('abandoned');
    expect(executed[1]).toContain('turn-token');
    expect(executed[1]).toContain('msg_turn_1');
  });

  test('abandonSandboxTurn settles a boot turn that carries no stored record', async () => {
    executeResults = [[{ ...OWNER, turn: null, abandoned: true }]];

    expect(await abandonSandboxTurn({ sandboxId: OWNER.sandbox_id }, 'boot-token')).toBe(true);

    expect(executed[1]).toContain('boot-token');
    expect(executed[1]).toContain('abandoned');
  });

  test('a failed abandon ledger write never fails the cleanup path', async () => {
    executeResults = [[{ ...OWNER, turn: null, abandoned: true }]];
    executeErrorByIndex = { 1: new Error('ledger down') };

    expect(await abandonSandboxTurn({ externalId: 'ext-1' }, 'turn-token')).toBe(true);
  });

  test("clearSandboxTurn ends the ledger row with the caller's reason", async () => {
    executeResults = [[{ ...OWNER, cleared: true }]];
    expect(await clearSandboxTurn('sb-1', 'turn-token', 60_000, 'completed')).toBe(true);

    expect(executed).toHaveLength(2);
    expect(executed[1]).toContain('completed');
    expect(executed[1]).toContain('turn-token');
  });

  test('clearSandboxTurn defaults the reason to runtime_gone', async () => {
    executeResults = [[{ ...OWNER, cleared: true }]];
    await clearSandboxTurn('sb-1', 'turn-token');

    expect(executed[1]).toContain('runtime_gone');
  });

  test('a terminal delivery with no reported reason is recorded abandoned', async () => {
    executeResults = [[{ ...OWNER, cleared: true }]];

    // This function only ever sees `delivering` turns — turns nothing has
    // confirmed reached OpenCode. `terminal` is turn_in_flight === false, which
    // the daemon answers for a prompt it never received exactly as for one that
    // finished, so 'completed' here would be a guess about the very case the
    // column exists to name.
    expect(await reconcileSandboxTurnDelivery('sb-1', 'turn-token', 'terminal')).toBe('inactive');
    expect(executed[1]).toContain('abandoned');
    expect(executed[1]).not.toContain('completed');
    expect(executed[1]).not.toContain('runtime_gone');
  });

  test('a terminal delivery the daemon explains keeps the reported reason', async () => {
    executeResults = [[{ ...OWNER, cleared: true }]];

    expect(await reconcileSandboxTurnDelivery('sb-1', 'turn-token', 'terminal', 'completed')).toBe(
      'inactive',
    );
    expect(executed[1]).toContain('completed');
    expect(executed[1]).not.toContain('abandoned');
  });

  test('clearSandboxTurn keeps graceMs as its third positional argument', async () => {
    executeResults = [[{ cleared: true }]];
    await clearSandboxTurn('sb-1', 'turn-token', 60_000);

    expect(executed[0]).toContain('60');
  });
});
