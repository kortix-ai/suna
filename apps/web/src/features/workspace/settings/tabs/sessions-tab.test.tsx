import { describe, expect, test } from 'bun:test';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '@kortix/sdk';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionsTabView } from './sessions-tab';

const headings = (html: string): string[] =>
  [...html.matchAll(/<(h[23])[^>]*>([^<]*)<\/\1>/g)].map((m) => `${m[1]}:${m[2]}`);

const html = () => renderToStaticMarkup(<SessionsTabView />);

/** The `aria-checked` of the switch named `label`, or null when there is none. */
function switchState(out: string, label: string): string | null {
  const tag = [...out.matchAll(/<button[^>]*role="switch"[^>]*>/g)]
    .map((m) => m[0])
    .find((t) => t.includes(`aria-label="${label}"`));
  return tag?.match(/aria-checked="(true|false)"/)?.[1] ?? null;
}

const switchCount = (out: string) => [...out.matchAll(/role="switch"/g)].length;

describe('SessionsTabView', () => {
  test('renders injected locale body copy instead of fixed English body labels', () => {
    const out = renderToStaticMarkup(
      <SessionsTabView
        copy={{
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
        }}
      />,
    );
    expect(out).toContain('Обавештења');
    expect(out).toContain('Омогући обавештења');
    expect(out).toContain('Звукови');
    expect(out).toContain('Врсте обавештења');
    expect(out).toContain('aria-label="Потез завршен: Имејл"');
    expect(out).not.toContain('>Browser notifications<');
  });

  // KRTX-1742 changed this pinned outline deliberately: "Notification types"
  // is now its own always-visible section (the person's server record), so
  // the pane has three sections and two separators.
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

  // KRTX-1742: was "the enable-notifications toggle is the only notification
  // control until it is on". The per-browser kind switches are gone; the
  // server matrix shows whether or not this browser shows notifications.
  test('until browser notifications are on, behavior and the test button stay hidden', () => {
    const out = html();
    expect(out).toContain('Enable notifications');
    expect(out).not.toContain('>Behavior<');
    expect(out).not.toContain('Send test notification');
    expect(out).toContain('Notification types');
  });

  test('the retired per-browser kind switches never render', () => {
    const on = renderToStaticMarkup(
      <SessionsTabView
        notificationPreferences={{
          enabled: true,
          onCompletion: true,
          onError: true,
          onQuestion: true,
          onPermission: true,
          onlyWhenHidden: true,
          playSound: false,
        }}
      />,
    );
    for (const retired of ['Task completions', 'Errors', 'Questions', 'Permission requests']) {
      expect(on).not.toContain(`>${retired}<`);
    }
  });

  test('enabling notifications reveals the behaviour toggles', () => {
    const out = renderToStaticMarkup(
      <SessionsTabView
        notificationPreferences={{
          enabled: true,
          onCompletion: true,
          onError: true,
          onQuestion: true,
          onPermission: true,
          onlyWhenHidden: true,
          playSound: false,
        }}
      />,
    );
    expect(out).toContain('Behavior');
    expect(out).toContain('Send test notification');
  });

  test('"Enable notifications" says where it reaches', () => {
    expect(html()).toContain('also with every Kortix tab closed');
    expect(renderToStaticMarkup(<SessionsTabView notificationReach="desktop" />)).toContain(
      'from the desktop app while its window is open',
    );
    expect(renderToStaticMarkup(<SessionsTabView notificationReach="browser" />)).toContain(
      'while a Kortix tab is open',
    );
    expect(
      renderToStaticMarkup(<SessionsTabView notificationPermission="denied" />),
    ).toContain('Blocked by browser');
  });

  test('an unsupported browser says so instead of rendering dead toggles', () => {
    const out = renderToStaticMarkup(<SessionsTabView notificationsSupported={false} />);
    expect(out).toContain('does not support notifications');
    expect(out).not.toContain('Enable notifications');
  });

  test('notification types: one Push switch per kind, and Email for every kind but permission', () => {
    const out = html();
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
    const out = renderToStaticMarkup(
      <SessionsTabView
        notificationKinds={{
          ...DEFAULT_NOTIFICATION_PREFERENCES,
          question: { push: false, email: false },
        }}
      />,
    );
    expect(switchState(out, 'Question: Push')).toBe('false');
    expect(switchState(out, 'Question: Email')).toBe('false');
    expect(switchState(out, 'Turn failed: Push')).toBe('true');
  });

  test('a deployment without email hides the Email column', () => {
    const out = renderToStaticMarkup(<SessionsTabView emailAvailable={false} />);
    expect(out).not.toContain('>Email<');
    expect(out).not.toContain(': Email"');
    expect(switchCount(out)).toBe(1 + 7);
  });

  test('while the record loads the rows show, without switches', () => {
    const out = renderToStaticMarkup(<SessionsTabView notificationKindsState="loading" />);
    expect(out).toContain('Turn finished');
    expect(switchCount(out)).toBe(1);
  });

  test('a failed load says so and offers to try again', () => {
    const out = renderToStaticMarkup(<SessionsTabView notificationKindsState="error" />);
    expect(out).toContain('Could not load your notification settings');
    expect(out).toContain('Try again');
    expect(out).not.toContain('Turn finished');
  });

  test('sounds are off by default, and the volume slider only shows with a pack on', () => {
    expect(html()).not.toContain('Volume');
    const on = renderToStaticMarkup(<SessionsTabView soundPack="opencode" />);
    expect(on).toContain('Volume');
    expect(on).toContain('Task Completion');
  });
});
