import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_KINDS,
  effectiveNotificationPreferences,
  isAllowedWebPushHost,
  isNotificationKind,
  pushTypeOf,
} from './notification-kinds';

describe('notification kinds', () => {
  test('every kind has a default', () => {
    expect(Object.keys(DEFAULT_NOTIFICATION_PREFERENCES).sort()).toEqual([...NOTIFICATION_KINDS].sort());
  });

  test('session kinds keep the push type installed apps route on', () => {
    expect(pushTypeOf('turn_done')).toBe('completion');
    expect(pushTypeOf('turn_error')).toBe('error');
    expect(pushTypeOf('question')).toBe('question');
    expect(pushTypeOf('shared')).toBe('shared');
  });

  test('isNotificationKind accepts only the 7 kinds', () => {
    expect(isNotificationKind('shared')).toBe(true);
    expect(isNotificationKind('mention')).toBe(false);
    expect(isNotificationKind(1)).toBe(false);
  });
});

describe('effectiveNotificationPreferences', () => {
  test('missing or malformed records give the defaults', () => {
    expect(effectiveNotificationPreferences(undefined)).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    expect(effectiveNotificationPreferences({ kinds: 'x' })).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
  });

  test('overrides apply per channel and ignore non-booleans', () => {
    const prefs = effectiveNotificationPreferences({ kinds: { question: { email: false, push: 'no' } } });
    expect(prefs.question).toEqual({ push: true, email: false });
    expect(prefs.turn_done).toEqual(DEFAULT_NOTIFICATION_PREFERENCES.turn_done);
  });
});

describe('isAllowedWebPushHost', () => {
  test('known push services and their subdomains pass', () => {
    expect(isAllowedWebPushHost('fcm.googleapis.com')).toBe(true);
    expect(isAllowedWebPushHost('updates.push.services.mozilla.com')).toBe(true);
    expect(isAllowedWebPushHost('web.push.apple.com')).toBe(true);
    expect(isAllowedWebPushHost('wns2-par02p.notify.windows.com')).toBe(true);
  });

  test('anything else is refused, including look-alike suffixes', () => {
    expect(isAllowedWebPushHost('169.254.169.254')).toBe(false);
    expect(isAllowedWebPushHost('localhost')).toBe(false);
    expect(isAllowedWebPushHost('evilfcm.googleapis.com.attacker.test')).toBe(false);
    expect(isAllowedWebPushHost('notfcm.googleapis.com')).toBe(false);
  });
});
