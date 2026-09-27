import { describe, expect, test } from 'bun:test';

import {
  ANDROID_CHANNELS,
  deliveryForKind,
  notificationOpenMove,
  parsePushData,
  routeForNotification,
  serverPreferences,
  shouldPresentInForeground,
} from './push';

const DATA = { type: 'completion', projectId: 'proj-1', sessionId: 'sess-1' };

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
  test('maps each kind to its channel and iOS sound', () => {
    expect(deliveryForKind('completion', true)).toEqual({
      channelId: 'session-complete',
      iosSound: 'kortix_complete.wav',
    });
    expect(deliveryForKind('error', true)).toEqual({
      channelId: 'session-error',
      iosSound: 'kortix_error.wav',
    });
    expect(deliveryForKind('question', true)).toEqual({
      channelId: 'session-attention',
      iosSound: 'kortix_attention.wav',
    });
    expect(deliveryForKind('permission', true)).toEqual({
      channelId: 'session-attention',
      iosSound: 'kortix_attention.wav',
    });
  });

  test('sound off → silent channel, no iOS sound, for every kind', () => {
    for (const kind of ['completion', 'error', 'question', 'permission'] as const) {
      expect(deliveryForKind(kind, false)).toEqual({ channelId: 'session-silent', iosSound: null });
    }
  });

  test('every channel id it returns exists', () => {
    const ids = new Set(ANDROID_CHANNELS.map((c) => c.id));
    for (const kind of ['completion', 'error', 'question', 'permission'] as const) {
      expect(ids.has(deliveryForKind(kind, true).channelId)).toBe(true);
      expect(ids.has(deliveryForKind(kind, false).channelId)).toBe(true);
    }
  });
});

describe('parsePushData', () => {
  test('accepts the server payload', () => {
    expect(parsePushData(DATA)).toEqual({ type: 'completion', projectId: 'proj-1', sessionId: 'sess-1' });
  });

  test('drops extra fields', () => {
    expect(parsePushData({ ...DATA, extra: 1 })).toEqual({
      type: 'completion',
      projectId: 'proj-1',
      sessionId: 'sess-1',
    });
  });

  test('rejects anything else', () => {
    expect(parsePushData(null)).toBeNull();
    expect(parsePushData(undefined)).toBeNull();
    expect(parsePushData('completion')).toBeNull();
    expect(parsePushData({})).toBeNull();
    expect(parsePushData({ ...DATA, type: 'marketing' })).toBeNull();
    expect(parsePushData({ ...DATA, projectId: '' })).toBeNull();
    expect(parsePushData({ ...DATA, sessionId: '  ' })).toBeNull();
    expect(parsePushData({ ...DATA, sessionId: 42 })).toBeNull();
  });
});

describe('routeForNotification', () => {
  test('opens the project route and names the session to open', () => {
    const data = parsePushData({ ...DATA, type: 'question' })!;
    expect(routeForNotification(data)).toEqual({
      href: { pathname: '/projects/[id]', params: { id: 'proj-1' } },
      sessionId: 'sess-1',
    });
  });
});

describe('shouldPresentInForeground', () => {
  test('active and viewing that session → hidden', () => {
    expect(shouldPresentInForeground({ data: DATA, appActive: true, viewingSessionId: 'sess-1' })).toBe(false);
  });

  test('active and viewing another session or none → shown', () => {
    expect(shouldPresentInForeground({ data: DATA, appActive: true, viewingSessionId: 'sess-2' })).toBe(true);
    expect(shouldPresentInForeground({ data: DATA, appActive: true, viewingSessionId: null })).toBe(true);
  });

  test('not active → shown, even for the viewed session', () => {
    expect(shouldPresentInForeground({ data: DATA, appActive: false, viewingSessionId: 'sess-1' })).toBe(true);
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

describe('serverPreferences', () => {
  test('maps every field to snake_case', () => {
    expect(
      serverPreferences({
        enabled: true,
        onCompletion: false,
        onError: true,
        onQuestion: false,
        onPermission: true,
        playSound: false,
      })
    ).toEqual({
      enabled: true,
      on_completion: false,
      on_error: true,
      on_question: false,
      on_permission: true,
      play_sound: false,
    });
  });
});
