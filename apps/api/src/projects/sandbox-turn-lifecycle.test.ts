import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { mockConfigModule } from './reaping/test-support/mock-config';

let executed: string[] = [];
let executeResults: unknown[] = [];
let executeError: Error | null = null;

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
      executed.push(render(query));
      if (executeError) throw executeError;
      return executeResults.shift() ?? [];
    },
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
  prepareInitialSandboxTurn,
  reconcileSandboxTurnDelivery,
  renewActiveSandboxTurn,
  storedSandboxTurn,
  storedSandboxTurns,
} = await import('./sandbox-turn-lifecycle');

beforeEach(() => {
  executed = [];
  executeResults = [];
  executeError = null;
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
          },
          'token-delivering': {
            token: 'token-delivering',
            state: 'delivering',
            opencodeSessionId: 'ses_b',
            messageId: 'msg_b',
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
      },
      {
        token: 'token-delivering',
        state: 'delivering',
        opencodeSessionId: 'ses_b',
        messageId: 'msg_b',
      },
      {
        token: 'legacy-token',
        state: 'active',
        opencodeSessionId: 'ses_legacy',
        messageId: null,
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
