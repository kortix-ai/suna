/**
 * BOUNDED SANDBOX LIFETIME — W3b/W3c, the ACP progress relay.
 *
 * The signal that makes the model correct for direct-key/BYOK sessions, which
 * produce no usage_events anywhere and would otherwise be killed at the turn
 * ceiling with the shadow gate reporting nothing.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const extendCalls: Array<{ target: unknown; grantMs: number }> = [];

mock.module('./deadline', () => ({
  extendDeadline: async (target: unknown, grantMs: number) => {
    extendCalls.push({ target, grantMs });
  },
}));

const { noteAcpRelayProgress, resetAcpRelayThrottleForTests } = await import('./acp-progress');
const { observeControlPlaneEvent, observeExtension } = await import('./observation');
const { PROGRESS_GRANT_MS, TURN_CEILING_MS } = await import('./constants');

beforeEach(() => {
  extendCalls.length = 0;
  resetAcpRelayThrottleForTests();
});

describe('noteAcpRelayProgress', () => {
  test('an ordinary envelope buys a progress grant', async () => {
    await noteAcpRelayProgress('sess-1', { method: 'session/update' }, observeControlPlaneEvent());
    expect(extendCalls).toEqual([{ target: { sessionId: 'sess-1' }, grantMs: PROGRESS_GRANT_MS }]);
  });

  test('a pending-input relay buys the TURN CEILING, not a progress grant', async () => {
    // A question is a turn that is alive and blocked on a human. It is
    // published with `{ timeoutMs: null }` — an unbounded wait — so 2h is not a
    // defensible overnight window.
    await noteAcpRelayProgress(
      'sess-1',
      { method: 'session/request_input' },
      observeControlPlaneEvent(),
    );
    expect(extendCalls[0]?.grantMs).toBe(TURN_CEILING_MS);
  });

  test('extends on an envelope with NO method — the human’s answer to a question', async () => {
    // The answer returns as a bare JSON-RPC response ({id, result}), which can
    // never match a `method === 'session/prompt'` check. Extending on ANY
    // envelope is what closes the approval-pause hole.
    await noteAcpRelayProgress('sess-1', { id: 7, result: {} }, observeControlPlaneEvent());
    expect(extendCalls).toHaveLength(1);
  });

  test('a self-authored envelope extends NOTHING', async () => {
    await noteAcpRelayProgress(
      'sess-1',
      { method: 'session/prompt' },
      observeExtension({ principalSessionId: 'sess-1', recordSessionId: 'sess-1' }),
    );
    expect(extendCalls).toHaveLength(0);
  });

  test('throttles to one write per session per minute', async () => {
    // An ACP turn emits hundreds of envelopes a second. Without this, WAL
    // volume tracks tokens rather than turns.
    for (let i = 0; i < 50; i += 1) {
      await noteAcpRelayProgress(
        'sess-1',
        { method: 'session/update' },
        observeControlPlaneEvent(),
      );
    }
    expect(extendCalls).toHaveLength(1);
  });

  test('throttles per session, not globally', async () => {
    await noteAcpRelayProgress('sess-1', { method: 'session/update' }, observeControlPlaneEvent());
    await noteAcpRelayProgress('sess-2', { method: 'session/update' }, observeControlPlaneEvent());
    expect(extendCalls.map((c) => c.target)).toEqual([
      { sessionId: 'sess-1' },
      { sessionId: 'sess-2' },
    ]);
  });

  test('a failing write never propagates — the envelope outranks the deadline', async () => {
    mock.module('./deadline', () => ({
      extendDeadline: async () => {
        throw new Error('db down');
      },
    }));
    const fresh = await import('./acp-progress');
    fresh.resetAcpRelayThrottleForTests();
    await expect(
      fresh.noteAcpRelayProgress(
        'sess-boom',
        { method: 'session/update' },
        observeControlPlaneEvent(),
      ),
    ).resolves.toBeUndefined();
  });
});
