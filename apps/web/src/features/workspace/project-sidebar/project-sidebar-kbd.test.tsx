/**
 * The mobile sidebar sheet rendered the desktop-only Ctrl/Cmd+J shortcut hint
 * inline in the New-session row — invisible at rest but revealed by the
 * sticky hover a tap leaves behind, so phone users saw a keyboard shortcut
 * that does not apply to them (KRTX-2005). The hint renders on desktop only
 * now; the row itself stays.
 */
import { afterEach, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
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
mock.module('@kortix/ui/internal/hooks/projects/use-new-project-session', () => ({
  useNewProjectSession: () => () => undefined,
}));
mock.module('@kortix/ui/internal/hooks/projects/new-session-guard', () => ({
  useIsCreatingProjectSession: () => false,
}));
mock.module('@kortix/ui/internal/stores/billing-account-context', () => ({
  useBillingAccountId: () => 'synthetic-account',
}));
mock.module('@kortix/ui/internal/notifications/notification-bell', () => ({
  NotificationBell: () => React.createElement('div', { 'data-testid': 'notification-bell' }),
}));
mock.module('@kortix/ui/workspace/sidebar/project-session-list', () => ({
  ProjectSessionList: () => React.createElement('div', { 'data-testid': 'session-list' }),
}));
mock.module('@/features/workspace/project-sidebar/workspace-switcher', () => ({
  WorkspaceSwitcher: () => React.createElement('div', { 'data-testid': 'switcher' }),
}));
mock.module('@kortix/ui/workspace/sidebar/customize-sidebar-modal', () => ({
  CustomizeSidebarModal: () => null,
}));
mock.module('@kortix/ui/internal/tunnel/computer-connect', () => ({
  ComputerConnectModal: () => null,
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
mock.module('@kortix/ui/workspace/sidebar/footer/project-manifest-upgrade-alert', () => ({
  ProjectManifestUpgradeAlert: () => null,
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
  const { setOpenMobile } = useSidebar();
  React.useEffect(() => {
    setOpenMobile(true);
  }, [setOpenMobile]);
  return React.createElement(ProjectSidebar, { projectId });
}

async function mountSidebar(width: number) {
  (win as unknown as { innerWidth: number }).innerWidth = width;
  const raw = win.document.createElement('div');
  container = raw;
  win.document.body.appendChild(raw);
  root = createRoot(raw as unknown as Parameters<typeof createRoot>[0]);
  const mobile = width < 768;
  await act(async () => {
    root!.render(
      React.createElement(
        SidebarProvider,
        null,
        mobile
          ? React.createElement(MobileOpenHarness, { projectId: 'synthetic-project' })
          : React.createElement(ProjectSidebar, { projectId: 'synthetic-project' }),
      ),
    );
  });
}

afterEach(async () => {
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
