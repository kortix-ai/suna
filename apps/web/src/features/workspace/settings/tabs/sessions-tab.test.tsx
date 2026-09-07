import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionsTabView } from './sessions-tab';

const headings = (html: string): string[] =>
  [...html.matchAll(/<(h[23])[^>]*>([^<]*)<\/\1>/g)].map((m) => `${m[1]}:${m[2]}`);

const html = () => renderToStaticMarkup(<SessionsTabView />);

describe('SessionsTabView', () => {
  test('renders injected locale body copy instead of fixed English body labels', () => {
    const out = renderToStaticMarkup(
      <SessionsTabView
        copy={{
          notifications: 'Обавештења',
          notificationsDescription: 'Обавештења прегледача.',
          unsupported: 'Прегледач не подржава обавештења.',
          enableNotifications: 'Омогући обавештења',
          permissionGranted: 'Дозвола је одобрена',
          permissionDenied: 'Прегледач је блокирао дозволу',
          permissionDefault: 'Затражиће дозволу',
          notificationTypes: 'Врсте обавештења',
          behavior: 'Понашање',
          sendTestNotification: 'Пошаљи пробно обавештење',
          notificationTypesCopy: {
            onCompletion: { label: 'Завршетак задатка', description: 'Када се задатак заврши' },
            onError: { label: 'Грешке', description: 'Када дође до грешке' },
            onQuestion: { label: 'Питања', description: 'Када Kortix тражи одговор' },
            onPermission: { label: 'Захтеви за дозволу', description: 'Када Kortix тражи дозволу' },
          },
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
});
