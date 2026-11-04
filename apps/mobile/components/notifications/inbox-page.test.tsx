import { afterEach, beforeAll, beforeEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { readFileSync } from 'node:fs';

const projectId = '11111111-1111-4111-8111-111111111111';
const artifactPath = `/projects/${projectId}/artifacts/22222222-2222-4222-8222-222222222222?thread=33333333-3333-4333-8333-333333333333`;
let notification: Record<string, unknown>;
const rowProps: Array<{ onPress(): void; accessibilityHint?: string }> = [];
const reads: unknown[] = [];
const opened: string[] = [];
const native: unknown[] = [];
const Empty = () => null;
const Children = ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children);
const fakes: Record<string, Record<string, unknown>> = {
  'react-native': { View: Children, RefreshControl: Empty },
  nativewind: { useColorScheme: () => ({ colorScheme: 'light' }) },
  '@kortix/sdk/react': { useNotificationInbox: () => ({ data: { notifications: [notification] }, unreadCount: 1, refetch: async () => {}, markAllRead: async () => {}, markRead: async (ids: unknown) => { reads.push(ids); } }) },
  '@/components/kortix/settings-list': { SettingsPage: Children, SettingsGroup: Children, SettingsHeader: Empty, SettingsRow: (props: { onPress(): void }) => { rowProps.push(props); return null; } },
  '@/components/kortix/toast-provider': { useToast: () => ({ error() {} }) },
  '@/components/session/ProjectRoutes': { useCoveringRoute() {}, useProjectRoute: () => ({ openDrawer() {} }) },
  '@/contexts': { useAuthContext: () => ({ user: { id: 'synthetic-user' } }) },
  '@/lib/haptics': { haptics: { tap() {} } },
  '@/lib/utils/index': { cn: (...parts: string[]) => parts.join(' ') },
  '@/lib/utils/theme': { THEME: { dark: { mutedForeground: 'black' }, light: { mutedForeground: 'black' } } },
  '@/stores/push-store': { usePushStore: { getState: () => ({ requestOpen: (...target: unknown[]) => native.push(target) }) } },
  '@/lib/kortix-web': { KORTIX_WEB_URL: 'https://configured-web.example.test' },
  '@/lib/utils/open-link': { openLink: async (url: string) => { opened.push(url); } },
};
const real = new Set(['react', '@kortix/sdk', '@/lib/notifications/inbox', '@/lib/session/session-list']);
const source = readFileSync(`${import.meta.dir}/InboxPage.tsx`, 'utf8');
for (const [, names, name] of source.matchAll(/import\s+(?:type\s+)?(?:\w+\s*,\s*)?\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/gs)) {
  if (real.has(name)) continue;
  const values: Record<string, unknown> = { ...fakes[name] };
  for (const item of names.split(',')) {
    const key = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0];
    if (key && !(key in values)) values[key] = Empty;
  }
  mock.module(name, () => values);
}
let Page: typeof import('./InboxPage').InboxPage;
let tree: ReturnType<typeof create>;
beforeAll(async () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  Page = (await import('./InboxPage')).InboxPage;
});
beforeEach(() => {
  rowProps.length = reads.length = opened.length = native.length = 0;
  notification = { id: 'synthetic-note', kind: 'artifact_comment', title: 'Review source', body: 'Confirm it.', project_id: projectId, project_name: 'Synthetic project', session_id: null, trigger_slug: null, actor_user_id: null, url: artifactPath, read: false, created_at: '2026-10-29T00:00:00Z' };
});
afterEach(async () => { await act(async () => tree?.unmount()); });
async function tapRow() {
  await act(async () => { tree = create(React.createElement(Page)); });
  expect(rowProps).toHaveLength(1);
  await act(async () => { rowProps[0]!.onPress(); });
}

test('the actual inbox row tap marks read and opens the configured Artifact web URL', async () => {
  await tapRow();
  expect(reads).toEqual([['synthetic-note']]);
  expect(opened).toEqual([`https://configured-web.example.test${artifactPath}`]);
  expect(native).toEqual([]);
  expect(rowProps[0]!.accessibilityHint).toBe('Opens the Artifact');
});

test('a malformed Artifact URL cannot open externally or fall back to the native project', async () => {
  notification.url = 'https://evil.example.test/';
  await tapRow();
  expect(opened).toEqual([]);
  expect(native).toEqual([]);
});

test('an existing session notification keeps native session navigation', async () => {
  notification = { ...notification, kind: 'question', session_id: 'synthetic-session', url: `/projects/${projectId}/sessions/synthetic-session` };
  await tapRow();
  expect(native).toEqual([[projectId, 'synthetic-session']]);
  expect(opened).toEqual([]);
});
