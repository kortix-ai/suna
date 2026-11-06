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
    const prefs = effectiveNotificationPreferences({ kinds: { question: { email: true, push: 'no' } } });
    expect(prefs.question).toEqual({ push: true, email: true });
    expect(prefs.turn_done).toEqual(DEFAULT_NOTIFICATION_PREFERENCES.turn_done);
  });

  test('email is opt-in for the kinds only the notification center ever mailed', () => {
    // The inbox and push are on for everyone; these emails reach a person only
    // when they turn them on, so graduating the center mails nobody new.
    for (const kind of ['turn_done', 'turn_error', 'question', 'permission', 'shared', 'automation_recovered', 'capture_device_recovered'] as const) {
      expect(DEFAULT_NOTIFICATION_PREFERENCES[kind]).toEqual({ push: true, email: false });
    }
    // Mailed before the center was on by default (health and auto-pause alerts,
    // a capture computer that went down): still mailed.
    for (const kind of ['automation_failed', 'capture_device_down'] as const) {
      expect(DEFAULT_NOTIFICATION_PREFERENCES[kind]).toEqual({ push: true, email: true });
    }
  });

  test('a delivery may set the email default of its kind; a saved choice still wins', () => {
    const lowered = { automation_failed: { email: false } };
    expect(effectiveNotificationPreferences(undefined, lowered).automation_failed).toEqual({ push: true, email: false });
    expect(effectiveNotificationPreferences({ kinds: { automation_failed: { email: true } } }, lowered).automation_failed.email).toBe(true);
    expect(effectiveNotificationPreferences({ kinds: { question: { email: false } } }, { question: { email: true } }).question.email).toBe(false);
    // Other kinds keep their own defaults.
    expect(effectiveNotificationPreferences(undefined, lowered).capture_device_down.email).toBe(true);
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
