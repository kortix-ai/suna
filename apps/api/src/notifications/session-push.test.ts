// Session push decisions with injected session loader, token store, and sender
// (DI, no mock.module): which turn ends notify, who receives, preference
// filtering, the exact Spec §4 content, and sound / channel selection.
import { describe, expect, test } from 'bun:test';
import type { PushDeviceTokenRow } from './device-tokens';
import type { ExpoPushMessage } from './expo-push';
import {
  buildSessionPushMessages,
  closedTurnPushType,
  createSessionNotifier,
  notifyClosedTurn,
  truncateQuestion,
  turnEndPushType,
  type SessionPushDeps,
  type SessionPushTarget,
} from './session-push';

const USER = '00000000-0000-4000-8000-00000000000a';
const PROJECT = '00000000-0000-4000-8000-000000000001';
const SESSION = 'session-synthetic-1';

function row(token: string, overrides: Partial<PushDeviceTokenRow> = {}): PushDeviceTokenRow {
  const now = new Date(0);
  return {
    token,
    userId: USER,
    platform: 'ios',
    provider: 'expo',
    enabled: true,
    onCompletion: true,
    onError: true,
    onQuestion: true,
    onPermission: true,
    playSound: true,
    authSessionId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function harness(opts: {
  session?: SessionPushTarget | null;
  rows?: PushDeviceTokenRow[];
  enabled?: boolean;
  isPresent?: SessionPushDeps['isPresent'];
  mayReceive?: SessionPushDeps['mayReceive'];
  send?: SessionPushDeps['send'];
}) {
  const sent: ExpoPushMessage[][] = [];
  const listed: string[] = [];
  const warnings: unknown[][] = [];
  const infos: unknown[][] = [];
  const deps: SessionPushDeps = {
    enabled: opts.enabled ?? true,
    isPresent: opts.isPresent,
    mayReceive: opts.mayReceive,
    logger: { warn: (...args: unknown[]) => void warnings.push(args), info: (...args: unknown[]) => void infos.push(args) },
    loadSession: async () => (opts.session === undefined ? { createdBy: USER, title: 'Fix the build' } : opts.session),
    store: {
      async listByUser(userId) {
        listed.push(userId);
        return opts.rows ?? [row('ExponentPushToken[a]')];
      },
      async deleteTokens(tokens) {
        return tokens.length;
      },
    },
    send:
      opts.send ??
      (async (messages) => {
        sent.push(messages);
        return { tickets: [], removedTokens: [], failedMessages: 0 };
      }),
  };
  return { notify: createSessionNotifier(deps), sent, listed, warnings, infos };
}

describe('turnEndPushType — only a turn this call closed notifies', () => {
  test('closed + idle → completion', () => {
    expect(turnEndPushType({ outcome: 'closed', status: 'idle' })).toBe('completion');
  });
  test('closed + error → error', () => {
    expect(turnEndPushType({ outcome: 'closed', status: 'error', errorName: 'APIError' })).toBe('error');
    expect(turnEndPushType({ outcome: 'closed', status: 'error' })).toBe('error');
  });
  test('a user abort sends nothing', () => {
    expect(turnEndPushType({ outcome: 'closed', status: 'error', errorName: 'MessageAbortedError' })).toBeNull();
    expect(turnEndPushType({ outcome: 'closed', status: 'error', errorName: 'AbortError' })).toBeNull();
  });
  test('replays, duplicates, mismatches, and retries send nothing', () => {
    for (const outcome of ['already_closed', 'identity_mismatch', 'no_active_turn', 'non_terminal'] as const) {
      expect(turnEndPushType({ outcome, status: 'idle' })).toBeNull();
      expect(turnEndPushType({ outcome, status: 'error', errorName: 'APIError' })).toBeNull();
    }
  });
  test('an idle end that promoted a queued prompt is not a completion', () => {
    expect(turnEndPushType({ outcome: 'closed', status: 'idle', promoted: true })).toBeNull();
    expect(turnEndPushType({ outcome: 'closed', status: 'idle', promoted: false })).toBe('completion');
  });
  test('an error end still notifies when a queued prompt was promoted', () => {
    expect(turnEndPushType({ outcome: 'closed', status: 'error', errorName: 'APIError', promoted: true })).toBe(
      'error',
    );
  });
  test('a coordinator-spawned child session sends nothing', () => {
    expect(turnEndPushType({ outcome: 'closed', status: 'idle', childSession: true })).toBeNull();
  });
});

describe('closedTurnPushType — a turn the control plane closed', () => {
  test('completed is a completion, failed is an error', () => {
    expect(closedTurnPushType({ reason: 'completed' })).toBe('completion');
    expect(closedTurnPushType({ reason: 'failed' })).toBe('error');
  });
  test('a promoted queued prompt cancels the completion, never the error', () => {
    expect(closedTurnPushType({ reason: 'completed', promoted: true })).toBeNull();
    expect(closedTurnPushType({ reason: 'failed', promoted: true })).toBe('error');
  });
  test('a child session never notifies', () => {
    expect(closedTurnPushType({ reason: 'completed', childSession: true })).toBeNull();
    expect(closedTurnPushType({ reason: 'failed', childSession: true })).toBeNull();
  });
  test('every other end reason sends nothing', () => {
    for (const reason of ['abandoned', 'runtime_gone', 'unknown'] as const) {
      expect(closedTurnPushType({ reason })).toBeNull();
    }
  });
});

describe('notifyClosedTurn', () => {
  function harness(session: { projectId: string; childSession: boolean } | null | Error) {
    const loads: string[] = [];
    const events: unknown[] = [];
    const deps = {
      loadSession: async (sessionId: string) => {
        loads.push(sessionId);
        if (session instanceof Error) throw session;
        return session;
      },
      notify: async (event: unknown) => {
        events.push(event);
        return { sent: 1, reason: 'sent' as const, result: { tickets: [], invalidTokens: [] } as never };
      },
    };
    return { loads, events, deps };
  }

  test('a completed turn notifies the session project once', async () => {
    const h = harness({ projectId: PROJECT, childSession: false });
    await notifyClosedTurn({ sessionId: SESSION, reason: 'completed' }, h.deps);
    expect(h.events).toEqual([{ type: 'completion', sessionId: SESSION, projectId: PROJECT }]);
  });
  test('a failed turn sends an error even when a prompt was promoted', async () => {
    const h = harness({ projectId: PROJECT, childSession: false });
    await notifyClosedTurn({ sessionId: SESSION, reason: 'failed', promoted: true }, h.deps);
    expect(h.events).toEqual([{ type: 'error', sessionId: SESSION, projectId: PROJECT }]);
  });
  test('a child session sends nothing', async () => {
    const h = harness({ projectId: PROJECT, childSession: true });
    await notifyClosedTurn({ sessionId: SESSION, reason: 'completed' }, h.deps);
    expect(h.events).toEqual([]);
  });
  test('a missing session sends nothing', async () => {
    const h = harness(null);
    await notifyClosedTurn({ sessionId: SESSION, reason: 'failed' }, h.deps);
    expect(h.events).toEqual([]);
  });
  test('no push type skips the session read', async () => {
    const h = harness({ projectId: PROJECT, childSession: false });
    await notifyClosedTurn({ sessionId: SESSION, reason: 'completed', promoted: true }, h.deps);
    await notifyClosedTurn({ sessionId: SESSION, reason: 'unknown' }, h.deps);
    expect(h.loads).toEqual([]);
    expect(h.events).toEqual([]);
  });
  test('a failed session read never throws', async () => {
    const h = harness(new Error('db down'));
    await notifyClosedTurn({ sessionId: SESSION, reason: 'completed' }, h.deps);
    expect(h.events).toEqual([]);
  });
});

describe('content (Spec §4)', () => {
  test('completion', () => {
    const [m] = buildSessionPushMessages(
      { type: 'completion', sessionId: SESSION, projectId: PROJECT },
      'Fix the build',
      [row('ExponentPushToken[a]')],
    );
    expect(m).toEqual({
      to: 'ExponentPushToken[a]',
      title: 'Fix the build',
      body: 'Session complete. Tap to see the result.',
      data: { type: 'completion', projectId: PROJECT, sessionId: SESSION },
      sound: 'kortix_complete.wav',
      channelId: 'session-complete',
      priority: 'high',
    });
  });

  test('error', () => {
    const [m] = buildSessionPushMessages({ type: 'error', sessionId: SESSION, projectId: PROJECT }, 'T', [row('t')]);
    expect(m).toMatchObject({
      body: 'The session stopped with an error.',
      sound: 'kortix_error.wav',
      channelId: 'session-error',
      data: { type: 'error', projectId: PROJECT, sessionId: SESSION },
    });
  });

  test('question', () => {
    const [m] = buildSessionPushMessages(
      { type: 'question', sessionId: SESSION, projectId: PROJECT, question: 'Which branch should I deploy?' },
      'T',
      [row('t')],
    );
    expect(m).toMatchObject({
      body: 'Kortix has a question: Which branch should I deploy?',
      sound: 'kortix_attention.wav',
      channelId: 'session-attention',
    });
  });

  test('permission', () => {
    const [m] = buildSessionPushMessages({ type: 'permission', sessionId: SESSION, projectId: PROJECT }, 'T', [row('t')]);
    expect(m).toMatchObject({
      body: 'Kortix needs your approval to continue.',
      sound: 'kortix_attention.wav',
      channelId: 'session-attention',
    });
  });

  test('title falls back to "Kortix" when the session has no title', () => {
    for (const title of [null, '', '   ']) {
      const [m] = buildSessionPushMessages({ type: 'completion', sessionId: SESSION, projectId: PROJECT }, title, [row('t')]);
      expect(m!.title).toBe('Kortix');
    }
  });

  test('the question text is cut to 140 characters', () => {
    const long = 'x'.repeat(300);
    const cut = truncateQuestion(long);
    expect([...cut]).toHaveLength(140);
    expect(cut.endsWith('…')).toBe(true);
    expect(truncateQuestion('x'.repeat(140))).toBe('x'.repeat(140));
    expect(truncateQuestion('  two\n\nlines  ')).toBe('two lines');
  });

  test('play_sound false → no sound, silent channel', () => {
    for (const type of ['completion', 'error', 'question', 'permission'] as const) {
      const [m] = buildSessionPushMessages({ type, sessionId: SESSION, projectId: PROJECT, question: 'q' }, 'T', [
        row('t', { playSound: false }),
      ]);
      expect(m).toMatchObject({ sound: null, channelId: 'session-silent', priority: 'high' });
    }
  });
});

describe('preference filtering', () => {
  const rows = [
    row('all-on'),
    row('disabled', { enabled: false }),
    row('no-completion', { onCompletion: false }),
    row('no-error', { onError: false }),
    row('no-question', { onQuestion: false }),
    row('no-permission', { onPermission: false }),
  ];
  const tokensFor = (type: 'completion' | 'error' | 'question' | 'permission') =>
    buildSessionPushMessages({ type, sessionId: SESSION, projectId: PROJECT, question: 'q' }, 'T', rows).map(
      (m) => m.to,
    );

  test('each event type honors its own switch and the master switch', () => {
    expect(tokensFor('completion')).toEqual(['all-on', 'no-error', 'no-question', 'no-permission']);
    expect(tokensFor('error')).toEqual(['all-on', 'no-completion', 'no-question', 'no-permission']);
    expect(tokensFor('question')).toEqual(['all-on', 'no-completion', 'no-error', 'no-permission']);
    expect(tokensFor('permission')).toEqual(['all-on', 'no-completion', 'no-error', 'no-question']);
  });
});

describe('createSessionNotifier', () => {
  const event = { type: 'completion' as const, sessionId: SESSION, projectId: PROJECT };

  test('suppresses only the present creator session', async () => {
    const h = harness({ isPresent: async (user, session) => user === USER && session === SESSION });
    expect(await h.notify(event)).toEqual({ sent: 0, reason: 'present' });
    expect(h.sent).toHaveLength(0);
    expect(h.listed).toHaveLength(0);
  });

  test('sends to every allowed device of the session creator', async () => {
    const h = harness({ rows: [row('a'), row('b', { platform: 'android', playSound: false })] });
    const outcome = await h.notify(event);
    expect(outcome.reason).toBe('sent');
    expect(outcome.sent).toBe(2);
    expect(h.listed).toEqual([USER]);
    expect(h.sent[0]!.map((m) => [m.to, m.channelId])).toEqual([
      ['a', 'session-complete'],
      ['b', 'session-silent'],
    ]);
  });

  test('recipients replace the creator: each present one is skipped', async () => {
    const h = harness({ isPresent: async (user) => user === 'user-present' });
    const outcome = await h.notify({ type: 'question', sessionId: SESSION, projectId: PROJECT, question: 'Which region?', recipients: ['user-a', 'user-present'] });
    expect(outcome.reason).toBe('sent');
    expect(h.listed).toEqual(['user-a']);
    expect(h.sent[0]![0]!.body).toBe('Kortix has a question: Which region?');
  });

  // KRTX-1722: removal stopped the sign-in, and the removed member's phone
  // kept getting the session titles and questions of teammates' turns.
  test('a recipient who left the account gets nothing; the others still do', async () => {
    const h = harness({ mayReceive: async (user) => user !== 'user-left' });
    const outcome = await h.notify({ ...event, recipients: ['user-a', 'user-left'] });
    expect(outcome.reason).toBe('sent');
    expect(h.listed).toEqual(['user-a']);
  });

  test('a creator who left the account → no push, reason no_access', async () => {
    const h = harness({ mayReceive: async () => false });
    expect(await h.notify(event)).toEqual({ sent: 0, reason: 'no_access' });
    expect(h.listed).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });

  test('every recipient present → no push', async () => {
    const h = harness({ isPresent: async () => true });
    expect(await h.notify({ ...event, recipients: ['user-a', 'user-b'] })).toEqual({ sent: 0, reason: 'present' });
  });

  test('kill switch: nothing is loaded or sent', async () => {
    const h = harness({ enabled: false });
    expect(await h.notify(event)).toEqual({ sent: 0, reason: 'disabled' });
    expect(h.listed).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  test('no created_by → no push', async () => {
    const h = harness({ session: { createdBy: null, title: 'T' } });
    expect(await h.notify(event)).toEqual({ sent: 0, reason: 'no_recipient' });
    expect(h.sent).toEqual([]);
  });

  test('unknown session → no push', async () => {
    const h = harness({ session: null });
    expect(await h.notify(event)).toEqual({ sent: 0, reason: 'no_session' });
  });

  test('every device opted out → no request', async () => {
    const h = harness({ rows: [row('a', { onCompletion: false })] });
    expect(await h.notify(event)).toEqual({ sent: 0, reason: 'no_devices' });
    expect(h.sent).toEqual([]);
  });

  test('a failing dependency never throws to the caller', async () => {
    const h = harness({
      send: async () => {
        throw new Error('boom');
      },
    });
    expect(await h.notify(event)).toEqual({ sent: 0, reason: 'failed' });
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]![1]).toMatchObject({ type: 'completion', sessionId: SESSION, reason: 'failed', sent: 0 });
    expect(h.infos).toHaveLength(0);
  });

  test('logs one info line per call with type, sessionId, reason and sent', async () => {
    const h = harness({ rows: [row('a'), row('b')] });
    await h.notify({ ...event, type: 'question', question: 'secret question text' });
    expect(h.infos).toEqual([['[push] session event', { type: 'question', sessionId: SESSION, reason: 'sent', sent: 2 }]]);
    expect(JSON.stringify(h.infos)).not.toContain('secret question text');
    const p = harness({ isPresent: async () => true });
    await p.notify(event);
    expect(p.infos).toEqual([['[push] session event', { type: 'completion', sessionId: SESSION, reason: 'present', sent: 0 }]]);
    expect(p.warnings).toHaveLength(0);
  });
});
