/**
 * The mobile sidebar sheet rendered the desktop-only Ctrl/Cmd+J shortcut hint
 * inline in the New-session row — invisible at rest but revealed by the
 * sticky hover a tap leaves behind, so phone users saw a keyboard shortcut
 * that does not apply to them (KRTX-2005). The hint renders on desktop only
 * now; the row itself stays.
 */
import { afterEach, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window();
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.location = win.location;
globals.history = win.history;
globals.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);
// The mobile sheet is a Radix dialog: its focus guards and dismissable layer
// read DOM constructor globals at mount. Bun ships its own `Event` family, so
// `key in globals` alone would leave happy-dom's document rejecting bun-realm
// event objects. Mirror the happy-dom window OVER bun's DOM classes, except
// the async/network primitives bun's own loop must keep.
const KEEP_BUN = new Set([
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'queueMicrotask', 'structuredClone', 'fetch', 'Request', 'Response',
  'Headers', 'FormData', 'Blob', 'URL', 'URLSearchParams', 'AbortController',
  'AbortSignal', 'crypto', 'performance', 'console', 'process', 'Buffer',
  'TextEncoder', 'TextDecoder', 'atob', 'btoa', 'WebSocket', 'Worker',
  'MessageChannel', 'MessagePort', 'SharedArrayBuffer', 'Atomics',
]);
for (const key of Object.getOwnPropertyNames(win)) {
  if (KEEP_BUN.has(key) || key === 'window' || key === 'document' || key === 'self') continue;
  try {
    const value = (win as unknown as Record<string, unknown>)[key];
    if (value !== null && (typeof value === 'function' || typeof value === 'object')) {
      globals[key] = value;
    }
  } catch {
    // Cross-realm accessors that throw on read are globals bun already provides.
  }
}

const translate = Object.assign((key: string) => key, { raw: (key: string) => key });
const translationsMock = () => ({ useTranslations: () => translate });
mock.module('@/i18n/use-translations', translationsMock);
mock.module('@kortix/ui/i18n', translationsMock);
let newSessionCalls = 0;
mock.module('@kortix/ui/internal/hooks/projects/use-new-project-session', () => ({
  useNewProjectSession: () => () => {
    newSessionCalls += 1;
  },
}));
// The `chat` flag, read by the sidebar through the SDK hook.
let channelsOn = false;
const realSdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...realSdkReact,
  useFeatureFlag: (_projectId: string, key: string) => ({
    enabled: key === 'chat' && channelsOn,
    isLoading: false,
  }),
  useProjectSpaces: () => ({
    data: [
      { space_id: 'S1', kind: 'channel', slug: 'general', name: 'general', is_default: true, archived_at: null },
      { space_id: 'S2', kind: 'channel', slug: 'old', name: 'old', is_default: false, archived_at: '2026-01-01T00:00:00.000Z' },
      { space_id: 'S3', kind: 'dm', slug: null, name: 'kortix', is_default: false, archived_at: null },
    ],
    isError: false,
    refetch: () => undefined,
  }),
  useVisibleAgents: () => [{ name: 'kortix' }, { name: 'meta' }],
  useCreateProjectSpace: () => ({ mutate: () => undefined, isPending: false }),
  useUpdateProjectSpace: () => ({ mutate: () => undefined, isPending: false }),
  // 3 unread, one of them a question (Needs you): the sidebar still shows no Inbox row.
  useNotificationInbox: () => ({
    data: { notifications: [{ id: 'n1', kind: 'question', read: false }], unread_count: 3 },
    unreadCount: 3,
  }),
}));
mock.module('@kortix/ui/internal/hooks/projects/new-session-guard', () => ({
  useIsCreatingProjectSession: () => false,
}));
mock.module('@kortix/ui/internal/stores/billing-account-context', () => ({
  useBillingAccountId: () => 'synthetic-account',
}));
mock.module('@kortix/ui/workspace/sidebar/project-session-list', () => ({
  ProjectSessionList: ({ secondary }: { secondary?: boolean }) =>
    React.createElement('div', { 'data-testid': 'session-list', 'data-secondary': secondary ? 'true' : 'false' }),
}));
mock.module('@/features/workspace/project-sidebar/workspace-switcher', () => ({
  WorkspaceSwitcher: () => React.createElement('div', { 'data-testid': 'switcher' }),
}));
mock.module('@kortix/ui/internal/tunnel/computer-connect', () => ({
  ComputerConnectModal: () => null,
  // The sidebar's Apps and extensions window reads it.
  useOwnsPairedComputer: () => ({ isSuccess: true, owns: false, owned: [] }),
}));
mock.module('@kortix/ui/internal/layout/connect-mcp-modal', () => ({
  ConnectMcpModal: () => null,
}));
mock.module('@kortix/ui/workspace/sidebar/footer/project-mcp-nav', () => ({
  ProjectMcpNavItem: () => null,
}));
mock.module('@kortix/ui/workspace/sidebar/footer/project-computer-nav', () => ({
  ProjectComputerNavItem: () => null,
}));
mock.module('@kortix/ui/workspace/sidebar/footer/project-manifest-issues-alert', () => ({
  ProjectManifestIssuesAlert: () => null,
}));
mock.module('@kortix/ui/workspace/sidebar/footer/project-sandbox-alert', () => ({
  ProjectSandboxAlert: () => null,
}));
mock.module('@kortix/ui/workspace/sidebar/footer/project-balance-warning', () => ({
  SidebarBalanceWarning: () => null,
}));
mock.module('@kortix/ui/workspace/sidebar/footer/project-upgrade-button', () => ({
  SidebarUpgradeButton: () => null,
}));
mock.module('@kortix/ui/workspace/repository-disconnected', () => ({
  ProjectRepositoryDisconnectedAlert: () => null,
}));
mock.module('@kortix/ui/workspace/sidebar/project-nav-items', () => ({
  ProjectNavItems: () => null,
}));
mock.module('@kortix/ui/internal/layout/open-command-palette', () => ({
  openCommandPalette: () => undefined,
}));

const { SidebarProvider, useSidebar } = await import('@kortix/ui/sidebar');
const { ProjectSidebar } = await import('@kortix/ui/workspace/sidebar/project-sidebar');

let root: Root | undefined;
// Cross-realm DOM: happy-dom's HTMLElement tree is structurally narrower
// than lib.dom's, so the container keeps its own minimal shape and the
// createRoot argument casts through unknown.
let container: { innerHTML: string; remove(): void } | undefined;

/** Opens the mobile sheet on mount: its content only exists while open. */
function MobileOpenHarness({ projectId }: { projectId: string }) {
  const { openMobile, setOpenMobile } = useSidebar();
  React.useEffect(() => {
    setOpenMobile(true);
  }, [setOpenMobile]);
  return React.createElement(
    React.Fragment,
    null,
    // Outside the sheet: whether the sheet is open.
    React.createElement('span', { 'data-testid': 'sheet', 'data-open': openMobile ? 'true' : 'false' }),
    React.createElement(ProjectSidebar, { projectId }),
  );
}

async function mountSidebar(width: number) {
  (win as unknown as { innerWidth: number }).innerWidth = width;
  const raw = win.document.createElement('div');
  container = raw;
  win.document.body.appendChild(raw);
  root = createRoot(raw as unknown as Parameters<typeof createRoot>[0]);
  const mobile = width < 768;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      // The channels nav's permission probe reads a QueryClient.
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          SidebarProvider,
          null,
          mobile
            ? React.createElement(MobileOpenHarness, { projectId: 'synthetic-project' })
            : React.createElement(ProjectSidebar, { projectId: 'synthetic-project' }),
        ),
      ),
    );
  });
}

afterEach(async () => {
  channelsOn = false;
  newSessionCalls = 0;
  if (root) {
    const r = root;
    root = undefined;
    await act(async () => r.unmount());
  }
  container?.remove();
  container = undefined;
});

test('the desktop rail keeps the Ctrl/Cmd+J shortcut hint on the New-session row', async () => {
  await mountSidebar(1280);
  expect(container!.innerHTML).toContain('newSession');
  expect(container!.innerHTML).toContain('data-slot="kbd-group"');
});

test('the mobile sheet renders no keyboard shortcut hint (KRTX-2005)', async () => {
  await mountSidebar(390);
  // The mobile sheet is a Radix portal: its content mounts into document.body,
  // not into the test container the provider renders into.
  expect(document.body.innerHTML).toContain('newSession');
  expect(document.body.innerHTML).not.toContain('data-slot="kbd-group"');
});

test('with chat on, the sidebar is Spaces only (Cmd+J still opens the new-session composer): Review, the personal chat at /chat, the live channels, and the session list waiting in More as the secondary list', async () => {
  // The layout #11783 set (ProjectSpacesNav, SidebarMoreGroup): no New session
  // row and no Direct messages section; a DM is one more space in the list.
  channelsOn = true;
  await mountSidebar(1280);
  // The session list waits in "More" at the bottom, closed by default.
  expect(container!.innerHTML).not.toContain('data-testid="session-list"');
  const more = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'more');
  expect(more).toBeDefined();
  await act(async () => {
    more!.click();
  });
  const html = container!.innerHTML;
  expect(html).not.toContain('newSession');
  expect(html).not.toContain('oneChat');
  expect(html).not.toContain('spaces.directMessages');
  // Review first, then the person's own space (their chat with My Kortix, at /chat), then the channels.
  const review = html.indexOf('href="/workspaces/synthetic-project/review"');
  const personal = html.indexOf('href="/workspaces/synthetic-project/chat"');
  const general = html.indexOf('href="/workspaces/synthetic-project/c/general"');
  expect(review).toBeGreaterThan(-1);
  expect(personal).toBeGreaterThan(review);
  expect(general).toBeGreaterThan(personal);
  // The My Kortix DM is that personal row, never a second row of its own.
  expect(html).not.toContain('href="/workspaces/synthetic-project/dm/kortix"');
  // Live channels only, then the add row.
  expect(html).not.toContain('/c/old');
  expect(html.indexOf('spaces.addChannel')).toBeGreaterThan(general);
  // The session list is the secondary list, below the spaces.
  expect(html).toContain('data-testid="session-list" data-secondary="true"');
  expect(html.indexOf('data-testid="session-list"')).toBeGreaterThan(html.indexOf('spaces.addChannel'));
  await act(async () => {
    win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'j', metaKey: true }));
  });
  // A regular session starts as with chat off: `newSessionHref`, never the default channel.
  expect(newSessionCalls).toBe(1);
});

test('with chat off, the sidebar keeps New session, the session list and Cmd+J', async () => {
  await mountSidebar(1280);
  const html = container!.innerHTML;
  expect(html).toContain('data-testid="session-list" data-secondary="false"');
  expect(html).toContain('newSession');
  expect(html).not.toContain('spaces.channels');
  expect(html).not.toContain('href="/workspaces/synthetic-project/chat"');
  await act(async () => {
    win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'j', metaKey: true }));
  });
  expect(newSessionCalls).toBe(1);
});

const INBOX_HREF = 'href="/workspaces/synthetic-project/inbox"';

// The Inbox is a row in the workspace menu (`workspace-switcher.tsx`), not a
// sidebar nav row, with Spaces off or on.
test('the sidebar has no Inbox row (KRTX-1742)', async () => {
  await mountSidebar(1280);
  expect(container!.innerHTML).not.toContain(INBOX_HREF);
});

test('with chat on, the sidebar has no Inbox row either', async () => {
  channelsOn = true;
  await mountSidebar(1280);
  expect(container!.innerHTML).not.toContain(INBOX_HREF);
});
