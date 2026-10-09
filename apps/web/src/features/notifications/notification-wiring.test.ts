import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where the KRTX-1742 web pieces plug in. Asserted against the source, with
 * comments stripped, because each host needs the whole provider stack to
 * mount (auth, query client, router, i18n).
 */

const SRC = join(import.meta.dir, '../..');
const code = (file: string) =>
  readFileSync(join(SRC, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('notification wiring', () => {
  test('one NotificationHost, client-only, inside the query provider hosts', () => {
    const hosts = code('components/root-client-hosts.tsx');
    expect(hosts).toContain("import('@/features/notifications/notification-host')");
    const queryHosts = hosts.slice(hosts.indexOf('export function RootQueryHosts'));
    expect(queryHosts).toContain('<NotificationHost />');
  });

  test('the session page tells the server when this tab shows its own alerts', () => {
    const page = code('app/[locale]/(app)/projects/[id]/sessions/[sessionId]/page.tsx');
    expect(page).toContain("presenceAlerts: notificationsOn && notificationPermission === 'granted',");
  });

  test('the session page clears its notifications from the bell when it opens', () => {
    const page = code('app/[locale]/(app)/projects/[id]/sessions/[sessionId]/page.tsx');
    expect(page).toContain('useOpenSessionRead(user?.id, sessionId);');
  });

  test('sign-out removes the Web Push subscription first, on a clock', () => {
    const signOut = code('lib/auth/perform-sign-out.ts');
    const body = signOut.slice(signOut.indexOf('export async function performSignOut('));
    const stop = body.indexOf('await withTimeBudget(stopWebPush(), WEB_PUSH_SIGN_OUT_BUDGET_MS);');
    expect(stop).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(body.indexOf('createClient()'));
    expect(stop).toBeLessThan(body.indexOf('await runSignOut('));
  });

  test('the access-requests control no longer looks like the bell', () => {
    const accessRequests = code('features/workspace/project-layout/home/access-requests-bell.tsx');
    expect(accessRequests).toContain('<UserPlusIcon');
    expect(accessRequests).not.toContain('BellIcon');
  });

  test('a host never subscribes in the desktop app', () => {
    const host = code('features/notifications/notification-host.tsx');
    expect(host).toContain('if (!webPushSupported()) return;');
    expect(code('features/notifications/web-push.ts')).toContain('!isDesktop()');
  });
});
