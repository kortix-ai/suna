/**
 * Golden SQL for every statement the sandbox turn modules write.
 *
 * Characterization net for the module split: each exported writer runs once
 * against the mocked `db` with fixed inputs and its full rendered SQL is
 * snapshotted. The snapshots were captured on the unsplit module, so a refactor
 * that only moves code reproduces them byte for byte, and any later edit to a
 * statement — including removing the legacy single-record `activeTurn` arm —
 * shows up as a reviewed snapshot diff instead of a silent SQL rewrite.
 *
 * The behavioral contracts these statements carry are asserted against a real
 * Postgres in `__tests__/integration-sandbox-turn-lifecycle.test.ts` and
 * `__tests__/integration-session-turns-stop-race.test.ts`; this file only pins
 * the SQL text.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { mockConfigModule } from './reaping/test-support/mock-config';
import type { SandboxTurnLedgerTransaction } from './session-turn-ledger';

let executed: string[] = [];
let executeResults: unknown[] = [];

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
// `adoptRuntimeSandboxTurn` mints the adopted turn's token with `randomUUID`;
// pin it so the adoption snapshot is deterministic across runs.
const realCrypto = await import('node:crypto');
mock.module('node:crypto', () => ({ ...realCrypto, randomUUID: () => 'adopt-token' }));
mock.module('../shared/db', () => ({
  db: {
    execute: async (query: unknown) => {
      executed.push(render(query));
      return executeResults.shift() ?? [];
    },
    // `acceptSandboxTurn` / `completeSandboxTurn` confirm inbox consumption
    // through the query builder after their authority write; the golden
    // snapshots only pin the raw `execute` statements.
    update: () => ({
      set: () => ({ where: () => ({ returning: async () => [] }) }),
    }),
  },
}));

const {
  abandonSandboxTurn,
  acceptSandboxTurn,
  adoptRuntimeSandboxTurn,
  beginSandboxTurn,
  clearSandboxTurn,
  closeSandboxTurnByMessageId,
  completeSandboxTurn,
  renewActiveSandboxTurn,
} = await import('./sandbox-turn-lifecycle');

const {
  clearTurnStopRequest,
  markTurnStopRequested,
  recordUnidentifiedTurnCause,
  settleOpenSandboxTurns,
  settleOpenSandboxTurnsQuery,
  settleOrphanedSandboxTurns,
  settleOrphanedSandboxTurnsQuery,
} = await import('./session-turn-ledger');

const OWNER = {
  sandbox_id: '11111111-1111-4111-8111-111111111111',
  session_id: 'sess-1',
  project_id: '22222222-2222-4222-8222-222222222222',
  account_id: '33333333-3333-4333-8333-333333333333',
};

const ENDED_TURN = {
  token: 'turn-token',
  opencodeSessionId: 'ses_root',
  messageId: 'msg_turn_1',
  startedAtMs: 1_700_000_000_000,
};

const OBSERVED_AT_MS = 1_700_000_000_000;

const GUARD_CAUSE = {
  name: 'SandboxMemoryGuard',
  message: 'sandbox memory at 97% (opencode 513 MB RSS of 3915 MB): turn stopped',
};

const REAPER_CAUSE = {
  name: 'SandboxStoppedMidTurn',
  message: 'The sandbox stopped unexpectedly while this turn was running.',
};

const IDENTITY = { opencodeSessionId: 'ses_root', messageId: 'msg_turn_1' };

beforeEach(() => {
  executed = [];
  executeResults = [];
  process.env.KORTIX_SANDBOX_TURN_GRANT_MINUTES = '1';
  process.env.KORTIX_SANDBOX_TURN_DELIVERY_GRACE_MINUTES = '1';
});

describe('golden SQL: turn authority statements', () => {
  test('beginSandboxTurn grants and inserts the delivering ledger row', async () => {
    executeResults = [[{ ...OWNER, granted: true }]];
    await beginSandboxTurn(
      { externalId: 'ext-box' },
      { token: 'turn-token', ...IDENTITY },
      undefined,
      OBSERVED_AT_MS,
    );
    expect(executed).toMatchSnapshot();
  });

  test('beginSandboxTurn with no matching box writes one statement', async () => {
    executeResults = [[]];
    await beginSandboxTurn(
      { externalId: 'ext-box' },
      { token: 'turn-token', ...IDENTITY },
      undefined,
      OBSERVED_AT_MS,
    );
    expect(executed).toMatchSnapshot();
  });

  test('acceptSandboxTurn promotes the token and upserts the ledger row', async () => {
    executeResults = [[{ ...OWNER, accepted: true, turn_message_id: 'msg_turn_1' }]];
    await acceptSandboxTurn({ externalId: 'ext-box' }, 'turn-token', IDENTITY);
    expect(executed).toMatchSnapshot();
  });

  test('acceptSandboxTurn with no matching record writes one statement', async () => {
    executeResults = [[]];
    await acceptSandboxTurn({ externalId: 'ext-box' }, 'turn-token');
    expect(executed).toMatchSnapshot();
  });

  test('abandonSandboxTurn erases the delivering record and settles the ledger', async () => {
    executeResults = [
      [
        {
          ...OWNER,
          turn: {
            token: 'turn-token',
            state: 'delivering',
            ...IDENTITY,
            startedAtMs: OBSERVED_AT_MS,
          },
          abandoned: true,
        },
      ],
    ];
    await abandonSandboxTurn({ externalId: 'ext-box' }, 'turn-token');
    expect(executed).toMatchSnapshot();
  });

  test('clearSandboxTurn with a reaper cause ends the ledger row', async () => {
    executeResults = [[{ ...OWNER, cleared: true }]];
    await clearSandboxTurn('sb-1', 'turn-token', 90_000, 'runtime_gone', REAPER_CAUSE);
    expect(executed).toMatchSnapshot();
  });

  test('clearSandboxTurn without a cause keeps end_error untouched', async () => {
    executeResults = [[{ ...OWNER, cleared: true }]];
    await clearSandboxTurn('sb-1', 'turn-token');
    expect(executed).toMatchSnapshot();
  });

  test('renewActiveSandboxTurn renews the deadline of the exact token', async () => {
    executeResults = [[{ renewed: true }]];
    await renewActiveSandboxTurn('sb-1', 'turn-token');
    expect(executed).toMatchSnapshot();
  });
});

describe('golden SQL: terminal evidence', () => {
  test('completeSandboxTurn closes the matched turn and ends its ledger row', async () => {
    executeResults = [
      [{ ...OWNER, ended_turns: [ENDED_TURN], active_turn_count: 1, completed: true }],
    ];
    await completeSandboxTurn('sess-1', 'idle', IDENTITY);
    expect(executed).toMatchSnapshot();
  });

  test('completeSandboxTurn records a named failure', async () => {
    executeResults = [
      [{ ...OWNER, ended_turns: [ENDED_TURN], active_turn_count: 1, completed: true }],
    ];
    await completeSandboxTurn('sess-1', 'error', IDENTITY, {
      name: 'ModelError',
      message: 'upstream 500',
      isRetryable: false,
    });
    expect(executed).toMatchSnapshot();
  });

  test('completeSandboxTurn refines an already-closed row with the cause', async () => {
    executeResults = [
      [{ ended_turns: [], active_turn_count: 0, completed: true }],
      [{ already_ended: true }],
    ];
    await completeSandboxTurn('sess-1', 'error', IDENTITY, GUARD_CAUSE);
    expect(executed).toMatchSnapshot();
  });

  test('completeSandboxTurn revives an abandoned row on a late completion', async () => {
    executeResults = [
      [{ ended_turns: [], active_turn_count: 0, completed: true }],
      [{ already_ended: true }],
    ];
    await completeSandboxTurn('sess-1', 'idle', IDENTITY);
    expect(executed).toMatchSnapshot();
  });

  test('a retryable error writes no statement at all', async () => {
    const result = await completeSandboxTurn('sess-1', 'error', IDENTITY, { isRetryable: true });
    expect(result.outcome).toBe('non_terminal');
    expect(executed).toEqual([]);
  });

  test('closeSandboxTurnByMessageId closes by message and settles the ledger', async () => {
    executeResults = [[{ ...OWNER, ended_turns: [ENDED_TURN] }], [{ turn_token: 'turn-token' }]];
    await closeSandboxTurnByMessageId('sess-1', 'msg_turn_1', 'abandoned');
    expect(executed).toMatchSnapshot();
  });
});

describe('golden SQL: runtime adoption', () => {
  test('adoptRuntimeSandboxTurn adopts an unseen box-initiated turn', async () => {
    executeResults = [
      [{ known: false, open: false }],
      [{ ...OWNER, granted: true }],
      [{ ...OWNER, accepted: true, turn_message_id: 'msg_adopt' }],
    ];
    await adoptRuntimeSandboxTurn('sb-1', {
      opencodeSessionId: 'ses_root',
      messageId: 'msg_adopt',
    });
    expect(executed).toMatchSnapshot();
  });

  test('adoptRuntimeSandboxTurn refuses a message the ledger already knows', async () => {
    executeResults = [[{ known: true, open: false }]];
    await adoptRuntimeSandboxTurn('sb-1', {
      opencodeSessionId: 'ses_root',
      messageId: 'msg_adopt',
    });
    expect(executed).toMatchSnapshot();
  });
});

describe('golden SQL: requested-stop marks', () => {
  test('markTurnStopRequested scopes to one OpenCode session', async () => {
    await markTurnStopRequested('sess-1', 'UserStop', { opencodeSessionId: 'ses_root' });
    expect(executed).toMatchSnapshot();
  });

  test('markTurnStopRequested without a scope matches every open turn', async () => {
    await markTurnStopRequested('sess-1', 'QueueInterrupt');
    expect(executed).toMatchSnapshot();
  });

  test('clearTurnStopRequest withdraws the mark', async () => {
    await clearTurnStopRequest('sess-1', 'QueueInterrupt');
    expect(executed).toMatchSnapshot();
  });
});

describe('golden SQL: unidentified-cause recorder', () => {
  test('recordUnidentifiedTurnCause refines the newest bare abort', async () => {
    executeResults = [[{ turn_token: 'turn-token' }]];
    await recordUnidentifiedTurnCause('sess-1', 'ses_root', GUARD_CAUSE);
    expect(executed).toMatchSnapshot();
  });

  test('recordUnidentifiedTurnCause marks the open turn when nothing ended', async () => {
    executeResults = [[], [{ turn_token: 'turn-token' }]];
    await recordUnidentifiedTurnCause('sess-1', 'ses_root', GUARD_CAUSE);
    expect(executed).toMatchSnapshot();
  });
});

describe('golden SQL: settle backstops', () => {
  test('settleOpenSandboxTurnsQuery ends every open row with the cause', () => {
    expect(
      render(settleOpenSandboxTurnsQuery('sb-1', 'runtime_gone', REAPER_CAUSE)),
    ).toMatchSnapshot();
  });

  test('settleOpenSandboxTurnsQuery without a cause leaves end_error alone', () => {
    expect(render(settleOpenSandboxTurnsQuery('sb-1', 'runtime_gone'))).toMatchSnapshot();
  });

  test('settleOpenSandboxTurns runs inside the caller transaction', async () => {
    const tx: SandboxTurnLedgerTransaction = {
      execute: async (query: unknown) => {
        executed.push(render(query));
        return [];
      },
      transaction: (fn) => fn(tx),
    };
    await settleOpenSandboxTurns(tx, 'sb-1', 'runtime_gone', REAPER_CAUSE);
    expect(executed).toMatchSnapshot();
  });

  test('settleOrphanedSandboxTurnsQuery closes rows on sandboxes that stopped', () => {
    expect(render(settleOrphanedSandboxTurnsQuery())).toMatchSnapshot();
  });

  test('settleOrphanedSandboxTurns returns the row count', async () => {
    executeResults = [{ count: 3 }];
    expect(await settleOrphanedSandboxTurns()).toBe(3);
    expect(executed).toMatchSnapshot();
  });
});
