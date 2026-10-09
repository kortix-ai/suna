import { describe, expect, test } from 'bun:test';

import { INBOX_NOTIFICATION_KINDS } from '@kortix/sdk';
import {
  ANDROID_CHANNELS,
  deliveryForKind,
  legacyKindPatch,
  notificationOpenMove,
  parsePushData,
  serverPreferences,
  shouldPresentInForeground,
} from './push';

/** The payload of a server from before the inbox (KRTX-1742). */
const DATA = { type: 'completion', projectId: 'proj-1', sessionId: 'sess-1' };
/** The payload of a server with the inbox: `type` keeps the old name for installed apps. */
const INBOX_DATA = {
  notificationId: 'note-1',
  kind: 'turn_done',
  type: 'completion',
  projectId: 'proj-1',
  sessionId: 'sess-1',
  triggerSlug: null,
  url: '/projects/proj-1/sessions/sess-1?notification=note-1',
};
/** An automation alert: no session, the trigger's slug. */
const ALERT_DATA = {
  notificationId: 'note-2',
  kind: 'automation_failed',
  type: 'automation_failed',
  projectId: 'proj-1',
  sessionId: null,
  triggerSlug: 'nightly-report',
  url: '/projects/proj-1/customize/triggers?notification=note-2',
};

describe('ANDROID_CHANNELS', () => {
  test('are the four channels the server targets, with the bundled sounds', () => {
    expect(ANDROID_CHANNELS.map((c) => [c.id, c.sound])).toEqual([
      ['session-complete', 'kortix_complete.wav'],
      ['session-attention', 'kortix_attention.wav'],
      ['session-error', 'kortix_error.wav'],
      ['session-silent', null],
    ]);
  });

  test('sound files are valid Android resource names', () => {
    for (const c of ANDROID_CHANNELS) {
      if (c.sound) expect(c.sound).toMatch(/^[a-z0-9_]+\.wav$/);
    }
  });
});

describe('deliveryForKind', () => {
  test('maps each kind to the channel and iOS sound the server picks', () => {
    const complete = { channelId: 'session-complete', iosSound: 'kortix_complete.wav' };
    const attention = { channelId: 'session-attention', iosSound: 'kortix_attention.wav' };
    const error = { channelId: 'session-error', iosSound: 'kortix_error.wav' };
    expect(deliveryForKind('turn_done', true)).toEqual(complete);
    expect(deliveryForKind('automation_recovered', true)).toEqual(complete);
    expect(deliveryForKind('question', true)).toEqual(attention);
    expect(deliveryForKind('permission', true)).toEqual(attention);
    expect(deliveryForKind('shared', true)).toEqual(attention);
    expect(deliveryForKind('turn_error', true)).toEqual(error);
    expect(deliveryForKind('automation_failed', true)).toEqual(error);
  });

  test('sound off → silent channel, no iOS sound, for every kind', () => {
    for (const kind of INBOX_NOTIFICATION_KINDS) {
      expect(deliveryForKind(kind, false)).toEqual({ channelId: 'session-silent', iosSound: null });
    }
  });

  test('every kind uses an existing channel and sound: no kind needs a native build', () => {
    const ids = new Set(ANDROID_CHANNELS.map((c) => c.id));
    const sounds = new Set(ANDROID_CHANNELS.map((c) => c.sound));
    for (const kind of INBOX_NOTIFICATION_KINDS) {
      const delivery = deliveryForKind(kind, true);
      expect(ids.has(delivery.channelId)).toBe(true);
      expect(sounds.has(delivery.iosSound)).toBe(true);
      expect(ids.has(deliveryForKind(kind, false).channelId)).toBe(true);
    }
  });
});

describe('parsePushData', () => {
  test('accepts the inbox payload: kind, session and inbox row', () => {
    expect(parsePushData(INBOX_DATA)).toEqual({
      kind: 'turn_done',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      notificationId: 'note-1',
    });
  });

  test('accepts every inbox kind', () => {
    for (const kind of INBOX_NOTIFICATION_KINDS) {
      expect(parsePushData({ ...INBOX_DATA, kind, type: kind })?.kind).toBe(kind);
    }
  });

  test('an automation alert has no session: the tap opens the project', () => {
    expect(parsePushData(ALERT_DATA)).toEqual({
      kind: 'automation_failed',
      projectId: 'proj-1',
      sessionId: null,
      notificationId: 'note-2',
    });
  });

  test('a server from before the inbox: the legacy type names the kind, no inbox row', () => {
    expect(parsePushData(DATA)).toEqual({ kind: 'turn_done', projectId: 'proj-1', sessionId: 'sess-1', notificationId: null });
    expect(parsePushData({ ...DATA, type: 'error' })?.kind).toBe('turn_error');
    expect(parsePushData({ ...DATA, type: 'question' })?.kind).toBe('question');
    expect(parsePushData({ ...DATA, type: 'permission' })?.kind).toBe('permission');
  });

  test('a payload without `kind` is read from its type', () => {
    const { kind: _kind, ...withoutKind } = ALERT_DATA;
    expect(parsePushData(withoutKind)?.kind).toBe('automation_failed');
  });

  test('drops extra fields', () => {
    expect(parsePushData({ ...INBOX_DATA, extra: 1 })).toEqual(parsePushData(INBOX_DATA));
  });

  test('a blank or non-string session or inbox row id reads as none', () => {
    expect(parsePushData({ ...INBOX_DATA, sessionId: '  ' })?.sessionId).toBeNull();
    expect(parsePushData({ ...INBOX_DATA, sessionId: 42 })?.sessionId).toBeNull();
    expect(parsePushData({ ...INBOX_DATA, notificationId: '' })?.notificationId).toBeNull();
  });

  test('rejects anything else', () => {
    expect(parsePushData(null)).toBeNull();
    expect(parsePushData(undefined)).toBeNull();
    expect(parsePushData('completion')).toBeNull();
    expect(parsePushData({})).toBeNull();
    expect(parsePushData({ ...DATA, type: 'marketing' })).toBeNull();
    expect(parsePushData({ ...INBOX_DATA, kind: 'marketing', type: 'marketing' })).toBeNull();
    // An inherited property name is not a kind.
    expect(parsePushData({ ...DATA, type: 'constructor' })).toBeNull();
    expect(parsePushData({ ...DATA, projectId: '' })).toBeNull();
    expect(parsePushData({ ...ALERT_DATA, projectId: null })).toBeNull();
  });
});

describe('shouldPresentInForeground', () => {
  test('active and viewing that session → hidden', () => {
    expect(shouldPresentInForeground({ data: DATA, appActive: true, viewingSessionId: 'sess-1' })).toBe(false);
    expect(shouldPresentInForeground({ data: INBOX_DATA, appActive: true, viewingSessionId: 'sess-1' })).toBe(false);
  });

  test('active and viewing another session or none → shown', () => {
    expect(shouldPresentInForeground({ data: DATA, appActive: true, viewingSessionId: 'sess-2' })).toBe(true);
    expect(shouldPresentInForeground({ data: DATA, appActive: true, viewingSessionId: null })).toBe(true);
  });

  test('not active → shown, even for the viewed session', () => {
    expect(shouldPresentInForeground({ data: DATA, appActive: false, viewingSessionId: 'sess-1' })).toBe(true);
  });

  test('an alert without a session → shown', () => {
    expect(shouldPresentInForeground({ data: ALERT_DATA, appActive: true, viewingSessionId: null })).toBe(true);
  });

  test('a payload that is not a session push → shown', () => {
    expect(shouldPresentInForeground({ data: {}, appActive: true, viewingSessionId: 'sess-1' })).toBe(true);
  });
});

describe('notificationOpenMove', () => {
  const base = { signedIn: true, rootSegment: 'projects', currentProjectId: 'proj-1', targetProjectId: 'proj-1' };

  test('signed out → wait', () => {
    expect(notificationOpenMove({ ...base, signedIn: false })).toBe('wait');
  });

  test('boot, auth and first-run screens → wait', () => {
    for (const rootSegment of ['', 'index', 'auth', 'welcome', 'new']) {
      expect(notificationOpenMove({ ...base, rootSegment, currentProjectId: null })).toBe('wait');
    }
  });

  test('target project on top → none', () => {
    expect(notificationOpenMove(base)).toBe('none');
  });

  test('another project on top → replace-project', () => {
    expect(notificationOpenMove({ ...base, targetProjectId: 'proj-2' })).toBe('replace-project');
  });

  test('another screen on top → replace', () => {
    expect(notificationOpenMove({ ...base, rootSegment: '(settings)', currentProjectId: null })).toBe('replace');
    expect(notificationOpenMove({ ...base, rootSegment: 'projects', currentProjectId: null })).toBe('replace');
  });
});

describe('legacyKindPatch', () => {
  test('a kind this phone turned off before KRTX-1742 becomes push off in the user record', () => {
    expect(
      legacyKindPatch({ enabled: true, playSound: true, onCompletion: false, onError: true, onQuestion: false })
    ).toEqual({ kinds: { turn_done: { push: false }, question: { push: false } } });
    expect(legacyKindPatch({ enabled: true, playSound: true, onError: false, onPermission: false })).toEqual({
      kinds: { turn_error: { push: false }, permission: { push: false } },
    });
  });

  test('nothing turned off (every key on, or a fresh install with none) → null', () => {
    expect(
      legacyKindPatch({
        enabled: true,
        playSound: true,
        onCompletion: true,
        onError: true,
        onQuestion: true,
        onPermission: true,
      })
    ).toBeNull();
    expect(legacyKindPatch({ enabled: false, playSound: false })).toBeNull();
  });
});

describe('serverPreferences', () => {
  test("after the migration: this phone's switches; every per-kind column on, so the user's record decides", () => {
    expect(serverPreferences({ enabled: true, playSound: false }, true)).toEqual({
      enabled: true,
      on_completion: true,
      on_error: true,
      on_question: true,
      on_permission: true,
      play_sound: false,
    });
    expect(serverPreferences({ enabled: false, playSound: true, onCompletion: false }, true)).toEqual({
      enabled: false,
      on_completion: true,
      on_error: true,
      on_question: true,
      on_permission: true,
      play_sound: true,
    });
  });

  test('before the migration: the kinds this phone turned off stay off on its device row', () => {
    expect(
      serverPreferences({ enabled: true, playSound: true, onCompletion: false, onPermission: false }, false)
    ).toEqual({
      enabled: true,
      on_completion: false,
      on_error: true,
      on_question: true,
      on_permission: false,
      play_sound: true,
    });
    // A fresh install has no stored kinds: every column on.
    expect(serverPreferences({ enabled: true, playSound: true }, false)).toEqual({
      enabled: true,
      on_completion: true,
      on_error: true,
      on_question: true,
      on_permission: true,
      play_sound: true,
    });
  });
});
