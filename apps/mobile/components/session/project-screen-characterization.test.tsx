import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { readFileSync } from 'node:fs';

const source = readFileSync(import.meta.dir + '/ProjectScreen.tsx', 'utf8') + readFileSync(import.meta.dir + '/../../lib/session/project-connect.ts', 'utf8') + readFileSync(import.meta.dir + '/use-project-stack.ts', 'utf8') + readFileSync(import.meta.dir + '/use-project-home-send.ts', 'utf8');
const calls: { name: string; args: any[] }[] = [];
const spy = (name: string) => (...args: any[]) => { calls.push({ name, args }); };
const seen = (name: string) => calls.filter((call) => call.name === name);
const Empty = () => null;
let route: any;
let drawer: any;
let home: any;
let connecting: any;
let back: (() => boolean) | undefined;
let stackListener: any;
let routes: any[];
let tab: any;
let response: () => Promise<any>;
let health: () => Promise<any>;
let homeRenders = 0;
let thread: any;
let threadRenders = 0;
let reviewData: any[] = [];
let actionsSheet: any;
let inbox: any;
let inboxOptions: any;
let pendingOpen: any;
let project: any;
let tree: ReactTestRenderer | undefined;
let ProjectScreen: typeof import('./ProjectScreen').ProjectScreen;

const sandbox = { sandboxUrl: null, switchSandbox: spy('switchSandbox'), clearSandbox: spy('clearSandbox') };
const router = { push: spy('routerPush') };
// Stable, as the real query client and zustand actions are.
const queryClient = { invalidateQueries: spy('invalidate'), setQueryData: spy('setQueryData') };
const upgradeStore = { openUpgradeSheet: spy('upgrade') };
const top = { getState: () => ({ routes }), dispatch: spy('dispatch') };
const root = { dispatch: spy('rootDispatch'), canGoBack: () => false };
const moduleMocks: Record<string, Record<string, any>> = {
  'react-native': { View: ({ children }: any) => children, Platform: { OS: 'android' }, BackHandler: { addEventListener: (_: string, callback: () => boolean) => { back = callback; return { remove: () => { back = undefined; } }; } } },
  'expo-router': { Stack: Object.assign(({ children, screenListeners }: any) => { if (screenListeners) stackListener = screenListeners; return children; }, { Screen: Empty }), useIsFocused: () => true, useLocalSearchParams: () => ({ id: 'project-1' }), useRouter: () => router },
  'expo-router/react-navigation': { useFocusEffect: (callback: () => void) => React.useEffect(callback, [callback]), useNavigation: () => root,
    StackActions: { push: (...args: any[]) => ({ type: 'push', args }), replace: (...args: any[]) => ({ type: 'replace', args }), popTo: (...args: any[]) => ({ type: 'popTo', args }) },
    CommonActions: { reset: (value: any) => ({ type: 'reset', value }) } },
  '@/components/session/ProjectRoutes': { PROJECT_HOME_ROUTE: 'index', PROJECT_VIEW_ROUTE: 'view', PROJECT_PAGE_ROUTE: 'page', PROJECT_SESSIONS_ROUTE: 'sessions', PROJECT_FILES_ROUTE: 'files', PROJECT_ACCOUNT_ROUTE: 'account', PROJECT_INBOX_ROUTE: 'inbox', ProjectRouteProvider: ({ value, children }: any) => { route = value; return React.createElement(React.Fragment, null, value.home, value.view, children); }, backFromSubPage: spy('backSubPage') },
  '@/components/session/ProjectHome': { ProjectHome: (props: any) => { homeRenders++; home = props; return null; } },
  '@/components/session/SessionConnecting': { SessionConnecting: (props: any) => { connecting = props; return null; } },
  '@/components/session/SessionPage': { SessionPage: (props: any) => { threadRenders++; thread = props; return null; } },
  '@/components/session/ProjectLeftDrawer': { ProjectLeftDrawer: (props: any) => { drawer = props; return null; } },
  '@/components/session/FloatingMenuButton': { FloatingMenuButton: Empty },
  '@/components/session/SessionActionsSheet': { SessionActionsSheet: React.forwardRef((props: any, _ref) => { actionsSheet = props; return null; }) },
  'react-native-drawer-layout': { Drawer: ({ children, renderDrawerContent }: any) => React.createElement(React.Fragment, null, renderDrawerContent(), children) },
  '@/stores/tab-store': { PAGE_TABS: { 'page:files-nav': { id: 'page:files-nav', label: 'Files' } }, useTabStore: Object.assign((selector: any) => selector(tab), { getState: () => tab, subscribe: () => () => {} }) },
  // One object, as the real context's value: stable callbacks across renders.
  '@/contexts/SandboxContext': { useSandboxContext: () => sandbox },
  '@/contexts': { useAuthContext: () => ({ user: null }) },
  '@/stores/last-project-store': { useLastProjectStore: { getState: () => ({ remember() {} }) } },
  '@/stores/push-store': { usePushStore: Object.assign((selector: any) => selector({ pendingOpen }), { getState: () => ({ setViewingSessionId() {}, takeOpen: (projectId: string) => { const open = pendingOpen?.projectId === projectId ? pendingOpen : null; if (open) pendingOpen = null; return open; } }) }) },
  '@/stores/upgrade-sheet-store': { useUpgradeSheetStore: (selector: any) => selector(upgradeStore) },
  '@/lib/projects/hooks': { useProject: () => ({ data: project }), useAccounts: () => ({ data: [] }), useProjectSessions: () => ({ data: [] }), useCreateProjectSession: () => ({ mutateAsync: async () => ({ session_id: 'fresh-1' }) }), projectKeys: { projectSessions: () => [], projectSessionsPaged: () => [] } },
  '@tanstack/react-query': { useQueryClient: () => queryClient },
  '@/lib/review/use-review': { useReviewItems: () => ({ data: reviewData }) },
  '@/lib/session/needs-you': { needsYouBySession: (items: any[]) => new Map(items.map((item) => [item.session_id, item])) },
  '@kortix/sdk': { countReviewItemsBySegment: () => ({ needs_you: 0 }), sessionConnectionLabel: () => null, SESSION_NOTICE: { waking: 'Waking' }, isRuntimeReady: () => false,
    sessionStartKey: (projectId: string, sessionId: string) => ['start', projectId, sessionId],
    getSessionHealth: async (url: string, init?: RequestInit) => { const res = await globalThis.fetch(`${url}/kortix/health`, init); return { status: res.status, ok: res.ok, health: await res.json(), body: '' }; } },
  '@/components/kortix/toast-provider': { useToast: () => ({ error: spy('toast') }) },
  '@/lib/billing/upgrade-gate': { getUpgradeGate: (error: any) => error?.upgrade ? { reason: 'upgrade' } : null },
  '@/lib/platform/client': { getSandboxUrl: (id: string) => `https://sandbox.test/p/${id}/8000` },
  '@/lib/projects/projects-client': { startProjectSession: (...args: any[]) => { spy('start')(...args); return response(); }, restartProjectSession: async (...args: any[]) => { spy('restart')(...args); }, deleteProjectSession: async (...args: any[]) => { spy('delete')(...args); } },
  '@/api/config': { getAuthToken: async () => 'token' },
  '@/lib/session/warm-session-pool': { warmSessionPool: { dropBySessionId: () => null, take: () => null }, appIsActive: () => false },
  '@/hooks/useWarmProjectSession': { useWarmProjectSession() {} },
  '@/lib/haptics': { haptics: { tap: spy('tap') } },
  '@/lib/logger': { log: { log() {}, warn() {}, error() {} } },
  '@kortix/sdk/react': { KortixProjectProvider: ({ children }: any) => children, useNotificationInbox: (options: any) => { inboxOptions = options; return inbox; } },
  '@/lib/notifications/inbox': { NOTIFICATION_INBOX_LIMIT: 50 },
  '@/hooks/useSavedCopy': { useSavedCopy: () => ({ messages: undefined, empty: false }) },
  '@/lib/session/session-store': { addOptimisticMessage: spy('optimistic'), markOptimisticAccepted() {}, sessionMessageIds: () => [], sessionRows: () => [], sessionStatus: () => undefined, setLocalSessionStatus() {} },
  '@/lib/notifications/registration': { requestPushPermissionOnce() {}, carryOverLegacyKinds: async () => { spy('carryOver')(); } },
  '@/stores/composer-draft-store': { clearComposerDraftIfSent: spy('clearDraft') },
  '@/lib/session/create-session': { createSessionCommitted: async () => 'fresh-1' },
  '@/lib/session/new-session-input': { newSessionCreateInput: () => ({}) },
  '@/lib/session/composer-draft': { draftKey: () => 'draft' },
  'expo-crypto': { randomUUID: () => 'fresh-1' },
  // A prompt with no paste tiles: the draft compare sees the text as sent.
  '@kortix/shared': { splitPastedContent: (text: string) => ({ text, pastes: [] }) },
};

for (const [, name] of source.matchAll(/from ['"]([^'"]+)['"]/g)) {
  if (name === 'react' || name === '@/lib/session/project-connect' || name.startsWith('@/lib/session/') && ['project-stack', 'connect-step', 'session-sandbox'].some((part) => name.endsWith(part)) || name === '@/components/session/use-project-stack' || name === '@/components/session/use-project-home-send') continue;
  const values = moduleMocks[name] ?? {};
  if (name !== 'react-native' && name !== 'expo-router' && name !== 'expo-router/react-navigation') {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const [, names] of source.matchAll(new RegExp(`import\\s*\\{([^}]+)\\}\\s*from\\s*['"]${escaped}['"]`, 'gs'))) {
      for (const item of names.split(',')) {
        const key = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0];
        if (key && !(key in values)) values[key] = Empty;
      }
    }
  }
  mock.module(name, () => ({ default: Empty, ...values }));
}
// A sub-page's module is required on first render (`Pages`), not imported.
const FilesNavPage = () => null;
mock.module('@/components/pages/FilesNavPage', () => ({ FilesNavPage }));

beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  ProjectScreen = (await import('./ProjectScreen')).ProjectScreen;
});
beforeEach(() => {
  calls.length = 0;
  homeRenders = 0;
  threadRenders = 0;
  reviewData = [];
  route = drawer = home = connecting = back = stackListener = thread = actionsSheet = inboxOptions = pendingOpen = undefined;
  inbox = { isSuccess: true, unreadCount: 2, markSessionRead: async (sessionId: string) => { spy('markSessionRead')(sessionId); } };
  // KRTX-1742 cases run with the project's `notification_center` flag on; the flag-off cases say so.
  project = { project_id: 'project-1', experimental: { notification_center: true } };
  tab = { activeSessionId: null, activePageId: null, setScope: spy('scope'), navigateToSession: spy('navigateSession') };
  routes = [{ key: 'home-key', name: 'index', params: { id: 'project-1' } }];
  response = async () => ({ stage: 'ready', retriable: false, failure: null, opencode_session_id: 'oc-1', sandbox: { status: 'active', external_id: 'box-1', sandbox_id: 'box-1' } });
  health = async () => ({ ok: true, status: 200, json: async () => ({ runtimeReady: true }) });
  globalThis.fetch = (async (...args: any[]) => { spy('health')(...args); return health(); }) as any;
});
afterEach(async () => { if (tree) await act(async () => tree?.unmount()); tree = undefined; });

async function renderHook() { await act(async () => { tree = create(React.createElement(ProjectScreen)); }); }
async function rerender() { await act(async () => { tree?.update(React.createElement(ProjectScreen)); }); }
async function focus(names: string[]) {
  routes = names.map((name, index) => ({ key: `${name}-${index}`, name, params: { id: 'project-1' } }));
  await act(async () => stackListener({ route: routes.at(-1), navigation: top }).focus());
}

describe('ProjectScreen connect and stack', () => {
  test('opens the pinned thread and switches the sandbox before store navigation without awaiting ready health', async () => {
    let finish!: (value: any) => void;
    health = () => new Promise((resolve) => { finish = resolve; });
    await renderHook();
    await act(async () => drawer.onOpenProjectSession({ session_id: 'ps-1' }));
    expect(seen('start')[0]?.args).toEqual(['project-1', 'ps-1']);
    expect(seen('switchSandbox')[0]?.args[0]).toMatchObject({ external_id: 'box-1', status: 'running' });
    // The SDK binds to the session the sandbox runs, and starts from this `/start` answer.
    expect(seen('switchSandbox')[0]?.args[1]).toEqual({ projectId: 'project-1', sessionId: 'ps-1' });
    expect(seen('setQueryData')[0]?.args).toEqual([['start', 'project-1', 'ps-1'], expect.objectContaining({ stage: 'ready' })]);
    expect(seen('navigateSession').at(-1)?.args).toEqual(['oc-1']);
    expect(seen('health')).toHaveLength(1);
    await act(async () => finish({ ok: true, status: 200, json: async () => ({ runtimeReady: true }) }));
  });

  test('cancel deletes a fresh session and restores its prompt once; reopened sessions are not deleted', async () => {
    response = () => new Promise(() => {});
    await renderHook();
    await act(async () => { expect(await home.onSubmitNewSession({ text: 'hello', files: [], fileParts: [], model: null, picks: null, agent: null })).toBe(true); });
    await act(async () => connecting.onCancel());
    expect(seen('delete')[0]?.args).toEqual(['project-1', 'fresh-1']);
    expect(home.takeInitialDraft()).toEqual({ text: 'hello', files: [] });
    expect(home.takeInitialDraft()).toEqual({ text: '', files: [] });
    await act(async () => drawer.onOpenProjectSession({ session_id: 'old-1' }));
    await act(async () => connecting.onCancel());
    expect(seen('delete')).toHaveLength(1);
  });

  test('restart clears the error guard and calls /start again', async () => {
    response = async () => ({ stage: 'failed', retriable: false, failure: { message: 'boot failed' }, sandbox: null });
    await renderHook();
    await act(async () => drawer.onOpenProjectSession({ session_id: 'ps-1' }));
    expect(connecting.error).toBeTruthy();
    expect(seen('start')).toHaveLength(1);
    await act(async () => connecting.onRestart());
    expect(seen('restart')[0]?.args).toEqual(['project-1', 'ps-1']);
    expect(seen('start')).toHaveLength(2);
  });

  test('upgrade opens the sheet; awaited health boot errors stop before sandbox switch', async () => {
    response = async () => { throw Object.assign(new Error('payment required'), { upgrade: true }); };
    await renderHook();
    await act(async () => drawer.onOpenProjectSession({ session_id: 'ps-1' }));
    expect(seen('upgrade')).toHaveLength(1);
    response = async () => ({ stage: 'starting', retriable: true, failure: null, opencode_session_id: 'oc-1', sandbox: { status: 'active', external_id: 'box-1' } });
    health = async () => ({ ok: true, status: 200, json: async () => ({ boot_error: 'runtime failed' }) });
    await act(async () => drawer.onOpenProjectSession({ session_id: 'ps-2' }));
    expect(connecting.error).toMatchObject({ title: 'Session runtime is not ready', detail: 'runtime failed' });
    expect(seen('switchSandbox')).toHaveLength(0);
  });

  test('drawer dispatches push, replace, popTo and reset', async () => {
    await renderHook();
    await focus(['index']);
    await act(async () => drawer.onNavigateRoute('files'));
    expect(seen('dispatch').at(-1)?.args[0].type).toBe('push');
    await focus(['index', 'view']);
    await act(async () => drawer.onNavigateRoute('files'));
    expect(seen('dispatch').at(-1)?.args[0].type).toBe('replace');
    await focus(['index', 'files', 'page']);
    await act(async () => drawer.onNavigateRoute('files'));
    expect(seen('dispatch').at(-1)?.args[0].type).toBe('popTo');
    await act(async () => drawer.onNavigateRoute('sessions'));
    expect(seen('dispatch').at(-1)?.args[0]).toMatchObject({ type: 'reset', value: { index: 1, routes: [{ name: 'index' }, { name: 'sessions' }] } });
  });

  test('Android back closes drawer, pops sub-pages, returns from covering route and defers home', async () => {
    await renderHook();
    await focus(['index', 'files']);
    await act(async () => route.openDrawer());
    await act(async () => { expect(back?.()).toBe(true); });
    expect(route.isDrawerOpen).toBe(false);
    await focus(['index', 'files', 'page']);
    await act(async () => { expect(back?.()).toBe(true); });
    expect(seen('backSubPage')).toHaveLength(1);
    await focus(['index', 'files']);
    await act(async () => { expect(back?.()).toBe(true); });
    expect(seen('dispatch').at(-1)?.args[0].type).toBe('popTo');
    await focus(['index']);
    expect(back?.()).toBe(false);
  });

  test('the Files row pushes the Files sub-page over the thread; back pops to the thread', async () => {
    tab.activeSessionId = 'oc-1';
    await renderHook();
    await focus(['index', 'view']);
    await act(async () => actionsSheet.onOpenFiles());
    expect(seen('dispatch').at(-1)?.args[0]).toEqual({ type: 'push', args: ['page', { id: 'project-1', pageId: 'page:files-nav' }] });
    const onBack = () => {};
    const page = route.renderSubPage('page:files-nav', onBack);
    expect(page.type).toBe(FilesNavPage);
    expect(page.props).toMatchObject({ projectId: 'project-1', onBack, page: { id: 'page:files-nav' } });
    // The sub-page records the open thread; the same thread keeps it there.
    expect(route.viewKey).toBe('session:oc-1');
    await focus(['index', 'view', 'page']);
    await act(async () => { expect(back?.()).toBe(true); });
    expect(seen('backSubPage')).toHaveLength(1);
  });

  test('the route value carries the open target: null on home', async () => {
    await renderHook();
    expect(route.viewKey).toBeNull();
  });

  test('opening the drawer does not re-render project home', async () => {
    await renderHook();
    const before = homeRenders;
    await act(async () => route.openDrawer());
    expect(route.isDrawerOpen).toBe(true);
    expect(homeRenders).toBe(before);
  });

  test('opening and closing the drawer does not re-render the open thread', async () => {
    tab.activeSessionId = 'oc-1';
    await renderHook();
    expect(threadRenders).toBeGreaterThan(0);
    // SessionPage never reads the drawer state, so it is not passed.
    expect('isDrawerOpen' in thread).toBe(false);
    const before = threadRenders;
    await act(async () => route.openDrawer());
    expect(route.isDrawerOpen).toBe(true);
    await act(async () => drawer.onClose());
    expect(route.isDrawerOpen).toBe(false);
    expect(threadRenders).toBe(before);
  });

  test('the route value keeps its identity when its inputs are unchanged', async () => {
    await renderHook();
    const before = route;
    // Opening the switcher re-renders the screen; nothing the routes read changes.
    await act(async () => drawer.onOpenSwitcher());
    expect(route).toBe(before);
    await act(async () => route.openDrawer());
    expect(route).not.toBe(before);
    expect(route.isDrawerOpen).toBe(true);
  });

  test('the drawer gets the unread notification count from the inbox', async () => {
    await renderHook();
    expect(inboxOptions).toMatchObject({ limit: 50, enabled: true });
    expect(drawer.notificationsEnabled).toBe(true);
    expect(drawer.notificationsUnreadCount).toBe(2);
  });

  test("a flag-on project carries this phone's opt-outs into the user's record", async () => {
    await renderHook();
    expect(seen('carryOver')).toHaveLength(1);
  });

  test('notification_center off: no inbox poll, no drawer pill, no read, no carry-over', async () => {
    project = { project_id: 'project-1', experimental: { notification_center: false } };
    // The disabled query is not `isSuccess`.
    inbox = { ...inbox, isSuccess: false, unreadCount: 0 };
    await renderHook();
    expect(inboxOptions).toMatchObject({ enabled: false });
    expect(drawer.notificationsEnabled).toBe(false);
    await act(async () => drawer.onOpenProjectSession({ session_id: 'ps-1' }));
    expect(seen('markSessionRead')).toHaveLength(0);
    expect(seen('carryOver')).toHaveLength(0);
  });

  test('while the project loads the flag reads off; once it loads on, the session on screen is read', async () => {
    project = undefined;
    inbox = { ...inbox, isSuccess: false, unreadCount: 0 };
    response = () => new Promise(() => {});
    await renderHook();
    expect(inboxOptions).toMatchObject({ enabled: false });
    expect(drawer.notificationsEnabled).toBe(false);
    await act(async () => drawer.onOpenProjectSession({ session_id: 'ps-1' }));
    expect(seen('markSessionRead')).toHaveLength(0);
    project = { project_id: 'project-1', experimental: { notification_center: true } };
    await rerender();
    expect(drawer.notificationsEnabled).toBe(true);
    expect(seen('markSessionRead').map((call) => call.args)).toEqual([['ps-1']]);
    expect(seen('carryOver')).toHaveLength(1);
  });

  test('opening a session marks its notifications read', async () => {
    await renderHook();
    expect(seen('markSessionRead')).toHaveLength(0);
    await act(async () => drawer.onOpenProjectSession({ session_id: 'ps-1' }));
    expect(seen('markSessionRead').map((call) => call.args)).toEqual([['ps-1']]);
  });

  test('a new unread notification of the session on screen is marked read; other sessions are not', async () => {
    // `/start` never answers: ps-1 stays on screen, connecting.
    response = () => new Promise(() => {});
    await renderHook();
    await act(async () => drawer.onOpenProjectSession({ session_id: 'ps-1' }));
    expect(seen('markSessionRead')).toHaveLength(1);
    // A refetch (a push that arrived, a return to the app) shows a new unread row of another session.
    inbox = { ...inbox, data: { notifications: [{ id: 'n-1', session_id: 'ps-2', read: false }] } };
    await rerender();
    expect(seen('markSessionRead')).toHaveLength(1);
    // Then one of the session on screen.
    inbox = { ...inbox, data: { notifications: [{ id: 'n-2', session_id: 'ps-1', read: false }] } };
    await rerender();
    expect(seen('markSessionRead').map((call) => call.args)).toEqual([['ps-1'], ['ps-1']]);
    // Marked read: nothing more is sent.
    inbox = { ...inbox, data: { notifications: [{ id: 'n-2', session_id: 'ps-1', read: true }] } };
    await rerender();
    expect(seen('markSessionRead')).toHaveLength(2);
  });

  test('a failed read that restores the same unread row is not sent again', async () => {
    response = () => new Promise(() => {});
    const row = { id: 'n-1', session_id: 'ps-1', read: false };
    inbox = { ...inbox, data: { notifications: [row] }, markSessionRead: async (sessionId: string) => { spy('markSessionRead')(sessionId); throw new Error('503'); } };
    await renderHook();
    await act(async () => drawer.onOpenProjectSession({ session_id: 'ps-1' }));
    expect(seen('markSessionRead')).toHaveLength(1);
    // The SDK writes the row read before the POST, then restores it when the POST fails.
    for (let cycle = 0; cycle < 3; cycle++) {
      inbox = { ...inbox, data: { notifications: [{ ...row, read: true }] } };
      await rerender();
      inbox = { ...inbox, data: { notifications: [row] } };
      await rerender();
    }
    expect(seen('markSessionRead')).toHaveLength(1);
  });

  test('after a failed read, a new unread row of the session on screen is sent once', async () => {
    response = () => new Promise(() => {});
    const row = { id: 'n-1', session_id: 'ps-1', read: false };
    inbox = { ...inbox, data: { notifications: [row] }, markSessionRead: async (sessionId: string) => { spy('markSessionRead')(sessionId); throw new Error('503'); } };
    await renderHook();
    await act(async () => drawer.onOpenProjectSession({ session_id: 'ps-1' }));
    inbox = { ...inbox, data: { notifications: [{ ...row, read: true }] } };
    await rerender();
    inbox = { ...inbox, data: { notifications: [row] } };
    await rerender();
    expect(seen('markSessionRead')).toHaveLength(1);
    // A push arrived and the inbox refetched: a newer row of ps-1, listed first.
    const newer = { id: 'n-2', session_id: 'ps-1', read: false };
    inbox = { ...inbox, data: { notifications: [newer, row] } };
    await rerender();
    expect(seen('markSessionRead').map((call) => call.args)).toEqual([['ps-1'], ['ps-1']]);
    // That read fails too and restores both rows: nothing more is sent.
    inbox = { ...inbox, data: { notifications: [{ ...newer, read: true }, { ...row, read: true }] } };
    await rerender();
    inbox = { ...inbox, data: { notifications: [newer, row] } };
    await rerender();
    expect(seen('markSessionRead')).toHaveLength(2);
  });

  test('with nothing unread, opening a session sends no read', async () => {
    inbox = { ...inbox, unreadCount: 0 };
    await renderHook();
    await act(async () => drawer.onOpenProjectSession({ session_id: 'ps-1' }));
    expect(seen('markSessionRead')).toHaveLength(0);
  });

  test('a tapped session notification opens its session', async () => {
    await renderHook();
    pendingOpen = { projectId: 'project-1', sessionId: 'ps-7', navigated: true };
    await act(async () => drawer.onOpenSwitcher());
    expect(pendingOpen).toBeNull();
    expect(seen('start').at(-1)?.args).toEqual(['project-1', 'ps-7']);
  });

  test('a tapped alert without a session returns the project to its home', async () => {
    await renderHook();
    await focus(['index', 'inbox']);
    pendingOpen = { projectId: 'project-1', sessionId: null, navigated: true };
    await act(async () => drawer.onOpenSwitcher());
    expect(pendingOpen).toBeNull();
    const action = seen('dispatch').at(-1)?.args[0];
    expect([action?.type, action?.args[0]]).toEqual(['popTo', 'index']);
    expect(seen('start')).toHaveLength(0);
  });

  test('the drawer gets the latest Needs you sessions', async () => {
    await renderHook();
    expect([...drawer.needsYouBySession.keys()]).toEqual([]);
    reviewData = [{ session_id: 'ps-9' }];
    await act(async () => drawer.onOpenSwitcher());
    expect([...drawer.needsYouBySession.keys()]).toEqual(['ps-9']);
  });
});
