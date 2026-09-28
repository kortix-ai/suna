// Session push decisions with injected session loader, token store, and sender
// (DI, no mock.module): which turn ends notify, who receives, preference
// filtering, the exact Spec §4 content, and sound / channel selection.
import { describe, expect, test } from 'bun:test';
import type { PushDeviceTokenRow } from './device-tokens';
import type { ExpoPushMessage } from './expo-push';
import {
  buildSessionPushMessages,
  createSessionNotifier,
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
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function harness(opts: {
  session?: SessionPushTarget | null;
  rows?: PushDeviceTokenRow[];
  enabled?: boolean;
  send?: SessionPushDeps['send'];
}) {
  const sent: ExpoPushMessage[][] = [];
  const listed: string[] = [];
  const warnings: unknown[][] = [];
  const deps: SessionPushDeps = {
    enabled: opts.enabled ?? true,
    logger: { warn: (...args: unknown[]) => void warnings.push(args) },
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
  return { notify: createSessionNotifier(deps), sent, listed, warnings };
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
  });
});
