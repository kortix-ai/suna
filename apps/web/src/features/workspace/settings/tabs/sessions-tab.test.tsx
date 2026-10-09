import { describe, expect, test } from 'bun:test';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '@kortix/sdk';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionsTabView, type SessionsTabCopy } from './sessions-tab';

const headings = (html: string): string[] =>
  [...html.matchAll(/<(h[23])[^>]*>([^<]*)<\/\1>/g)].map((m) => `${m[1]}:${m[2]}`);

/** The tab as a project with the `notification_center` flag off sees it: the default. */
const html = () => renderToStaticMarkup(<SessionsTabView />);
/** The tab with the `notification_center` flag on (KRTX-1742). */
const center = (props: ComponentProps<typeof SessionsTabView> = {}) =>
  renderToStaticMarkup(<SessionsTabView notificationCenter {...props} />);

const ENABLED_PREFERENCES = {
  enabled: true,
  onCompletion: true,
  onError: true,
  onQuestion: true,
  onPermission: true,
  onlyWhenHidden: true,
  playSound: false,
};

/** The `aria-checked` of the switch named `label`, or null when there is none. */
function switchState(out: string, label: string): string | null {
  const tag = [...out.matchAll(/<button[^>]*role="switch"[^>]*>/g)]
    .map((m) => m[0])
    .find((t) => t.includes(`aria-label="${label}"`));
  return tag?.match(/aria-checked="(true|false)"/)?.[1] ?? null;
}

const switchCount = (out: string) => [...out.matchAll(/role="switch"/g)].length;

const SERBIAN_COPY: SessionsTabCopy = {
  notifications: 'Обавештења',
  notificationsDescription: 'Обавештења прегледача.',
  unsupported: 'Прегледач не подржава обавештења.',
  enableNotifications: 'Омогући обавештења',
  enableDescription: {
    push: 'Приказује обавештења и кад је Kortix затворен.',
    desktop: 'Приказује обавештења док је прозор отворен.',
    browser: 'Приказује обавештења док је картица отворена.',
  },
  permissionGranted: 'Дозвола је одобрена',
  permissionDenied: 'Прегледач је блокирао дозволу',
  permissionDefault: 'Затражиће дозволу',
  notificationTypes: 'Врсте обавештења',
  notificationTypesDescription: 'Важи на сваком телефону.',
  notificationTypesCopy: {
    onCompletion: { label: 'Завршетак задатка', description: 'Када се задатак заврши' },
    onError: { label: 'Грешке', description: 'Када дође до грешке' },
    onQuestion: { label: 'Питања', description: 'Када Kortix тражи одговор' },
    onPermission: { label: 'Захтеви за дозволу', description: 'Када Kortix тражи дозволу' },
  },
  kinds: {
    turn_done: { label: 'Потез завршен', description: 'Потез се завршава.' },
    turn_error: { label: 'Потез није успео', description: 'Потез се завршава грешком.' },
    question: { label: 'Питање', description: 'Агент поставља питање.' },
    permission: { label: 'Захтев за дозволу', description: 'Агент тражи дозволу.' },
    shared: { label: 'Подељено са вама', description: 'Неко дели сесију.' },
    automation_failed: { label: 'Упозорење о грешци', description: 'Окидач не успева.' },
    automation_recovered: { label: 'Обавештење о опоравку', description: 'Окидач ради.' },
  },
  push: 'Push',
  email: 'Имејл',
  channelSwitch: (kind, channel) => `${kind}: ${channel}`,
  preferencesLoadError: 'Учитавање није успело',
  retry: 'Покушај поново',
  behavior: 'Понашање',
  sendTestNotification: 'Пошаљи пробно обавештење',
  notificationBehaviorCopy: {
    onlyWhenHidden: {
      label: 'Само у позадини',
      description: 'Када је друга картица активна',
    },
    playSound: { label: 'Звук обавештења', description: 'Пусти звук' },
  },
  sounds: 'Звукови',
  soundsDescription: 'Звуци за догађаје сесије.',
  soundPacks: {
    off: { label: 'Искључено', description: 'Сви звуци су искључени' },
    opencode: { label: 'Подразумевано', description: 'Подразумевани пакет' },
    kortix: { label: 'Kortix пакет', description: 'Звиждук' },
  },
  volume: 'Јачина звука',
  preview: 'Послушај',
  soundEvents: {
    completion: { label: 'Завршетак задатка', description: 'Када AI заврши задатак' },
    error: { label: 'Грешка', description: 'Када сесија наиђе на грешку' },
    notification: { label: 'Обавештење', description: 'Питања и захтеви за дозволу' },
    send: { label: 'Порука је послата', description: 'Када пошаљете поруку' },
  },
  testNotificationTitle: 'Пробно обавештење',
  testNotificationBody: 'Обавештења раде исправно.',
};

/**
 * Flag off (the default): the tab exactly as before the notification center.
 * These are the pre-KRTX-1742 tests, unchanged.
 */
describe('SessionsTabView', () => {
  test('renders injected locale body copy instead of fixed English body labels', () => {
    const out = renderToStaticMarkup(<SessionsTabView copy={SERBIAN_COPY} />);
    expect(out).toContain('Обавештења');
    expect(out).toContain('Омогући обавештења');
    expect(out).toContain('Звукови');
    expect(out).not.toContain('>Browser notifications<');
  });

  test('notifications lead, then sounds — one h2, the rest h3', () => {
    expect(headings(html())).toEqual(['h2:Notifications', 'h3:Browser notifications', 'h3:Sounds']);
  });

  test('a separator sits between the two sections', () => {
    expect([...html().matchAll(/data-slot="separator"/g)]).toHaveLength(1);
  });

  test('the enable-notifications toggle is the only notification control until it is on', () => {
    const out = html();
    expect(out).toContain('Enable notifications');
    expect(out).not.toContain('Notification types');
    expect(out).not.toContain('Send test notification');
  });

  test('enabling notifications reveals the type and behaviour toggles', () => {
    const out = renderToStaticMarkup(<SessionsTabView notificationPreferences={ENABLED_PREFERENCES} />);
    expect(out).toContain('Notification types');
    expect(out).toContain('Behavior');
    expect(out).toContain('Send test notification');
  });

  test('an unsupported browser says so instead of rendering dead toggles', () => {
    const out = renderToStaticMarkup(<SessionsTabView notificationsSupported={false} />);
    expect(out).toContain('does not support notifications');
    expect(out).not.toContain('Enable notifications');
  });

  test('sounds are off by default, and the volume slider only shows with a pack on', () => {
    expect(html()).not.toContain('Volume');
    const on = renderToStaticMarkup(<SessionsTabView soundPack="opencode" />);
    expect(on).toContain('Volume');
    expect(on).toContain('Task Completion');
  });

  // Added with the flag: the flag-off pane keeps the four per-browser switches,
  // their localized copy, and the three-way permission line.
  test('the four per-browser kind switches render with their localized copy', () => {
    const out = renderToStaticMarkup(
      <SessionsTabView notificationPreferences={ENABLED_PREFERENCES} copy={SERBIAN_COPY} />,
    );
    for (const label of ['Завршетак задатка', 'Грешке', 'Питања', 'Захтеви за дозволу']) {
      expect(out).toContain(`>${label}<`);
    }
    expect(out).not.toContain('Потез завршен');
    expect(switchCount(out)).toBe(1 + 4 + 2);
  });

  test('the enable line states the browser permission', () => {
    expect(html()).toContain('Will request browser permission when enabled');
    expect(renderToStaticMarkup(<SessionsTabView notificationPermission="granted" />)).toContain(
      'Browser permission granted',
    );
    expect(renderToStaticMarkup(<SessionsTabView notificationPermission="denied" />)).toContain(
      'Blocked by browser',
    );
    expect(html()).not.toContain('also with every Kortix tab closed');
  });
});

/**
 * Flag on (KRTX-1742): "Notification types" is the person's server record, its
 * own always-visible section, so the pane has three sections and two
 * separators. The four per-browser kind switches are hidden.
 */
describe('SessionsTabView with the notification center', () => {
  test('renders injected locale copy in the server record', () => {
    const out = center({ copy: SERBIAN_COPY });
    expect(out).toContain('Врсте обавештења');
    expect(out).toContain('aria-label="Потез завршен: Имејл"');
    expect(out).not.toContain('>Browser notifications<');
  });

  test('browser notifications lead, then notification types, then sounds — one h2, the rest h3', () => {
    expect(headings(center())).toEqual([
      'h2:Notifications',
      'h3:Browser notifications',
      'h3:Notification types',
      'h3:Sounds',
    ]);
  });

  test('a separator sits between each pair of sections', () => {
    expect([...center().matchAll(/data-slot="separator"/g)]).toHaveLength(2);
  });

  test('until browser notifications are on, behavior and the test button stay hidden', () => {
    const out = center();
    expect(out).toContain('Enable notifications');
    expect(out).not.toContain('>Behavior<');
    expect(out).not.toContain('Send test notification');
    expect(out).toContain('Notification types');
  });

  test('the per-browser kind switches do not render', () => {
    const on = center({ notificationPreferences: ENABLED_PREFERENCES });
    for (const retired of ['Task completions', 'Errors', 'Questions', 'Permission requests']) {
      expect(on).not.toContain(`>${retired}<`);
    }
  });

  test('enabling notifications reveals the behaviour toggles', () => {
    const out = center({ notificationPreferences: ENABLED_PREFERENCES });
    expect(out).toContain('Behavior');
    expect(out).toContain('Send test notification');
  });

  test('"Enable notifications" says where it reaches', () => {
    expect(center()).toContain('also with every Kortix tab closed');
    expect(center({ notificationReach: 'desktop' })).toContain(
      'from the desktop app while its window is open',
    );
    expect(center({ notificationReach: 'browser' })).toContain('while a Kortix tab is open');
    expect(center({ notificationPermission: 'denied' })).toContain('Blocked by browser');
  });

  test('notification types: one Push switch per kind, and Email for every kind but permission', () => {
    const out = center();
    expect(switchCount(out)).toBe(1 + 7 + 6);
    expect(out).toContain('>Push<');
    expect(out).toContain('>Email<');
    expect(switchState(out, 'Turn finished: Push')).toBe('true');
    expect(switchState(out, 'Turn finished: Email')).toBe('false');
    expect(switchState(out, 'Failure alert: Email')).toBe('true');
    expect(switchState(out, 'Permission request: Push')).toBe('true');
    expect(switchState(out, 'Permission request: Email')).toBeNull();
  });

  test('the switches show the saved record', () => {
    const out = center({
      notificationKinds: {
        ...DEFAULT_NOTIFICATION_PREFERENCES,
        question: { push: false, email: false },
      },
    });
    expect(switchState(out, 'Question: Push')).toBe('false');
    expect(switchState(out, 'Question: Email')).toBe('false');
    expect(switchState(out, 'Turn failed: Push')).toBe('true');
  });

  test('a deployment without email hides the Email column', () => {
    const out = center({ emailAvailable: false });
    expect(out).not.toContain('>Email<');
    expect(out).not.toContain(': Email"');
    expect(switchCount(out)).toBe(1 + 7);
  });

  test('while the record loads the rows show, without switches', () => {
    const out = center({ notificationKindsState: 'loading' });
    expect(out).toContain('Turn finished');
    expect(switchCount(out)).toBe(1);
  });

  test('a failed load says so and offers to try again', () => {
    const out = center({ notificationKindsState: 'error' });
    expect(out).toContain('Could not load your notification settings');
    expect(out).toContain('Try again');
    expect(out).not.toContain('Turn finished');
  });
});
