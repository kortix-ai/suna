import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { mockConfigModule } from './reaping/test-support/mock-config';

let executed: string[] = [];
let executeResults: unknown[] = [];
let executeError: Error | null = null;
// Fails one specific statement in a multi-statement call. The ledger writes are
// appended after the authority write, so "the ledger is down" is only
// expressible per statement, not with the global `executeError`.
let executeErrorByIndex: Record<number, Error> = {};

function render(query: unknown): string {
  if (query === null || query === undefined) return '';
  if (typeof query !== 'object') return String(query);
  const node = query as { queryChunks?: unknown[]; value?: unknown; name?: unknown };
  if (Array.isArray(node.queryChunks)) return node.queryChunks.map(render).join(' ');
  if (Array.isArray(node.value)) return node.value.join('');
  if (node.value !== undefined) return String(node.value);
  if (node.name !== undefined) return String(node.name);
  return '';
}

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
  deliveringSandboxTurn,
  extractTurnIdentity,
  initialSandboxTurnMetadata,
  normalizeTurnError,
  prepareInitialSandboxTurn,
  reconcileSandboxTurnDelivery,
  renewActiveSandboxTurn,
  storedSandboxTurn,
  storedSandboxTurns,
  syntheticTurnError,
} = await import('./sandbox-turn-lifecycle');

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
    ).toEqual({ opencodeSessionId: 'ses_root', messageId: 'msg_turn_1' });
  });

  test('returns a null message ID for command turns that OpenCode identifies later', () => {
    expect(extractTurnIdentity('/session/ses_root/command', undefined)).toEqual({
      opencodeSessionId: 'ses_root',
      messageId: null,
    });
  });
});

describe('daemon-delivered initial turn authority', () => {
  test('mints one token-bound delivering record and OpenCode message identity', () => {
    const turn = prepareInitialSandboxTurn(1234);
    expect(turn.token).toBeString();
    expect(turn.messageId).toStartWith('msg_');
    expect(turn.startedAtMs).toBe(1234);
    expect(initialSandboxTurnMetadata(turn)).toEqual({
      token: turn.token,
      state: 'delivering',
      opencodeSessionId: null,
      messageId: turn.messageId,
      startedAtMs: 1234,
    });
  });

  test('parses only a token-bound delivering record', () => {
    expect(
      deliveringSandboxTurn({
        activeTurn: {
          token: 'turn-token',
          state: 'delivering',
          opencodeSessionId: 'ses_root',
          messageId: 'msg_turn_1',
        },
      }),
    ).toEqual({
      token: 'turn-token',
      state: 'delivering',
      opencodeSessionId: 'ses_root',
      messageId: 'msg_turn_1',
      // A legacy `activeTurn` record predates `startedAtMs`. Null, never a
      // synthesized "now": GET .../turn publishes this instant, and inventing
      // one would report a start nobody measured.
      startedAtMs: null,
    });
    expect(
      deliveringSandboxTurn({ activeTurn: { token: 'turn-token', state: 'active' } }),
    ).toBeNull();
    expect(
      storedSandboxTurn({
        activeTurn: {
          token: 'turn-token',
          state: 'active',
          opencodeSessionId: 'ses_root',
          messageId: 'msg_turn_1',
        },
      })?.state,
    ).toBe('active');
    expect(deliveringSandboxTurn(null)).toBeNull();
  });

  test('keeps concurrent token-keyed turns independent and reads legacy state', () => {
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
            opencodeSessionId: 'ses_b',
            messageId: 'msg_b',
            // Not a number: a corrupt instant reads as "unknown", not as 1970.
            startedAtMs: 'soon',
          },
        },
        activeTurn: {
          token: 'legacy-token',
          state: 'active',
          opencodeSessionId: 'ses_legacy',
          messageId: null,
        },
      }),
    ).toEqual([
      {
        token: 'token-active',
        state: 'active',
        opencodeSessionId: 'ses_a',
        messageId: 'msg_a',
        startedAtMs: 1700,
      },
      {
        token: 'token-delivering',
        state: 'delivering',
        opencodeSessionId: 'ses_b',
        messageId: 'msg_b',
        startedAtMs: null,
      },
      {
        token: 'legacy-token',
        state: 'active',
        opencodeSessionId: 'ses_legacy',
        messageId: null,
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
        activeTurn: { state: 'active', opencodeSessionId: 'ses_root' },
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
        { token: 'turn-token', opencodeSessionId: 'ses_root', messageId: 'msg_turn_1' },
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
        { token: 'turn-token', opencodeSessionId: 'ses_root', messageId: 'msg_turn_1' },
      ),
    ).rejects.toThrow('database unavailable');
  });

  test('begin fails closed when the database driver returns an unknown result shape', async () => {
    executeResults = [{ unsupported: true }];

    await expect(
      beginSandboxTurn(
        { externalId: 'ext-1' },
        { token: 'turn-token', opencodeSessionId: 'ses_root', messageId: 'msg_turn_1' },
      ),
    ).rejects.toThrow('unsupported database result');
  });

  test('accept uses the token as a CAS and upgrades the record to active', async () => {
    executeResults = [[{ accepted: true }]];
    expect(
      await acceptSandboxTurn({ externalId: 'ext-1' }, 'turn-token', {
        opencodeSessionId: 'ses_root',
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
    expect(executed[0]).toContain("- 'activeTurn'");
    expect(executed[0]).toContain('-  turn-token');
    // The record has to be read before it is erased: RETURNING sees the new row
    // version, so the entry the ledger settle needs is gone by then.
    expect(executed[0]).toContain('FOR UPDATE OF s');
    expect(executed[0]).toContain('AS turn');
  });
});

describe('terminal turn handling', () => {
  test('idle clears the matching message and shortens to the idle timeout', async () => {
    await completeSandboxTurn('sess-1', 'idle', {
      opencodeSessionId: 'ses_root',
      messageId: 'msg_turn_1',
    });

    expect(executed).toHaveLength(1);
    expect(executed[0]).toContain("- 'activeTurn'");
    expect(executed[0]).toContain('jsonb_object_agg');
    expect(executed[0]).toContain('msg_turn_1');
    expect(executed[0]).toContain('LEAST');
    expect(executed[0]).toContain("IN ('active', 'provisioning')");
    expect(executed[0]).not.toContain('GREATEST');
  });

  test('a stale terminal message cannot close a newer identified turn', async () => {
    await completeSandboxTurn('sess-1', 'idle', {
      opencodeSessionId: 'ses_root',
      messageId: 'msg_old',
    });

    expect(executed[0]).toContain("->>'messageId'");
    expect(executed[0]).toContain('msg_old');
  });

  test('a legacy terminal event without a message ID cannot close an identified turn', async () => {
    await completeSandboxTurn('sess-1', 'idle', {
      opencodeSessionId: 'ses_root',
      messageId: null,
    });

    expect(executed[0]).toContain("->>'messageId'");
    expect(executed[0]).toContain('IS NOT NULL');
    expect(executed[0]).toContain('CASE');
    expect(executed[0]).toContain('ELSE');
    expect(executed[0]).toContain('LEAST');
  });

  test('a retryable model error does not clear or shorten the turn', async () => {
    await completeSandboxTurn(
      'sess-1',
      'error',
      { opencodeSessionId: 'ses_root', messageId: 'msg_turn_1' },
      { isRetryable: true },
    );

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
      { token: 'turn-token', opencodeSessionId: 'ses_root', messageId: 'msg_turn_1' },
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
        { token: 'turn-token', opencodeSessionId: 'ses_root', messageId: 'msg_turn_1' },
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
        { token: 'turn-token', opencodeSessionId: 'ses_root', messageId: 'msg_turn_1' },
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
        { token: 'turn-token', opencodeSessionId: 'ses_root', messageId: 'msg_turn_1' },
      ),
    ).toBe('granted');
    expect(executed).toHaveLength(2);
  });

  test('acceptSandboxTurn upserts the ledger row to active', async () => {
    executeResults = [[{ ...OWNER, accepted: true }]];
    expect(
      await acceptSandboxTurn({ externalId: 'ext-1' }, 'turn-token', {
        opencodeSessionId: 'ses_root',
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
      opencodeSessionId: 'ses_root',
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
      opencodeSessionId: 'ses_root',
      messageId: 'msg_boot',
    });

    expect(executed[1]).toContain("s.status IN ('active', 'provisioning')");
    expect(executed[1]).toContain('FOR UPDATE');
    // The legacy single-record arm counts as authority too, or a whole rolling
    // deploy would record no history at all.
    expect(executed[1]).toContain("s.metadata->'activeTurn'->>'token'");
  });

  const ENDED_TURN = {
    token: 'turn-token',
    opencodeSessionId: 'ses_root',
    messageId: 'msg_turn_1',
    startedAtMs: 1_700_000_000_000,
  };

  test('completeSandboxTurn ends the ledger row instead of deleting it', async () => {
    executeResults = [[{ ...OWNER, ended_turns: [ENDED_TURN], completed: true }]];
    await completeSandboxTurn('sess-1', 'idle', {
      opencodeSessionId: 'ses_root',
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
      opencodeSessionId: 'ses_root',
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
      opencodeSessionId: 'ses_root',
      messageId: 'msg_turn_1',
    });
    expect(executed[1]).toContain('failed');

    executed = [];
    executeResults = [[{ ...OWNER, ended_turns: [ENDED_TURN], completed: true }]];
    await completeSandboxTurn('sess-1', 'idle', {
      opencodeSessionId: 'ses_root',
      messageId: 'msg_turn_1',
    });
    expect(executed[1]).toContain('completed');
  });

  test('completeSandboxTurn aggregates TOKENS, not metadata keys', async () => {
    executeResults = [[{ ...OWNER, ended_turns: [ENDED_TURN], completed: true }]];
    await completeSandboxTurn('sess-1', 'idle', {
      opencodeSessionId: 'ses_root',
      messageId: 'msg_turn_1',
    });

    // The legacy single-record arm's KEY is the literal 'activeTurn'; the
    // aggregate must carry the record's TOKEN instead, or the settle ends a row
    // that never existed. Asserting the ledger statement's text cannot prove
    // this — that statement is built from whatever this mock returned. The real
    // guard drives the legacy shape through real Postgres:
    // __tests__/integration-sandbox-turn-lifecycle.test.ts, "the legacy
    // activeTurn record settles its ledger row under its own token".
    expect(executed[0]).toContain("entry.value->>'token'");
    expect(executed[0]).toContain("'token', selected.token");
    expect(executed[0]).toContain('ended_turns');
  });

  test('completeSandboxTurn skips the ledger when the authority write returned no identity', async () => {
    executeResults = [[{ ended_turns: [ENDED_TURN], completed: true }]];
    await completeSandboxTurn('sess-1', 'idle', {
      opencodeSessionId: 'ses_root',
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
    // r4.ts turn_abandoned) leaves one behind.
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

/**
 * THE TERMINAL ERROR — `session_turns.error`.
 *
 * OpenCode's `session.error` (a bad model id, a provider 4xx, an out-of-credit
 * 402) can fire before any assistant message exists, and OpenCode then persists
 * NOTHING for the turn but the user message. The relayed text is the only
 * description of the failure that will ever exist, so dropping it makes a
 * failed prompt indistinguishable from one nothing ever answered.
 */
describe('turn error normalization', () => {
  const AT = new Date('2026-08-19T10:00:00.000Z');

  test('carries the reported error through in the stored snake_case shape', () => {
    expect(
      normalizeTurnError(
        {
          name: 'ModelNotFound',
          message: 'Model kortix/grok-4.6 not found',
          statusCode: 404,
          isRetryable: false,
          providerID: 'kortix',
        },
        AT,
      ),
    ).toEqual({
      name: 'ModelNotFound',
      message: 'Model kortix/grok-4.6 not found',
      status_code: 404,
      is_retryable: false,
      provider_id: 'kortix',
      recorded_at: '2026-08-19T10:00:00.000Z',
    });
  });

  test('returns null when the relay named nothing at all', () => {
    // `completeSandboxTurn` is also how an ordinary session.idle lands. A
    // completed turn must store no error, or every read has to re-derive "did
    // this actually fail?" from end_reason anyway.
    expect(normalizeTurnError(undefined, AT)).toBeNull();
    expect(normalizeTurnError({}, AT)).toBeNull();
    expect(normalizeTurnError({ name: '   ', message: '' }, AT)).toBeNull();
  });

  test('a status code alone is enough to record, and writes its own sentence', () => {
    expect(normalizeTurnError({ statusCode: 429 }, AT)).toEqual({
      name: 'TurnFailed',
      message: 'The model call failed (429).',
      status_code: 429,
      recorded_at: '2026-08-19T10:00:00.000Z',
    });
  });

  test('MASKS a credential the provider echoed back, and keeps the sentence', () => {
    // The audit sanitizer replaces the whole value; that is right for an audit
    // row and useless here — the user would be shown "[REDACTED]" instead of
    // what went wrong. Only the matched span may be masked.
    const error = normalizeTurnError(
      {
        name: 'AuthError',
        message: 'upstream rejected Authorization: Bearer sk-live-abcdef123456',
      },
      AT,
    );
    expect(error?.message).not.toContain('sk-live-abcdef123456');
    expect(error?.message).toContain('upstream rejected');
    expect(error?.message).toContain('[redacted]');
  });

  test('caps the stored message at 4 KB of UTF-8', () => {
    const error = normalizeTurnError({ name: 'Huge', message: 'x'.repeat(20_000) }, AT);
    expect(Buffer.byteLength(error?.message ?? '', 'utf8')).toBeLessThanOrEqual(4096);
    expect(error?.message.endsWith('…')).toBe(true);
  });

  test('a completed turn has no synthetic error; every other reason has one', () => {
    expect(syntheticTurnError('completed', AT)).toBeNull();
    for (const reason of ['abandoned', 'runtime_gone', 'failed', 'unknown'] as const) {
      const error = syntheticTurnError(reason, AT);
      expect(error?.name).toBeTruthy();
      // Honest and short: the sentence describes the reason and claims nothing
      // about a cause nobody observed.
      expect(error?.message.length).toBeLessThan(120);
    }
  });
});

describe('the ledger records WHY a turn failed', () => {
  const OWNER_ROW = {
    session_id: 'sess-1',
    sandbox_id: '11111111-1111-4111-8111-111111111111',
    project_id: '22222222-2222-4222-8222-222222222222',
    account_id: '33333333-3333-4333-8333-333333333333',
  };
  const ENDED = {
    token: 'turn-token',
    opencodeSessionId: 'ses_root',
    messageId: 'msg_turn_1',
    startedAtMs: 1_700_000_000_000,
  };

  test('a relayed session.error is written onto the row, text and all', async () => {
    executeResults = [[{ ...OWNER_ROW, ended_turns: [ENDED], completed: true }]];
    await completeSandboxTurn(
      'sess-1',
      'error',
      { opencodeSessionId: 'ses_root', messageId: 'msg_turn_1' },
      {
        name: 'ModelNotFound',
        message: 'Model kortix/grok-4.6 not found',
        statusCode: 404,
        isRetryable: false,
        providerID: 'kortix',
      },
    );
    expect(executed[1]).toContain('ModelNotFound');
    expect(executed[1]).toContain('kortix/grok-4.6');
    expect(executed[1]).toContain('"status_code":404');
    // FIRST WRITER WINS on re-settle: a later finalizer knows strictly less.
    expect(executed[1]).toContain('error = coalesce(kortix.session_turns.error, EXCLUDED.error)');
  });

  test('an error end with no reported text still stores a readable failure', async () => {
    executeResults = [[{ ...OWNER_ROW, ended_turns: [ENDED], completed: true }]];
    await completeSandboxTurn('sess-1', 'error', {
      opencodeSessionId: 'ses_root',
      messageId: 'msg_turn_1',
    });
    expect(executed[1]).toContain('TurnFailed');
  });

  test('an idle end stores NO error', async () => {
    executeResults = [[{ ...OWNER_ROW, ended_turns: [ENDED], completed: true }]];
    await completeSandboxTurn('sess-1', 'idle', {
      opencodeSessionId: 'ses_root',
      messageId: 'msg_turn_1',
    });
    expect(executed[1]).toContain('NULL::jsonb');
    expect(executed[1]).not.toContain('TurnFailed');
  });

  test('an abandoned delivery says so, instead of ending silently', async () => {
    // "The runtime never took this prompt" is the case the user experiences as
    // NOTHING HAPPENING. It has no error text of its own — the component that
    // would have written one is the component that went away.
    executeResults = [
      [
        {
          ...OWNER_ROW,
          turn: {
            token: 'turn-token',
            state: 'delivering',
            opencodeSessionId: 'ses_root',
            messageId: 'msg_turn_1',
          },
          abandoned: true,
        },
      ],
    ];
    await abandonSandboxTurn({ sandboxId: OWNER_ROW.sandbox_id }, 'turn-token');
    expect(executed[1]).toContain('TurnAbandoned');
    expect(executed[1]).toContain('The runtime did not accept this prompt.');
  });

  test('a turn cleared because the runtime went away says THAT', async () => {
    executeResults = [
      [
        {
          ...OWNER_ROW,
          turn: {
            token: 'turn-token',
            state: 'active',
            opencodeSessionId: 'ses_root',
            messageId: 'msg_turn_1',
          },
          cleared: true,
        },
      ],
    ];
    await clearSandboxTurn(OWNER_ROW.sandbox_id, 'turn-token');
    expect(executed[1]).toContain('RuntimeGone');
  });
});
