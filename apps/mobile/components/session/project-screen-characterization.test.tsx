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
let tree: ReactTestRenderer | undefined;
let ProjectScreen: typeof import('./ProjectScreen').ProjectScreen;

const top = { getState: () => ({ routes }), dispatch: spy('dispatch') };
const root = { dispatch: spy('rootDispatch'), canGoBack: () => false };
const moduleMocks: Record<string, Record<string, any>> = {
  'react-native': { View: ({ children }: any) => children, Platform: { OS: 'android' }, BackHandler: { addEventListener: (_: string, callback: () => boolean) => { back = callback; return { remove: () => { back = undefined; } }; } } },
  'expo-router': { Stack: Object.assign(({ children, screenListeners }: any) => { if (screenListeners) stackListener = screenListeners; return children; }, { Screen: Empty }), useIsFocused: () => true, useLocalSearchParams: () => ({ id: 'project-1' }), useRouter: () => ({ push: spy('routerPush') }) },
  'expo-router/react-navigation': { useFocusEffect: (callback: () => void) => React.useEffect(callback, [callback]), useNavigation: () => root,
    StackActions: { push: (...args: any[]) => ({ type: 'push', args }), replace: (...args: any[]) => ({ type: 'replace', args }), popTo: (...args: any[]) => ({ type: 'popTo', args }) },
    CommonActions: { reset: (value: any) => ({ type: 'reset', value }) } },
  '@/components/session/ProjectRoutes': { PROJECT_HOME_ROUTE: 'index', PROJECT_VIEW_ROUTE: 'view', PROJECT_PAGE_ROUTE: 'page', PROJECT_SESSIONS_ROUTE: 'sessions', PROJECT_FILES_ROUTE: 'files', PROJECT_ACCOUNT_ROUTE: 'account', ProjectRouteProvider: ({ value, children }: any) => { route = value; return React.createElement(React.Fragment, null, value.home, value.view, children); }, backFromSubPage: spy('backSubPage') },
  '@/components/session/ProjectHome': { ProjectHome: (props: any) => { home = props; return null; } },
  '@/components/session/SessionConnecting': { SessionConnecting: (props: any) => { connecting = props; return null; } },
  '@/components/session/SessionPage': { SessionPage: Empty },
  '@/components/session/ProjectLeftDrawer': { ProjectLeftDrawer: (props: any) => { drawer = props; return null; } },
  '@/components/session/FloatingMenuButton': { FloatingMenuButton: Empty },
  'react-native-drawer-layout': { Drawer: ({ children, renderDrawerContent }: any) => React.createElement(React.Fragment, null, renderDrawerContent(), children) },
  '@/stores/tab-store': { PAGE_TABS: {}, useTabStore: Object.assign((selector: any) => selector(tab), { getState: () => tab, subscribe: () => () => {} }) },
  '@/contexts/SandboxContext': { useSandboxContext: () => ({ sandboxUrl: null, switchSandbox: spy('switchSandbox'), clearSandbox: spy('clearSandbox') }) },
  '@/contexts': { useAuthContext: () => ({ user: null }) },
  '@/stores/last-project-store': { useLastProjectStore: { getState: () => ({ remember() {} }) } },
  '@/stores/push-store': { usePushStore: Object.assign((selector: any) => selector({ pendingOpen: null }), { getState: () => ({ setViewingSessionId() {}, takeOpen: () => null }) }) },
  '@/stores/upgrade-sheet-store': { useUpgradeSheetStore: (selector: any) => selector({ openUpgradeSheet: spy('upgrade') }) },
  '@/lib/projects/hooks': { useProject: () => ({ data: null }), useAccounts: () => ({ data: [] }), useProjectSessions: () => ({ data: [] }), useCreateProjectSession: () => ({ mutateAsync: async () => ({ session_id: 'fresh-1' }) }), projectKeys: { projectSessions: () => [], projectSessionsPaged: () => [] } },
  '@tanstack/react-query': { useQueryClient: () => ({ invalidateQueries: spy('invalidate') }) },
  '@/lib/review/use-review': { useReviewItems: () => ({ data: [] }) },
  '@kortix/sdk': { countReviewItemsBySegment: () => ({ needs_you: 0 }), sessionConnectionLabel: () => null, SESSION_NOTICE: { waking: 'Waking' }, isRuntimeReady: () => false,
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
  '@/lib/opencode/sync-store': { useSyncStore: Object.assign((selector: any) => selector({ messages: {} }), { getState: () => ({ messages: {} }) }) },
  '@/lib/session/saved-copy': { loadSavedCopy: async () => ({ empty: false }) },
  '@/lib/notifications/registration': { requestPushPermissionOnce() {} },
  '@/stores/composer-draft-store': { clearComposerDraftIfSent: spy('clearDraft') },
  '@/lib/session/create-session': { createSessionCommitted: async () => 'fresh-1' },
  '@/lib/session/new-session-input': { newSessionCreateInput: () => ({}) },
  '@/lib/session/composer-draft': { draftKey: () => 'draft' },
  'expo-crypto': { randomUUID: () => 'fresh-1' },
};

for (const [, name] of source.matchAll(/from ['"]([^'"]+)['"]/g)) {
  if (name === 'react' || name === '@/lib/session/project-connect' || name.startsWith('@/lib/session/') && ['project-stack', 'connect-step'].some((part) => name.endsWith(part)) || name === '@/components/session/use-project-stack' || name === '@/components/session/use-project-home-send') continue;
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

beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  ProjectScreen = (await import('./ProjectScreen')).ProjectScreen;
});
beforeEach(() => {
  calls.length = 0;
  route = drawer = home = connecting = back = stackListener = undefined;
  tab = { activeSessionId: null, activePageId: null, setScope: spy('scope'), navigateToSession: spy('navigateSession') };
  routes = [{ key: 'home-key', name: 'index', params: { id: 'project-1' } }];
  response = async () => ({ stage: 'ready', retriable: false, failure: null, opencode_session_id: 'oc-1', sandbox: { status: 'active', external_id: 'box-1', sandbox_id: 'box-1' } });
  health = async () => ({ ok: true, status: 200, json: async () => ({ runtimeReady: true }) });
  globalThis.fetch = (async (...args: any[]) => { spy('health')(...args); return health(); }) as any;
});
afterEach(async () => { if (tree) await act(async () => tree?.unmount()); tree = undefined; });

async function renderHook() { await act(async () => { tree = create(React.createElement(ProjectScreen)); }); }
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
});
