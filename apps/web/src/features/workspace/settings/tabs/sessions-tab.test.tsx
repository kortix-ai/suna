import { DEFAULT_NOTIFICATION_PREFERENCES } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionsTabView } from './sessions-tab';

const headings = (html: string): string[] =>
  [...html.matchAll(/<(h[23])[^>]*>([^<]*)<\/\1>/g)].map((m) => `${m[1]}:${m[2]}`);

/** The tab with its defaults: browser notifications off, the default per-kind record. */
const html = (props: ComponentProps<typeof SessionsTabView> = {}) =>
  renderToStaticMarkup(<SessionsTabView {...props} />);

const ENABLED_PREFERENCES = {
  enabled: true,
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

const SERBIAN_COPY: NonNullable<ComponentProps<typeof SessionsTabView>['copy']> = {
  notifications: 'Обавештења',
  notificationsDescription: 'Обавештења прегледача.',
  unsupported: 'Прегледач не подржава обавештења.',
  enableNotifications: 'Омогући обавештења',
  enableDescription: {
    push: 'Приказује обавештења и кад је Kortix затворен.',
    desktop: 'Приказује обавештења док је прозор отворен.',
    browser: 'Приказује обавештења док је картица отворена.',
  },
  permissionDenied: 'Прегледач је блокирао дозволу',
  notificationTypes: 'Врсте обавештења',
  notificationTypesDescription: 'Важи на сваком телефону.',
  kinds: {
    turn_done: { label: 'Потез завршен', description: 'Потез се завршава.' },
    turn_error: { label: 'Потез није успео', description: 'Потез се завршава грешком.' },
    question: { label: 'Питање', description: 'Агент поставља питање.' },
    permission: { label: 'Захтев за дозволу', description: 'Агент тражи дозволу.' },
    shared: { label: 'Подељено са вама', description: 'Неко дели сесију.' },
    automation_failed: { label: 'Упозорење о грешци', description: 'Окидач не успева.' },
    automation_recovered: { label: 'Обавештење о опоравку', description: 'Окидач ради.' },
    capture_device_down: { label: 'Рачунар је стао', description: 'Рачунар не снима.' },
    capture_device_recovered: { label: 'Рачунар поново снима', description: 'Рачунар снима.' },
    // The retired `message` kind (Rooms) is still a key of the SDK type; no row renders it.
    message: { label: 'Порука', description: 'Неко вам пише у разговору.' },
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
    classic: { label: 'Подразумевано', description: 'Подразумевани пакет' },
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
 * The pane (KRTX-1742): browser notifications for this browser, then the
 * person's server record per kind (Push and Email), then sounds. Every
 * project has the record since `notification_center` graduated (2026-11-06),
 * so the four per-browser kind switches of the flag-off pane are gone.
 */
describe('SessionsTabView', () => {
  test('renders injected locale copy, in the server record too', () => {
    const out = html({ copy: SERBIAN_COPY });
    expect(out).toContain('Обавештења');
    expect(out).toContain('Омогући обавештења');
    expect(out).toContain('Врсте обавештења');
    expect(out).toContain('aria-label="Потез завршен: Имејл"');
    expect(out).toContain('Звукови');
    expect(out).not.toContain('>Browser notifications<');
  });

  test('all sound pack and event choices retain their injected copy and order', () => {
    const out = html({ copy: SERBIAN_COPY, soundPack: 'kortix' });
    const labels = [
      ...Object.values(SERBIAN_COPY.soundPacks),
      ...Object.values(SERBIAN_COPY.soundEvents),
    ];
    for (const { label, description } of labels) {
      expect(out).toContain(label);
      expect(out).toContain(description);
    }
    expect(out.indexOf(SERBIAN_COPY.soundPacks.off.label)).toBeLessThan(out.indexOf(SERBIAN_COPY.soundPacks.classic.label));
    expect(out.indexOf(SERBIAN_COPY.soundPacks.classic.label)).toBeLessThan(out.indexOf(SERBIAN_COPY.soundPacks.kortix.label));
  });

  test('browser notifications lead, then notification types, then sounds — one h2, the rest h3', () => {
    expect(headings(html())).toEqual([
      'h2:Notifications',
      'h3:Browser notifications',
      'h3:Notification types',
      'h3:Sounds',
    ]);
  });

  test('a separator sits between each pair of sections', () => {
    expect([...html().matchAll(/data-slot="separator"/g)]).toHaveLength(2);
  });

  test('until browser notifications are on, behavior and the test button stay hidden', () => {
    const out = html();
    expect(out).toContain('Enable notifications');
    expect(out).not.toContain('>Behavior<');
    expect(out).not.toContain('Send test notification');
    expect(out).toContain('Notification types');
  });

  test('enabling notifications reveals the behaviour toggles, and no per-browser kind switch', () => {
    const out = html({ notificationPreferences: ENABLED_PREFERENCES });
    expect(out).toContain('Behavior');
    expect(out).toContain('Send test notification');
    for (const retired of ['Task completions', 'Errors', 'Questions', 'Permission requests']) {
      expect(out).not.toContain(`>${retired}<`);
    }
    // Enable, the two behaviour switches, and the record's 9 Push and 8 Email switches.
    expect(switchCount(out)).toBe(1 + 2 + 9 + 8);
  });

  test('an unsupported browser says so instead of rendering dead toggles', () => {
    const out = html({ notificationsSupported: false });
    expect(out).toContain('does not support notifications');
    expect(out).not.toContain('Enable notifications');
  });

  test('sounds are off by default, and the volume slider only shows with a pack on', () => {
    expect(html()).not.toContain('Volume');
    const on = html({ soundPack: 'classic' });
    expect(on).toContain('Volume');
    expect(on).toContain('Task Completion');
  });

  test('"Enable notifications" says where it reaches', () => {
    expect(html()).toContain('also with every Kortix tab closed');
    expect(html({ notificationReach: 'desktop' })).toContain(
      'from the desktop app while its window is open',
    );
    expect(html({ notificationReach: 'browser' })).toContain('while a Kortix tab is open');
    expect(html({ notificationPermission: 'denied' })).toContain('Blocked by browser');
  });

  test('the record description says the Inbox lists everything and email is opt-in', () => {
    const out = html();
    expect(out).toContain('The Inbox lists every notification, whatever these choices are.');
    expect(out).toContain('Email is off for most kinds until you turn it on.');
    expect(out).not.toContain('Notification Center');
  });

  test('notification types: one Push switch per kind, and Email for every kind but permission', () => {
    const out = html();
    expect(switchCount(out)).toBe(1 + 9 + 8);
    expect(out).toContain('>Push<');
    expect(out).toContain('>Email<');
    expect(switchState(out, 'Turn finished: Push')).toBe('true');
    expect(switchState(out, 'Turn finished: Email')).toBe('false');
    expect(switchState(out, 'Failure alert: Email')).toBe('true');
    expect(switchState(out, 'Permission request: Push')).toBe('true');
    expect(switchState(out, 'Permission request: Email')).toBeNull();
  });

  test('the switches show the saved record', () => {
    const out = html({
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
    const out = html({ emailAvailable: false });
    expect(out).not.toContain('>Email<');
    expect(out).not.toContain(': Email"');
    expect(switchCount(out)).toBe(1 + 9);
  });

  test('while the record loads the rows show, without switches', () => {
    const out = html({ notificationKindsState: 'loading' });
    // The row's own description: the section description also names the kinds.
    expect(out).toContain('A turn ends.');
    expect(switchCount(out)).toBe(1);
  });

  test('a failed load says so and offers to try again', () => {
    const out = html({ notificationKindsState: 'error' });
    expect(out).toContain('Could not load your notification settings');
    expect(out).toContain('Try again');
    expect(out).not.toContain('A turn ends.');
  });
});

describe('blocked notification recovery', () => {
  test('denied permission offers browser-specific instructions and an inline sound fallback', () => {
    const out = html({ notificationPermission: 'denied' });
    for (const browser of ['Chrome', 'Edge', 'Firefox', 'Safari']) expect(out).toContain(browser);
    expect(out).toContain('Enable completion sound');
    expect(out).toContain('While a Kortix tab is open');
  });

  test('recovery is not shown when permission can still be requested or is already granted', () => {
    for (const permission of ['default', 'granted'] as const) {
      const out = html({ notificationPermission: permission });
      expect(out).not.toContain('Enable completion sound');
    }
  });
});
