// Session events (KRTX-1742 design §3.1) with injected collaborators (DI, no
// mock.module): which turn ends notify, who is told for each origin class and
// kind, mutes, the access filter, the inbox row's text and dedupe key, the
// Expo copy of the 4 session kinds, and the notification_center flag routing
// (off: the pre-KRTX-1742 push, session-push-legacy.ts). The real queries run
// in the DB suites (__tests__/integration-notification-recipients.test.ts,
// __tests__/integration-session-push-recipients.test.ts).
import { describe, expect, test } from 'bun:test';
import type { SessionAccessRow } from './access';
import type { PushDeviceTokenRow } from './device-tokens';
import type { ExpoPushMessage } from './expo-push';
import type { DeliverInput } from './notifier';
import { buildExpoMessages, buildPushContent, opensRemindersPage } from './push-payload';
import {
  createSessionNotifier,
  notifySessionEvent,
  sessionEventAudience,
  turnEndPushType,
  type SessionPushEvent,
} from './session-push';
import type { LegacySessionPushDeps } from './session-push-legacy';
import type { SessionWatchers } from './watchers';

const PROJECT = '00000000-0000-4000-8000-000000000001';
const ACCOUNT = '00000000-0000-4000-8000-000000000002';
const SESSION = 'session-synthetic-1';
const CREATOR = 'user-creator';
const PROMPTER = 'user-prompter';
const WATCHER = 'user-watcher';

const watchers = (watching: string[] = [CREATOR], muted: string[] = []): SessionWatchers => ({
  watching,
  muted: new Set(muted),
});

const event = (overrides: Partial<SessionPushEvent> = {}): SessionPushEvent => ({
  type: 'completion',
  sessionId: SESSION,
  projectId: PROJECT,
  prompterUserId: PROMPTER,
  ...overrides,
});

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
    expect(turnEndPushType({ outcome: 'closed', status: 'error', errorName: 'APIError', promoted: true })).toBe('error');
  });
  test('a coordinator-spawned child session sends nothing', () => {
    expect(turnEndPushType({ outcome: 'closed', status: 'idle', childSession: true })).toBeNull();
  });
});

describe('sessionEventAudience — who is told (design §3.1)', () => {
  const sorted = (ids: string[]) => [...ids].sort();

  test('attended turn end: the prompter and every watcher, with push', () => {
    for (const type of ['completion', 'error'] as const) {
      const out = sessionEventAudience(event({ type }), watchers([CREATOR, WATCHER]));
      expect(sorted(out.recipients)).toEqual(sorted([PROMPTER, CREATOR, WATCHER]));
      expect(out.pushAllowed).toBe(true);
    }
  });

  test('channel turn end: the prompter only, inbox row only (the thread carried it)', () => {
    const out = sessionEventAudience(event({ originClass: 'channel' }), watchers([CREATOR, WATCHER]));
    expect(out).toEqual({ recipients: [PROMPTER], pushAllowed: false });
  });

  test('channel turn end with no person prompter: nobody (not the owner stand-in)', () => {
    const out = sessionEventAudience(event({ originClass: 'channel', prompterUserId: null }), watchers());
    expect(out.recipients).toEqual([]);
  });

  test('unattended turn end: the prompter only, with push (run failures are automation alerts)', () => {
    const out = sessionEventAudience(
      event({ type: 'error', originClass: 'unattended', triggerWatcherIds: [WATCHER] }),
      watchers([CREATOR]),
    );
    expect(out).toEqual({ recipients: [PROMPTER], pushAllowed: true });
  });

  test('a child session turn end tells nobody', () => {
    expect(sessionEventAudience(event({ isChild: true }), watchers()).recipients).toEqual([]);
  });

  test('attended and child asks: the prompter and every watcher (the creator launched the child)', () => {
    for (const type of ['question', 'permission'] as const) {
      for (const isChild of [false, true]) {
        const out = sessionEventAudience(event({ type, isChild }), watchers([CREATOR]));
        expect(sorted(out.recipients)).toEqual(sorted([PROMPTER, CREATOR]));
        expect(out.pushAllowed).toBe(true);
      }
    }
  });

  test('channel ask the thread could not carry: the prompter and every watcher, with push', () => {
    for (const type of ['question', 'permission'] as const) {
      const out = sessionEventAudience(event({ type, originClass: 'channel', prompterUserId: null }), watchers([CREATOR]));
      expect(out).toEqual({ recipients: [CREATOR], pushAllowed: true });
    }
  });

  test('channel question the thread posted: the prompter only, inbox row only', () => {
    const out = sessionEventAudience(
      event({ type: 'question', originClass: 'channel', threadCarriesAsk: true }),
      watchers([CREATOR]),
    );
    expect(out).toEqual({ recipients: [PROMPTER], pushAllowed: false });
  });

  test('unattended ask: the prompter and the trigger watchers, not the session watchers', () => {
    const out = sessionEventAudience(
      event({ type: 'question', originClass: 'unattended', triggerWatcherIds: [WATCHER] }),
      watchers([CREATOR]),
    );
    expect(sorted(out.recipients)).toEqual(sorted([PROMPTER, WATCHER]));
    expect(out.pushAllowed).toBe(true);
  });

  test('a muted user is removed: creator, prompter, trigger watcher, explicit recipient', () => {
    expect(sessionEventAudience(event(), watchers([], [CREATOR])).recipients).toEqual([PROMPTER]);
    expect(sessionEventAudience(event(), watchers([CREATOR], [PROMPTER])).recipients).toEqual([CREATOR]);
    expect(
      sessionEventAudience(
        event({ type: 'permission', originClass: 'unattended', triggerWatcherIds: [WATCHER] }),
        watchers([], [WATCHER]),
      ).recipients,
    ).toEqual([PROMPTER]);
    expect(sessionEventAudience(event({ recipients: [CREATOR, WATCHER] }), watchers([], [WATCHER])).recipients).toEqual([CREATOR]);
  });

  test('explicit recipients replace the computed set', () => {
    const out = sessionEventAudience(event({ type: 'error', originClass: 'unattended', recipients: [WATCHER] }), watchers());
    expect(out).toEqual({ recipients: [WATCHER], pushAllowed: true });
  });

  test('duplicates collapse; no prompter adds nobody', () => {
    const out = sessionEventAudience(event({ prompterUserId: CREATOR }), watchers([CREATOR]));
    expect(out.recipients).toEqual([CREATOR]);
    expect(sessionEventAudience(event({ prompterUserId: null }), watchers([])).recipients).toEqual([]);
  });
});

function deviceRow(userId: string, token: string, overrides: Partial<PushDeviceTokenRow> = {}): PushDeviceTokenRow {
  const now = new Date(0);
  return {
    token,
    userId,
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

function sessionRow(overrides: Partial<SessionAccessRow> = {}): SessionAccessRow {
  return {
    sessionId: SESSION,
    accountId: ACCOUNT,
    projectId: PROJECT,
    createdBy: CREATOR,
    visibility: 'project',
    metadata: { name: 'Fix the build' },
    origin: 'user',
    initiatorType: 'member',
    ...overrides,
  };
}

function harness(opts: {
  session?: SessionAccessRow | null;
  watching?: SessionWatchers;
  mayOpen?: (userId: string) => boolean;
  /** Whether the id is a member of the account; default yes. */
  isPerson?: (userId: string) => boolean;
  failDeliver?: boolean;
} = {}) {
  const delivered: DeliverInput[] = [];
  const warnings: unknown[][] = [];
  const notify = createSessionNotifier({
    loadSession: async () => (opts.session === undefined ? sessionRow() : opts.session),
    watchers: async () => opts.watching ?? watchers(),
    mayOpen: async (_session, userIds) => userIds.filter((id) => opts.mayOpen?.(id) ?? true),
    personsAmong: async (_accountId, ids) => ids.filter((id) => opts.isPerson?.(id) ?? true),
    deliver: async (input) => {
      if (opts.failDeliver) throw new Error('db down');
      delivered.push(input);
      return [];
    },
    logger: { warn: (...args: unknown[]) => void warnings.push(args) },
  });
  return { notify, delivered, warnings };
}

describe('createSessionNotifier', () => {
  test('a turn end becomes one turn_done delivery, deduped per turn', async () => {
    const h = harness();
    const outcome = await h.notify(event({ turnMessageId: 'msg_1' }));
    expect(outcome).toEqual({ reason: 'delivered', recipients: [PROMPTER, CREATOR] });
    expect(h.delivered).toEqual([
      {
        kind: 'turn_done',
        accountId: ACCOUNT,
        projectId: PROJECT,
        sessionId: SESSION,
        title: 'Fix the build',
        body: '',
        actorUserId: PROMPTER,
        dedupeKey: `turn:${SESSION}:msg_1`,
        recipients: [PROMPTER, CREATOR],
        pushAllowed: true,
      },
    ]);
  });

  test('the custom name wins over the generated title; no title stays empty', async () => {
    const named = harness({ session: sessionRow({ metadata: { name: 'Generated', custom_name: 'Mine' } }) });
    await named.notify(event());
    expect(named.delivered[0]!.title).toBe('Mine');
    const untitled = harness({ session: sessionRow({ metadata: {} }) });
    await untitled.notify(event());
    expect(untitled.delivered[0]!.title).toBe('');
  });

  test('an error carries its message; a turn end with no message id has no dedupe key', async () => {
    const h = harness();
    await h.notify(event({ type: 'error', errorMessage: '  Payment Required:\n Insufficient credits.  ' }));
    expect(h.delivered[0]).toMatchObject({
      kind: 'turn_error',
      body: 'Payment Required: Insufficient credits.',
      dedupeKey: null,
    });
  });

  test('a question carries its text, cut to 140 characters, deduped per request', async () => {
    const h = harness();
    await h.notify(event({ type: 'question', question: 'x'.repeat(300), requestId: 'que_1' }));
    const body = h.delivered[0]!.body!;
    expect([...body]).toHaveLength(140);
    expect(body.endsWith('…')).toBe(true);
    expect(h.delivered[0]).toMatchObject({ kind: 'question', dedupeKey: `question:${SESSION}:que_1` });
  });

  test('a permission is deduped per request', async () => {
    const h = harness();
    await h.notify(event({ type: 'permission', requestId: 'per_1' }));
    expect(h.delivered[0]).toMatchObject({ kind: 'permission', body: '', dedupeKey: `permission:${SESSION}:per_1` });
  });

  test('a channel turn end is delivered as an inbox row without push', async () => {
    const h = harness();
    await h.notify(event({ originClass: 'channel' }));
    expect(h.delivered[0]).toMatchObject({ recipients: [PROMPTER], pushAllowed: false });
  });

  test('a recipient who may not open the session is dropped; the others are still told', async () => {
    const h = harness({ mayOpen: (id) => id !== CREATOR });
    expect(await h.notify(event())).toEqual({ reason: 'delivered', recipients: [PROMPTER] });
  });

  // KRTX-1742 review: a backend's service account prompted, and the row named it.
  test('a prompter who is not a person (a service account) is not named the actor', async () => {
    const SERVICE_ACCOUNT = 'sa-backend';
    const h = harness({ isPerson: (id) => id !== SERVICE_ACCOUNT });
    await h.notify(event({ prompterUserId: SERVICE_ACCOUNT }));
    expect(h.delivered[0]!.actorUserId).toBeNull();

    const muted = harness({ watching: watchers([CREATOR], [PROMPTER]) });
    await muted.notify(event());
    // A muted person prompter is still the actor of the rows the others get.
    expect(muted.delivered[0]).toMatchObject({ actorUserId: PROMPTER, recipients: [CREATOR] });
  });

  test('nobody may open it → no delivery, reason no_access', async () => {
    const h = harness({ mayOpen: () => false });
    expect(await h.notify(event())).toEqual({ reason: 'no_access', recipients: [] });
    expect(h.delivered).toEqual([]);
  });

  test('nobody to tell → no delivery, reason no_recipient', async () => {
    const h = harness({ watching: watchers([]) });
    expect(await h.notify(event({ prompterUserId: null }))).toEqual({ reason: 'no_recipient', recipients: [] });
    expect(h.delivered).toEqual([]);
  });

  test('unknown session, or a session of another project → no delivery', async () => {
    expect(await harness({ session: null }).notify(event())).toEqual({ reason: 'no_session', recipients: [] });
    const other = harness({ session: sessionRow({ projectId: '00000000-0000-4000-8000-0000000000ff' }) });
    expect(await other.notify(event())).toEqual({ reason: 'no_session', recipients: [] });
    expect(other.delivered).toEqual([]);
  });

  test('a failing dependency never throws to the caller', async () => {
    const h = harness({ failDeliver: true });
    expect(await h.notify(event())).toEqual({ reason: 'failed', recipients: [] });
    expect(h.warnings).toHaveLength(1);
  });

  test('the recipient context is resolved inside the notifier; its fields override the event`s', async () => {
    const h = harness();
    let resolved = 0;
    const context = async () => {
      resolved += 1;
      return { prompterUserId: WATCHER, originClass: 'attended' as const, isChild: false };
    };
    const outcome = await h.notify(event({ prompterUserId: null, turnMessageId: 'msg_1' }), context);
    expect(resolved).toBe(1);
    expect(outcome).toEqual({ reason: 'delivered', recipients: [WATCHER, CREATOR] });
    expect(h.delivered[0]).toMatchObject({ actorUserId: WATCHER, dedupeKey: `turn:${SESSION}:msg_1` });
  });

  test('a failing context lookup never throws to the caller', async () => {
    const h = harness();
    const outcome = await h.notify(event(), async () => {
      throw new Error('db down');
    });
    expect(outcome).toEqual({ reason: 'failed', recipients: [] });
    expect(h.delivered).toEqual([]);
    expect(h.warnings).toHaveLength(1);
  });
});

// KRTX-1742 is behind the project's notification_center flag, off by default.
// Off, notifySessionEvent sends the pre-KRTX-1742 push: the creator's phones,
// no context lookup, no inbox row. The flag read itself runs in the DB suites.
describe('notifySessionEvent with the notification_center flag off', () => {
  function legacy(overrides: Partial<LegacySessionPushDeps> = {}) {
    const loaded: Array<[string, string]> = [];
    const listed: string[] = [];
    const sent: ExpoPushMessage[] = [];
    const deps: Partial<LegacySessionPushDeps> = {
      enabled: true,
      loadSession: async (sessionId, projectId) => {
        loaded.push([sessionId, projectId]);
        return { createdBy: CREATOR, title: 'Fix the build', accountId: ACCOUNT, projectId };
      },
      mayReceive: async () => true,
      isPresent: async () => false,
      store: {
        listByUser: async (userId) => {
          listed.push(userId);
          return [deviceRow(userId, `ExponentPushToken[${userId === CREATOR ? 'creator' : userId}]`)];
        },
        deleteTokens: async (tokens) => tokens.length,
      },
      send: async (messages) => {
        sent.push(...messages);
        return { tickets: [], removedTokens: [], failedMessages: 0 };
      },
      ...overrides,
    };
    return { deps, loaded, listed, sent };
  }
  const unresolved = async () => {
    throw new Error('the context must not be resolved with the flag off');
  };

  test('a turn end pushes only the creator`s phones, with the pre-KRTX-1742 payload', async () => {
    const h = legacy();
    const outcome = await notifySessionEvent(
      event({ type: 'error', turnMessageId: 'msg_1', errorMessage: 'Payment Required' }),
      { notificationCenter: false, context: unresolved, legacyDeps: h.deps },
    );
    expect(outcome).toMatchObject({ sent: 1, reason: 'sent' });
    expect(h.loaded).toEqual([[SESSION, PROJECT]]);
    expect(h.listed).toEqual([CREATOR]);
    expect(h.sent).toEqual([
      {
        to: 'ExponentPushToken[creator]',
        title: 'Fix the build',
        body: 'The session stopped with an error.',
        data: { type: 'error', projectId: PROJECT, sessionId: SESSION },
        sound: 'kortix_error.wav',
        channelId: 'session-error',
        priority: 'high',
      },
    ]);
  });

  test('a question carries its text; a permission its fixed line', async () => {
    const question = legacy();
    await notifySessionEvent(event({ type: 'question', question: 'Which region?', requestId: 'que_1' }), {
      notificationCenter: false,
      legacyDeps: question.deps,
    });
    expect(question.sent.map((m) => [m.body, m.data])).toEqual([
      ['Kortix has a question: Which region?', { type: 'question', projectId: PROJECT, sessionId: SESSION }],
    ]);
    const permission = legacy();
    await notifySessionEvent(event({ type: 'permission', requestId: 'per_1' }), {
      notificationCenter: false,
      legacyDeps: permission.deps,
    });
    expect(permission.sent.map((m) => m.body)).toEqual(['Kortix needs your approval to continue.']);
  });

  test('any live tab of the creator holds the push back, alerting or not', async () => {
    const h = legacy({ isPresent: async (userId) => userId === CREATOR });
    expect(await notifySessionEvent(event(), { notificationCenter: false, legacyDeps: h.deps })).toEqual({
      sent: 0,
      reason: 'present',
    });
    expect(h.sent).toEqual([]);
  });

  test('explicit recipients replace the creator', async () => {
    const h = legacy();
    await notifySessionEvent(event({ recipients: [WATCHER] }), { notificationCenter: false, legacyDeps: h.deps });
    expect(h.listed).toEqual([WATCHER]);
  });

  test('the kill switch stops everything, before any read', async () => {
    const h = legacy({ enabled: false });
    expect(await notifySessionEvent(event(), { notificationCenter: false, context: unresolved, legacyDeps: h.deps })).toEqual({
      sent: 0,
      reason: 'disabled',
    });
    expect(h.loaded).toEqual([]);
    expect(h.sent).toEqual([]);
  });
});

// The Expo copy of the 4 session kinds is unchanged by KRTX-1742: an installed
// app keeps showing the same text and routing on the same `type`.
describe('Expo copy of the session kinds (Spec §4)', () => {
  const device = (token: string, overrides: Partial<PushDeviceTokenRow> = {}) => deviceRow(CREATOR, token, overrides);
  const content = (kind: 'turn_done' | 'turn_error' | 'question' | 'permission', body = '') =>
    buildPushContent({ notificationId: 'n1', kind, title: 'Fix the build', body, projectId: PROJECT, sessionId: SESSION, triggerSlug: null });

  test('body, sound, channel and legacy type per kind', () => {
    const cases = [
      ['turn_done', '', 'Session complete. Tap to see the result.', 'kortix_complete.wav', 'session-complete', 'completion'],
      ['turn_error', 'boom', 'The session stopped with an error.', 'kortix_error.wav', 'session-error', 'error'],
      ['question', 'Which branch should I deploy?', 'Kortix has a question: Which branch should I deploy?', 'kortix_attention.wav', 'session-attention', 'question'],
      ['question', '', 'Kortix has a question.', 'kortix_attention.wav', 'session-attention', 'question'],
      ['permission', '', 'Kortix needs your approval to continue.', 'kortix_attention.wav', 'session-attention', 'permission'],
    ] as const;
    for (const [kind, detail, body, sound, channelId, type] of cases) {
      const [message] = buildExpoMessages(content(kind, detail), [device('t')]);
      expect(message).toMatchObject({ to: 't', title: 'Fix the build', body, sound, channelId, priority: 'high' });
      expect(message!.data).toMatchObject({ type, kind, projectId: PROJECT, sessionId: SESSION });
    }
  });

  test('play_sound false → no sound, silent channel', () => {
    for (const kind of ['turn_done', 'turn_error', 'question', 'permission'] as const) {
      const [message] = buildExpoMessages(content(kind, 'q'), [device('t', { playSound: false })]);
      expect(message).toMatchObject({ sound: null, channelId: 'session-silent', priority: 'high' });
    }
  });

  test('each kind honors its own device switch and the master switch', () => {
    const rows = [
      device('all-on'),
      device('disabled', { enabled: false }),
      device('no-completion', { onCompletion: false }),
      device('no-error', { onError: false }),
      device('no-question', { onQuestion: false }),
      device('no-permission', { onPermission: false }),
    ];
    const tokensFor = (kind: 'turn_done' | 'turn_error' | 'question' | 'permission') =>
      buildExpoMessages(content(kind, 'q'), rows).map((m) => m.to);
    expect(tokensFor('turn_done')).toEqual(['all-on', 'no-error', 'no-question', 'no-permission']);
    expect(tokensFor('turn_error')).toEqual(['all-on', 'no-completion', 'no-question', 'no-permission']);
    expect(tokensFor('question')).toEqual(['all-on', 'no-completion', 'no-error', 'no-permission']);
    expect(tokensFor('permission')).toEqual(['all-on', 'no-completion', 'no-error', 'no-question']);
  });

  test('title falls back to "Kortix" when the session has no title', () => {
    for (const title of ['', '   ']) {
      const pushed = buildPushContent({ notificationId: 'n1', kind: 'turn_done', title, body: '', projectId: PROJECT, sessionId: SESSION, triggerSlug: null });
      expect(pushed.title).toBe('Kortix');
    }
  });
});

// The Triggers page lists kortix.yaml triggers only. A reminder is a runtime
// row (`reminder.<hex>`), so its alert must open the Reminders page.
describe('the page an automation alert opens', () => {
  const alertUrl = (kind: 'automation_failed' | 'automation_recovered', triggerSlug: string) =>
    buildPushContent({ notificationId: 'n1', kind, title: 'Daily check', body: '', projectId: PROJECT, sessionId: null, triggerSlug }).payload.url;

  test('a reminder alert opens Reminders; a kortix.yaml trigger alert opens Triggers', () => {
    for (const kind of ['automation_failed', 'automation_recovered'] as const) {
      expect(alertUrl(kind, 'reminder.0a1b2c3d4e5f')).toBe(`/projects/${PROJECT}/reminders?notification=n1`);
      expect(alertUrl(kind, 'nightly-report')).toBe(`/projects/${PROJECT}/customize/triggers?notification=n1`);
    }
  });

  test('opensRemindersPage reads that url back, and only that one', () => {
    expect(opensRemindersPage(alertUrl('automation_failed', 'reminder.0a1b2c3d4e5f'))).toBe(true);
    expect(opensRemindersPage(alertUrl('automation_failed', 'nightly-report'))).toBe(false);
    expect(opensRemindersPage(`/projects/${PROJECT}/sessions/reminders?notification=n1`)).toBe(false);
  });
});
