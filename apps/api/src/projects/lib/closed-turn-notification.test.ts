// A turn the control plane closed (KRTX-2041), with an injected session row,
// recipient context and notifier (DI, no mock.module): which closes notify,
// and the event carries what the relay's does — the turn's message id, its
// prompter context and, for an error, the turn's error text.
import { describe, expect, test } from 'bun:test';
import type { SessionPushEvent } from '../../notifications/session-push';
import { notifyClosedTurn, type ClosedTurnSession } from './closed-turn-notification';

const PROJECT = '00000000-0000-4000-8000-000000000001';
const ACCOUNT = '00000000-0000-4000-8000-000000000002';
const SESSION = 'session-synthetic-1';
const PROMPTER = 'user-prompter';

function harness(session: Partial<ClosedTurnSession> | null | Error) {
  const loadedTokens: (readonly string[])[] = [];
  const contexts: (string | null)[] = [];
  const events: SessionPushEvent[] = [];
  const deps = {
    loadSession: async (_sessionId: string, turnTokens: readonly string[]) => {
      loadedTokens.push(turnTokens);
      if (session instanceof Error) throw session;
      if (!session) return null;
      return {
        sessionId: SESSION,
        projectId: PROJECT,
        accountId: ACCOUNT,
        metadata: {},
        origin: 'user',
        childSession: false,
        endErrorNames: [],
        turnMessageId: 'msg-1',
        errorMessage: null,
        ...session,
      };
    },
    context: async (_ref: unknown, turnMessageId: string | null) => {
      contexts.push(turnMessageId);
      return { prompterUserId: PROMPTER, originClass: 'attended' as const, isChild: false };
    },
    notify: async (event: SessionPushEvent) => {
      events.push(event);
      return { reason: 'delivered' as const, recipients: [PROMPTER] };
    },
  };
  return { loadedTokens, contexts, events, deps };
}

describe('notifyClosedTurn', () => {
  test("a completed turn notifies once, with the turn's message id and prompter", async () => {
    const h = harness({});
    await notifyClosedTurn({ sessionId: SESSION, reason: 'completed', turnTokens: ['token-1'] }, h.deps);
    expect(h.loadedTokens).toEqual([['token-1']]);
    expect(h.contexts).toEqual(['msg-1']);
    expect(h.events).toEqual([
      {
        type: 'completion',
        sessionId: SESSION,
        projectId: PROJECT,
        turnMessageId: 'msg-1',
        errorMessage: null,
        prompterUserId: PROMPTER,
        originClass: 'attended',
        isChild: false,
      },
    ]);
  });

  test("a failed turn carries the turn's error text, even when a prompt was promoted", async () => {
    const h = harness({ endErrorNames: ['APIError'], errorMessage: 'rate limited' });
    await notifyClosedTurn({ sessionId: SESSION, reason: 'failed', promoted: true, turnTokens: ['token-1'] }, h.deps);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ type: 'error', errorMessage: 'rate limited', turnMessageId: 'msg-1' });
  });

  test('a requested stop the control plane closed as failed sends nothing', async () => {
    for (const name of ['UserStop', 'QueueInterrupt']) {
      const h = harness({ endErrorNames: [name] });
      await notifyClosedTurn({ sessionId: SESSION, reason: 'failed', turnTokens: ['token-1'] }, h.deps);
      expect(h.events).toEqual([]);
    }
  });

  test('a child session sends nothing', async () => {
    const h = harness({ childSession: true });
    await notifyClosedTurn({ sessionId: SESSION, reason: 'completed' }, h.deps);
    expect(h.events).toEqual([]);
  });

  test('a missing session sends nothing', async () => {
    const h = harness(null);
    await notifyClosedTurn({ sessionId: SESSION, reason: 'failed' }, h.deps);
    expect(h.events).toEqual([]);
  });

  test('no notification type skips the session read', async () => {
    const h = harness({});
    await notifyClosedTurn({ sessionId: SESSION, reason: 'completed', promoted: true }, h.deps);
    await notifyClosedTurn({ sessionId: SESSION, reason: 'unknown' }, h.deps);
    expect(h.loadedTokens).toEqual([]);
    expect(h.events).toEqual([]);
  });

  test('a failed session read never throws', async () => {
    const h = harness(new Error('db down'));
    await notifyClosedTurn({ sessionId: SESSION, reason: 'completed' }, h.deps);
    expect(h.events).toEqual([]);
  });
});
