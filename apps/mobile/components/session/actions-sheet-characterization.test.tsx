/**
 * Characterization tests for `SessionActionsSheet`'s two AfterClose flows —
 * session delete and compact (KRTX-774, extracted from the sheet into
 * `SessionDeleteDialog` and `SessionCompactConfirm`).
 *
 * The real sheet runs with React Query real (the optimistic delete write and
 * its undo go through the real cache), the tab and session stores real, and
 * the sheet chrome (`KortixBottomSheetModal`, the settings rows, the
 * `AlertDialog` parts) mocked as recorders. The gorhom sheet mock separates
 * "dismiss requested" from "dismiss finished": the test fires `onDismiss`
 * itself, so "the confirm opens only after the sheet's dismiss animation" is
 * an observed behavior, not a source-text claim. The tests fail when the
 * delete/compact behavior changes — never when code moves between files.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { type ReactTestRenderer, act, create } from 'react-test-renderer';

// One in-memory AsyncStorage for every store this file loads — the shared
// module is the only place allowed to register that mock (see
// stores/in-memory-async-storage.ts). Import it before any store import.
import '@/stores/in-memory-async-storage';
// Namespace imports: a module an earlier test file stub-replaced hands back an
// incomplete namespace, and a named import of a name it lacks would crash this
// file at load. Destructuring keeps every missing name `undefined` — the
// registry guard below reads them instead of crashing.
import * as sdkReactModule from '@kortix/sdk/react';
import * as tabStoreModule from '@/stores/tab-store';
import * as runtimeCapsModule from '@/lib/session/runtime-capabilities';
const { useSessionStateStore } = sdkReactModule;
const { useTabStore } = tabStoreModule;
const { recordRuntimeCapabilities } = runtimeCapsModule;
// The real close-then hook, re-exported through the mocked sheet module below.
import { useCloseThen } from '@/components/kortix/use-close-then';
// Type-only: erased at load, so the real projects-client (and its `@/api/config`
// chain) never loads before the mocks below are registered.
import type { ProjectSession } from '@/lib/projects/projects-client';

// Metro injects `__DEV__`; expo-router's module init reads it.
(globalThis as { __DEV__?: boolean }).__DEV__ = true;

const PID = 'proj-1';
const SID = 'sess-1';
const ROOT_ID = 'rt-sess-1'; // the tab id: `runtime_session_id ?? opencode_session_id`
const SANDBOX = 'https://sandbox.test';

// ── Module mocks ─────────────────────────────────────────────────────────────

const Empty = () => null;

// Toast and haptics record what the flows did.
const toastCalls: { kind: string; message: string }[] = [];
const toastApi = {
  error: (message: string) => toastCalls.push({ kind: 'error', message }),
  success: (message: string) => toastCalls.push({ kind: 'success', message }),
  info: (message: string) => toastCalls.push({ kind: 'info', message }),
};
const hapticCalls: string[] = [];
const hapticsStub = {
  tap: () => hapticCalls.push('tap'),
  medium: () => hapticCalls.push('medium'),
  warning: () => hapticCalls.push('warning'),
  success: () => hapticCalls.push('success'),
};

// The sheet's rows, by label (recorder: re-render pushes the same row again).
const rows: { label: string; onPress?: () => void; disabled?: boolean; destructive?: boolean }[] = [];

// The delete AlertDialog's live state and text.
let alertDialog: { open: boolean; onOpenChange?: (open: boolean) => void } | null = null;
const dialogText = { title: '', description: '' };

// Every design-system Button the tree mounts (the dialog's Cancel and Delete).
const buttons: { variant?: string; onPress?: () => void; disabled?: boolean }[] = [];

// The compact confirm request and the summarize mutation.
const confirmCalls: { title: string; description?: string; confirmLabel: string; onConfirm: () => void }[] = [];
const compactMutations: { target: unknown; onError?: (error: unknown) => void }[] = [];
const compactApi = {
  mutate: (target: unknown, opts?: { onError?: (error: unknown) => void }) =>
    compactMutations.push({ target, onError: opts?.onError }),
};

// `deleteProjectSession`: the test decides what the server does per call.
type DeleteBehavior = 'ok' | 'fail' | 'hang';
let deleteBehavior: DeleteBehavior = 'ok';
let deleteCalls: { projectId: string; sessionId: string }[] = [];
let releaseDelete: (value: unknown) => void = () => {};
const deleteProjectSessionStub = (projectId: string, sessionId: string) => {
  deleteCalls.push({ projectId, sessionId });
  if (deleteBehavior === 'ok') return Promise.resolve({});
  if (deleteBehavior === 'fail') return Promise.reject(new Error('offline'));
  return new Promise((resolve) => {
    releaseDelete = resolve;
  });
};

// ── React Native stand-ins (same shape as the SessionPage harness) ───────────
const anyStub: any = new Proxy(
  function stub() {
    return null;
  },
  {
    get(target: any, prop: string | symbol) {
      if (prop === Symbol.toPrimitive) return () => 0;
      if (typeof prop === 'string' && !(prop in target)) target[prop] = anyStub;
      return target[prop];
    },
    apply() {
      return null;
    },
    construct() {
      return {};
    },
  },
);

const rnNative: Record<string, any> = {
  View: (props: any) => props.children ?? null,
  ScrollView: (props: any) => props.children ?? null,
  FlatList: (props: any) => props.children ?? null,
  Text: (props: any) => props.children ?? null,
  Pressable: (props: any) => props.children ?? null,
  Keyboard: { dismiss: () => {} },
  Animated: {
    Value: class {
      value = 0;
      setValue(v: number) {
        this.value = v;
      }
    },
    timing: () => ({ start: (done?: (r: { finished: boolean }) => void) => done?.({ finished: true }) }),
    View: (props: any) => props.children ?? null,
  },
  Easing: { out: (x: any) => x, cubic: () => 0, bezier: () => 0 },
  Platform: { OS: 'ios', select: (o: any) => o.ios },
  NativeModules: {},
  BackHandler: { addEventListener: () => ({ remove() {} }), removeEventListener() {} },
  StyleSheet: { create: (s: any) => s, flatten: (s: any) => s, hairlineWidth: 1 },
  Dimensions: { get: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }) },
  I18nManager: { isRTL: false, allowRTL() {}, forceRTL() {} },
  PixelRatio: { get: () => 3, getFontScale: () => 1 },
  DeviceEventEmitter: { addListener: () => ({ remove() {} }), emit() {} },
  NativeEventEmitter: class {
    addListener() {
      return { remove() {} };
    }
    removeAllListeners() {}
  },
  InteractionManager: { runAfterInteractions: (cb: any) => (cb?.(), { cancel() {} }) },
  TurboModuleRegistry: { get: () => anyStub, getEnforcing: () => anyStub },
  Linking: { openURL: () => {}, canOpenURL: async () => true, addEventListener: () => ({ remove() {} }) },
  Appearance: { getColorScheme: () => 'light', addChangeListener: () => ({ remove() {} }) },
  LayoutAnimation: { configureNext() {}, easeInEaseOut() {} },
  findNodeHandle: () => null,
  processColor: (color: any) => color,
  unstable_batchedUpdates: (cb: any) => cb?.(),
  AppState: { addEventListener: () => ({ remove: () => {} }) },
};
const rnModule = new Proxy(rnNative, {
  get(target: any, prop: string | symbol) {
    if (typeof prop === 'string' && !(prop in target)) target[prop] = anyStub;
    return target[prop];
  },
});

const host = (props: any) => props.children ?? null;

// ── The sheet chrome, as recorders ───────────────────────────────────────────

// The gorhom modal: children render; the imperative ref records; `onDismiss`
// stays the test's to fire (the close animation's end).
let sheetProps: { onDismiss?: () => void } | null = null;
const sheetCalls: string[] = [];
const FakeSheetModal = React.forwardRef(function FakeSheetModal(props: any, ref: any) {
  sheetProps = props;
  React.useImperativeHandle(
    ref,
    () => ({
      present: () => sheetCalls.push('present'),
      dismiss: () => sheetCalls.push('dismiss'),
      snapToPosition: (v: unknown) => sheetCalls.push(`snapToPosition:${String(v)}`),
      snapToIndex: (v: unknown) => sheetCalls.push(`snapToIndex:${String(v)}`),
      close: () => sheetCalls.push('close'),
    }),
    [],
  );
  return props.children ?? null;
});

mock.module('react-native', () => rnModule);
mock.module('react-native-reanimated', () => ({
  default: { View: host },
  View: host,
  Easing: { bezier: () => 0 },
  useAnimatedStyle: () => ({}),
  useReducedMotion: () => false,
  useSharedValue: (v: number) => ({ value: v }),
  withTiming: (v: number) => v,
  interpolate: () => 0,
}));
mock.module('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
mock.module('@gorhom/bottom-sheet', () => ({
  BottomSheetScrollView: host,
  BottomSheetView: host,
  BottomSheetModal: host,
}));
mock.module('@/lib/icons', () => ({
  GitDiffIcon: Empty,
  GitPullRequestIcon: Empty,
  PencilIcon: Empty,
  ArrowCounterClockwiseIcon: Empty,
  ShareNetworkIcon: Empty,
  SquareIcon: Empty,
  StackIcon: Empty,
  TrashIcon: Empty,
  Icon: Empty,
}));
mock.module('@/components/ui/text', () => ({ Text: (props: any) => props.children ?? null }));
mock.module('@/components/ui/button', () => ({
  Button: (props: any) => {
    buttons.push(props);
    return props.children ?? null;
  },
}));
mock.module('@/components/ui/alert-dialog', () => ({
  AlertDialog: (props: any) => {
    alertDialog = { open: props.open, onOpenChange: props.onOpenChange };
    return props.children ?? null;
  },
  AlertDialogContent: host,
  AlertDialogHeader: host,
  AlertDialogFooter: host,
  AlertDialogCancel: host,
  AlertDialogTitle: (props: any) => {
    dialogText.title = String(props.children ?? '');
    return null;
  },
  AlertDialogDescription: (props: any) => {
    dialogText.description = String(props.children ?? '');
    return null;
  },
}));
mock.module('@/components/kortix/settings-list', () => ({
  SettingsGroup: host,
  SettingsRow: (props: any) => {
    rows.push(props);
    return null;
  },
}));
mock.module('@/components/kortix/sheet', () => ({
  useCloseThen,
  KortixBottomSheetModal: FakeSheetModal,
}));
mock.module('react-native-gesture-handler', () => ({
  State: { UNDETERMINED: 0, FAILED: 1, BEGAN: 2, CANCELLED: 3, ACTIVE: 4, END: 5 },
  GestureHandlerRootView: host,
  ScrollView: host,
  Pressable: host,
}));
mock.module('@/components/kortix/sheet-push', () => ({
  POP_IN: undefined,
  PUSH_IN: undefined,
  SheetBackButton: Empty,
}));
mock.module('@/components/kortix/toast-provider', () => ({ useToast: () => toastApi }));
mock.module('@/components/kortix/confirm-dialog', () => ({
  useConfirmDialog: () => ({
    confirm: (request: (typeof confirmCalls)[number]) => confirmCalls.push(request),
    dialog: null,
  }),
}));
mock.module('@/components/session/SessionChangesView', () => ({
  SessionChangesList: Empty,
  SessionChangeFileView: Empty,
}));
mock.module('@/components/session/SessionRenameForm', () => ({ SessionRenameForm: Empty }));
mock.module('@/components/session/SessionShareForm', () => ({ SessionShareForm: Empty }));
mock.module('@/components/session/SessionPublicShareRows', () => ({
  SessionShareLinkConfirm: Empty,
  PUBLIC_SHARE_CONFIRM_TITLE: { 'create-link': 'Create a public link?', 'stop-link': 'Stop sharing link' },
}));
mock.module('@/components/session/SessionRuntime', () => ({
  useSessionRuntime: () => ({ switched: true, runtimeSessionId: ROOT_ID, isCompacting: false }),
}));
mock.module('@/hooks/useSessionChanges', () => ({
  useSessionChanges: () => ({
    data: { files: [], count: 0, additions: 0, deletions: 0 },
    isPending: false,
    isError: false,
    refetch: () => {},
  }),
}));
mock.module('@/contexts/SandboxContext', () => ({ useSandboxContext: () => ({ sandboxUrl: SANDBOX }) }));
mock.module('@/lib/haptics', () => ({ haptics: hapticsStub }));
mock.module('@/lib/logger', () => ({
  log: { log() {}, warn() {}, error() {}, info() {} },
  setLoggerUserId() {},
  setLogLevel() {},
}));
mock.module('@/api/config', () => ({
  API_URL: 'https://api.test',
  getAuthToken: async () => 'token-1',
  getAuthHeaders: async () => ({}),
}));

// Top-level await, after the mocks: the hooks module binds `@/api/config`,
// whose real file would pull the native chain this file mocks. `projectKeys`
// is `undefined` when an earlier test file stub-replaced this module — the
// registry guard below reads that instead of crashing.
const hooksModule = await import('@/lib/projects/hooks');
const { projectKeys } = hooksModule;

// ── Harness ──────────────────────────────────────────────────────────────────

let SessionActionsSheet: typeof import('./SessionActionsSheet').SessionActionsSheet;

type SheetRef = React.RefObject<{ present: (session: ProjectSession) => void } | null>;

const session = (overrides: Partial<Record<string, unknown>> = {}): ProjectSession =>
  ({
    session_id: SID,
    name: 'Deploy checklist',
    custom_name: null,
    opencode_session_id: 'oc-sess-1',
    runtime_session_id: ROOT_ID,
    can_manage_lifecycle: true,
    can_manage_sharing: true,
    base_ref: 'main',
    ...overrides,
  }) as unknown as ProjectSession;

let tree: ReactTestRenderer | undefined;
let queryClient: QueryClient;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const renderSheet = async (): Promise<SheetRef> => {
  queryClient = new QueryClient();
  const ref = React.createRef<{ present: (session: ProjectSession) => void }>();
  await act(async () => {
    tree = create(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(SessionActionsSheet, { projectId: PID, ref }),
      ),
    );
  });
  return ref;
};

/** Open the sheet for `target`, tap the Delete row, and finish the dismiss. */
const openDeleteConfirm = async (target: ProjectSession, ref: SheetRef) => {
  await act(async () => {
    ref.current?.present(target);
    await sleep(5);
  });
  const deleteRow = () => rows.find((row) => row.label === 'Delete session');
  expect(deleteRow()).toBeTruthy();
  await act(async () => {
    deleteRow()?.onPress?.();
    await sleep(5);
  });
  // The sheet was dismissed, and the confirm is not up yet.
  expect(sheetCalls).toContain('dismiss');
  expect(alertDialog?.open).toBe(false);
  await act(async () => {
    sheetProps?.onDismiss?.();
    await sleep(5);
  });
  expect(alertDialog?.open).toBe(true);
};

// The freshest render's props: an earlier render's Button closure still reads
// the state it was created with, so the last recorded one is the live one.
const destructiveButton = () => buttons.findLast((button) => button.variant === 'destructive');

const pagedIds = () => {
  const cached = queryClient.getQueryData(projectKeys.projectSessionsPaged(PID)) as unknown as
    | { pages: { items: { session_id: string }[] }[] }
    | undefined;
  return cached?.pages.map((page) => page.items.map((row) => row.session_id));
};

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    (globalThis as any).requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
    (globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
  }

  // The real SDK React surface, with only the summarize hook overridden: the
  // session store the busy re-check reads stays real.
  const sdkReact = await import('@kortix/sdk/react');
  mock.module('@kortix/sdk/react', () => ({
    ...sdkReact,
    useSummarizeRuntimeSession: () => compactApi,
  }));

  // The real projects client, with only `deleteProjectSession` overridden.
  const projectsClient = await import('@/lib/projects/projects-client');
  mock.module('@/lib/projects/projects-client', () => ({
    ...projectsClient,
    deleteProjectSession: deleteProjectSessionStub,
  }));

  ({ SessionActionsSheet } = await import('./SessionActionsSheet'));
});

beforeEach(() => {
  // Wrapper mode (poisoned registry) runs no suite here; the isolated child does.
  if (!registryHealthy) return;
  rows.length = 0;
  buttons.length = 0;
  toastCalls.length = 0;
  hapticCalls.length = 0;
  confirmCalls.length = 0;
  compactMutations.length = 0;
  sheetCalls.length = 0;
  sheetProps = null;
  alertDialog = null;
  dialogText.title = '';
  dialogText.description = '';
  deleteCalls = [];
  deleteBehavior = 'ok';
  releaseDelete = () => {};
  useSessionStateStore.getState().reset();
  useTabStore.setState({
    activeSessionId: null,
    tabStateById: {},
    openTabIds: [],
    openPageIds: [],
    activePageId: null,
    openTabOrder: [],
  });
  recordRuntimeCapabilities(SANDBOX, ['session.compact']);
});

afterAll(async () => {
  await act(async () => tree?.unmount());
  tree = undefined;
});

/**
 * Bun shares one module registry across the whole `bun test` run, and an
 * earlier test file can have replaced a module this suite needs real
 * (`drawer-render.test.tsx` stubs `@/stores/tab-store` and
 * `@/lib/projects/hooks` wholesale). When the registry arrives poisoned, run
 * this file once more as its own bun process — alone, it loads a clean
 * registry and the real suites below pass — and assert that run's exit code.
 */
const registryHealthy =
  typeof useTabStore?.setState === 'function' &&
  typeof projectKeys?.projectSessions === 'function';

if (!registryHealthy) {
  test('the delete and compact suites pass on a clean registry (run isolated)', () => {
    const appsRoot = new URL('../../', import.meta.url).pathname;
    const child = Bun.spawnSync(['bun', 'test', 'components/session/actions-sheet-characterization.test.tsx'], {
      cwd: appsRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(child.exitCode).toBe(0);
  });
} else {
// ── The delete flow ──────────────────────────────────────────────────────────

describe('SessionActionsSheet delete flow', () => {
  test('the confirm opens only after the sheet closes, with the session as its title', async () => {
    const ref = await renderSheet();
    await openDeleteConfirm(session(), ref);
    expect(dialogText.title).toBe('Delete session');
    expect(dialogText.description).toContain('Deploy checklist');
  });

  test('an in-flight delete keeps the confirm up; the settled delete closes it and clears the tab', async () => {
    const ref = await renderSheet();
    useTabStore.setState({
      activeSessionId: ROOT_ID,
      tabStateById: { [ROOT_ID]: {} },
      openTabIds: [ROOT_ID],
      openTabOrder: [ROOT_ID],
    });
    await openDeleteConfirm(session(), ref);

    // The cache the sheet writes: the flat list (the open thread's title) and
    // the paged list (the drawer and the Sessions page).
    queryClient.setQueryData(projectKeys.projectSessions(PID), [session(), session({ session_id: 'sess-2' })]);
    queryClient.setQueryData(projectKeys.projectSessionsPaged(PID), {
      pages: [{ items: [session(), session({ session_id: 'sess-2' })], next_cursor: null }],
      pageParams: [null],
    });

    deleteBehavior = 'hang';
    await act(async () => {
      destructiveButton()?.onPress?.();
      await sleep(10);
    });
    expect(deleteCalls).toEqual([{ projectId: PID, sessionId: SID }]);
    // The optimistic write: the row left the paged list while the request runs.
    expect(pagedIds()).toEqual([['sess-2']]);

    // Closing while in flight is refused: the dialog stays up, disabled.
    await act(async () => {
      alertDialog?.onOpenChange?.(false);
      await sleep(5);
    });
    expect(alertDialog?.open).toBe(true);
    expect(destructiveButton()?.disabled).toBe(true);

    await act(async () => {
      releaseDelete({});
      await sleep(15);
    });
    // Settled: the dialog closes, the tab is gone, the success toast ran.
    expect(alertDialog?.open).toBe(false);
    // The row tap warned; the confirm hums and the settle succeeds.
    expect(hapticCalls.slice(-2)).toEqual(['medium', 'success']);
    const tabs = useTabStore.getState();
    expect(tabs.tabStateById[ROOT_ID]).toBeUndefined();
    expect(tabs.activeSessionId).toBeNull();
    expect(toastCalls).toContainEqual({ kind: 'success', message: 'Session deleted' });
  });

  test('a refused delete restores the optimistic removal and shows the failure', async () => {
    const ref = await renderSheet();
    const target = session();
    queryClient.setQueryData(projectKeys.projectSessionsPaged(PID), {
      pages: [{ items: [target, session({ session_id: 'sess-2' })], next_cursor: null }],
      pageParams: [null],
    });
    await openDeleteConfirm(target, ref);

    deleteBehavior = 'fail';
    await act(async () => {
      destructiveButton()?.onPress?.();
      await sleep(10);
    });
    // The row is back: the undo put it where the optimistic write removed it.
    expect(pagedIds()).toEqual([[SID, 'sess-2']]);
    // The dialog stays up and says why; the refusal warned.
    expect(alertDialog?.open).toBe(true);
    expect(hapticCalls).toContain('warning');
    expect(dialogText.description).toBe('Unable to delete. Check your connection and try again.');

    // A second attempt that the server accepts closes the dialog for good.
    deleteBehavior = 'ok';
    await act(async () => {
      destructiveButton()?.onPress?.();
      await sleep(15);
    });
    expect(pagedIds()).toEqual([['sess-2']]);
    expect(alertDialog?.open).toBe(false);
    expect(toastCalls).toContainEqual({ kind: 'success', message: 'Session deleted' });
  });
});

// ── The compact flow ─────────────────────────────────────────────────────────

describe('SessionActionsSheet compact flow', () => {
  test('compact confirms after the sheet closes and summarizes the open thread', async () => {
    useTabStore.setState({ activeSessionId: ROOT_ID });
    const ref = await renderSheet();
    await act(async () => {
      ref.current?.present(session());
      await sleep(5);
    });
    const compactRow = rows.find((row) => row.label === 'Compact');
    expect(compactRow).toBeTruthy();
    expect(compactRow?.disabled).toBe(false);
    await act(async () => {
      compactRow?.onPress?.();
      await sleep(5);
    });
    expect(sheetCalls).toContain('dismiss');
    expect(confirmCalls).toHaveLength(0);

    await act(async () => {
      sheetProps?.onDismiss?.();
      await sleep(5);
    });
    expect(confirmCalls).toHaveLength(1);
    expect(confirmCalls[0]).toMatchObject({ title: 'Compact session', confirmLabel: 'Compact' });

    await act(async () => {
      confirmCalls[0].onConfirm();
      await sleep(5);
    });
    expect(compactMutations).toHaveLength(1);
    expect(compactMutations[0].target).toEqual({ sessionId: ROOT_ID });
  });

  test('compact refuses while the session works, with its own toast', async () => {
    useTabStore.setState({ activeSessionId: ROOT_ID });
    const ref = await renderSheet();
    await act(async () => {
      ref.current?.present(session());
      await sleep(5);
    });
    await act(async () => {
      rows.find((row) => row.label === 'Compact')?.onPress?.();
      sheetProps?.onDismiss?.();
      await sleep(5);
    });
    expect(confirmCalls).toHaveLength(1);

    // The session started working while the dialog was up. The runtime's
    // status frames are keyed by the open thread's runtime id.
    useSessionStateStore.getState().setStatus(ROOT_ID, { type: 'busy' }, 'local');
    await act(async () => {
      confirmCalls[0].onConfirm();
      await sleep(5);
    });
    expect(compactMutations).toHaveLength(0);
    expect(hapticCalls).toContain('warning');
    expect(toastCalls).toContainEqual({
      kind: 'error',
      message: 'The session is working. Compact it when it stops.',
    });
  });
});

}
