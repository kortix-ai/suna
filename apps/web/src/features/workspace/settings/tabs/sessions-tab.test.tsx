import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionsTabView } from './sessions-tab';

const headings = (html: string): string[] =>
  [...html.matchAll(/<(h[23])[^>]*>([^<]*)<\/\1>/g)].map((m) => `${m[1]}:${m[2]}`);

const html = () => renderToStaticMarkup(<SessionsTabView />);

describe('SessionsTabView', () => {
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
