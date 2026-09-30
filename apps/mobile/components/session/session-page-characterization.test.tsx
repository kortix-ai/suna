/**
 * Characterization tests for `SessionPage` — the transcript's scroll physics,
 * the message queue's send/retry/stop/drain semantics, and the composer's
 * resolved-config → prompt-options assembly (KRTX-757, phase 1 of the
 * SessionPage split; spec `code-spec:split-session-page`).
 *
 * The real component runs with every store real (`@/lib/opencode/sync-store`,
 * `@/stores/*`, `lib/session/failed-sends`) and React Native mocked, so the
 * tests fail only when the behavior the later extraction phases must keep
 * changes — never when code moves. The pure physics they feed
 * (`lib/session/auto-scroll.ts`) stays real too.
 *
 * They also replace the source-text assertions of `saved-thread-layout.test.ts`
 * and `transcript-file-preview.test.ts` with the same behaviors exercised on
 * the real components (file mentions → the Recent files sheet store; the
 * waking view's saved thread laid out like the live one).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { type ReactTestRenderer, act, create } from 'react-test-renderer';

// One in-memory AsyncStorage for every store this file loads — the shared
// module is the only place allowed to register that mock (see
// stores/in-memory-async-storage.ts). Import it before any store import.
import '@/stores/in-memory-async-storage';
import { useSyncStore } from '@/lib/opencode/sync-store';
import type { MessageWithParts } from '@/lib/opencode/types';
import { TURN_GAP_PX, turnTopGap } from '@/lib/session/auto-scroll';
import { useFailedSendStore } from '@/lib/session/failed-sends';
import { mintWireMessageId } from '@/lib/session/wire-message-id';
import { useCompactionStore } from '@/stores/compaction-store';
import { useSessionPromptRequestStore } from '@/stores/session-prompt-request-store';
import { useTabStore } from '@/stores/tab-store';

// The message-queue store pulls `expo-crypto` → react-native, so it may only
// load after the module mocks below are registered (the static imports above
// are pure or mock-backed; this one is neither).
let useMessageQueueStore: typeof import('@/stores/message-queue-store').useMessageQueueStore;

// Metro injects `__DEV__`; expo-router's module init reads it.
(globalThis as any).__DEV__ = true;

const SID = 'sess-char-1';
const SANDBOX = 'https://sandbox.test';

// ── Module mocks ─────────────────────────────────────────────────────────────
// Every module the two sources import is either mocked here, kept real
// (`KEEP_REAL`), or auto-filled with inert stand-ins by the import scan below.

const Empty = () => null;
const calls: { name: string; args: any[] }[] = [];
const spy =
  (name: string) =>
  (...args: any[]) => {
    calls.push({ name, args });
    return undefined;
  };
const seen = (name: string) => calls.filter((call) => call.name === name);

// Components under test, imported after the mocks below are registered.
let SessionPage: typeof import('./SessionPage').SessionPage;
let SessionConnecting: typeof import('./SessionConnecting').SessionConnecting;

// ── Captures the mocks feed the assertions ───────────────────────────────────
let listProps: any = null; // the FlatList's latest props
let composerProps: any = null; // SessionChatInput's latest props
let wakingComposerProps: any = null; // the SavedThread Composer's latest props
let markdownActionsValue: any = null; // MarkdownActionsProvider's value
let turnProps: any[] = []; // every mounted SessionTurn's props
const scrollToEndCalls: any[][] = [];
const previewCalls: { path: string; line?: number }[] = [];
let previewHostMounts = 0;
const toastCalls: { kind: string; message: string }[] = [];
const fetchCalls: { url: string; method: string; body: any }[] = [];
const scrollToCalls: { offset: number; animated: boolean }[] = [];
const buttons: any[] = []; // every mounted design-system Button's props
const viewProps: any[] = []; // every mounted react-native View's props

let resolvedConfig: any; // the mocked useResolvedConfig answer
let promptResponder: () => { ok: boolean; status: number; text: string };
let abortResponder: () => { ok: boolean; status: number; text: string };
let commandResponder: () => { ok: boolean; status: number; text: string };
let abortThrows = false;

const respond = (r: () => { ok: boolean; status: number; text: string }) => ({
  ok: r().ok,
  status: r().status,
  text: async () => r().text,
  json: async () => ({}),
});
const fail = (): { ok: boolean; status: number; text: string } => ({
  ok: false,
  status: 500,
  text: 'boom',
});
const pass = (): { ok: boolean; status: number; text: string } => ({
  ok: true,
  status: 200,
  text: '',
});
const okResponse = (json: unknown) => ({
  ok: true,
  status: 200,
  text: async () => '',
  json: async () => json,
});

// ── React Native stand-ins ───────────────────────────────────────────────────
// Views record their props so layout callbacks (`onLayout`) can be fired at
// the exact views the component wired them to.
const RNView = (props: any) => {
  viewProps.push(props);
  return props.children ?? null;
};
const RNScrollView = React.forwardRef((props: any, ref: any) => {
  viewProps.push(props);
  if (ref) {
    ref.current = {
      scrollToEnd: (...args: any[]) => scrollToEndCalls.push(args),
      scrollTo: spy('scrollViewScrollTo'),
    };
  }
  return props.children ?? null;
});
const RNFlatList = React.forwardRef((props: any, ref: any) => {
  listProps = props;
  if (ref) {
    ref.current = {
      scrollToOffset: (args: any) => scrollToCalls.push(args),
      scrollToEnd: spy('listScrollToEnd'),
    };
  }
  // Header, footer and cells mount like the real list; cell layout callbacks
  // are additionally driven through `renderItem` below, addressable per turn.
  return React.createElement(
    React.Fragment,
    null,
    props.ListHeaderComponent ?? null,
    props.ListFooterComponent ?? null,
    ...(props.data ?? []).map((item: any, index: number) =>
      React.createElement(
        React.Fragment,
        { key: item.userMessage.info.id },
        props.renderItem({ item, index }),
      ),
    ),
  );
});
const RNRefreshControl = (props: any) => {
  viewProps.push(props);
  return null;
};
const RNAnimatedValue = class {
  value: number;
  constructor(initial: number) {
    this.value = initial;
  }
  setValue(v: number) {
    this.value = v;
  }
};
const RNButton = (props: any) => {
  buttons.push(props);
  return props.children ?? null;
};
const RNText = (props: any) => props.children ?? null;
const Capture = (register: (props: any) => void) =>
  React.forwardRef(function Captured(props: any, ref: any) {
    register(props);
    if (ref) ref.current = { open: spy('sheetOpen'), close: spy('sheetClose') };
    return null;
  });

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
  AppState: { addEventListener: (_: string, cb: any) => ({ remove: () => {} }) },
  View: RNView,
  FlatList: RNFlatList,
  ScrollView: RNScrollView,
  RefreshControl: RNRefreshControl,
  Animated: {
    Value: RNAnimatedValue,
    timing: () => ({ start: spy('animatedTiming') }),
    View: (props: any) => props.children ?? null,
  },
  Easing: { out: (x: any) => x, cubic: () => 0, bezier: () => 0 },
  Platform: { OS: 'ios', select: (o: any) => o.ios },
  // Exports a transitive graph may import without the two sources naming them.
  NativeModules: {},
  BackHandler: {
    addEventListener: (_: string, cb: any) => ({ remove() {} }),
    removeEventListener() {},
  },
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
  Linking: {
    openURL: spy('openURL'),
    canOpenURL: async () => true,
    addEventListener: () => ({ remove() {} }),
  },
  Appearance: { getColorScheme: () => 'light', addChangeListener: () => ({ remove() {} }) },
  LayoutAnimation: { configureNext() {}, easeInEaseOut() {} },
  findNodeHandle: () => null,
  processColor: (color: any) => color,
  unstable_batchedUpdates: (cb: any) => cb?.(),
};
// Any react-native export the transitive graph touches but the mocks above do
// not name (NativeModules, StyleSheet, …) degrades to the null stub, so a
// missing export cannot crash a load.
const rnModule = new Proxy(rnNative, {
  get(target: any, prop: string | symbol) {
    if (typeof prop === 'string' && !(prop in target)) target[prop] = anyStub;
    return target[prop];
  },
});

const moduleMocks: Record<string, Record<string, any>> = {
  'react-native': rnModule,
  'react-native-keyboard-controller': {
    KeyboardAvoidingView: (props: any) => props.children ?? null,
    KeyboardGestureArea: (props: any) => props.children ?? null,
    KeyboardController: { isVisible: () => false },
    useReanimatedKeyboardAnimation: () => ({ progress: { value: 0 } }),
  },
  'react-native-reanimated': {
    default: { View: (props: any) => props.children ?? null },
    View: (props: any) => props.children ?? null,
    Easing: { bezier: () => 0 },
    useAnimatedStyle: () => ({}),
    useReducedMotion: () => false,
    useSharedValue: (v: number) => ({ value: v }),
    withTiming: (v: number) => v,
    interpolate: () => 0,
  },
  'react-native-safe-area-context': {
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  },
  nativewind: { useColorScheme: () => ({ colorScheme: 'light' }) },
  'expo-linear-gradient': { LinearGradient: (props: any) => props.children ?? null },
  'expo-router': {
    Stack: Object.assign((props: any) => props.children ?? null, { Screen: Empty }),
    useRouter: () => ({ push: spy('routerPush'), back() {}, canGoBack: () => false }),
    useLocalSearchParams: () => ({}),
    useIsFocused: () => true,
    useFocusEffect: () => {},
    DarkTheme: {},
    DefaultTheme: {},
  },
  'expo-router/react-navigation': {
    useFocusEffect: () => {},
    useNavigation: () => ({ dispatch() {}, canGoBack: () => false }),
    StackActions: {
      push: spy('stackPush'),
      replace: spy('stackReplace'),
      popTo: spy('stackPopTo'),
    },
    CommonActions: { reset: spy('stackReset') },
    DarkTheme: {},
    DefaultTheme: {},
  },
  'expo-crypto': {
    randomUUID: (() => {
      let n = 0;
      return () => `retry-uuid-${++n}`;
    })(),
  },

  '@/lib/icons': { XIcon: Empty, CaretUpIcon: Empty, CaretDownIcon: Empty, Icon: Empty },
  '@/components/ui/text': { Text: RNText },
  '@/components/ui/button': { Button: RNButton },
  '@/components/ui/icon': { Icon: Empty },
  '@/components/session/FloatingMenuButton': {
    FLOATING_MENU_CLEARANCE: 0,
    FloatingMenuButton: (props: any) => props.children ?? null,
  },
  '@/components/session/ProjectHeaderActions': {
    ProjectHeaderActions: (props: any) => props.children ?? null,
  },
  '@/components/session/SessionThreadTitle': { SessionThreadTitle: Empty },
  '@/components/session/SubAgentHeaderChip': { SubAgentHeaderChip: Empty },
  '@/components/session/SubAgentListSheet': { SubAgentListSheet: Capture(() => {}) },
  '@/components/session/ConnectProviderSheet': { ConnectProviderSheet: Capture(() => {}) },
  '@/components/session/ConnectorAuthSheet': { ConnectorAuthSheet: Capture(() => {}) },
  '@/components/session/SessionChangeRequests': { SessionChangeRequests: Empty },
  '@/components/session/SandboxHealthPill': { SandboxHealthPill: Empty },
  '@/components/session/LiveUpdatesPausedPill': { LiveUpdatesPausedPill: Empty },
  '@/components/session/SandboxPreviewSheet': { SandboxPreviewSheet: Capture(() => {}) },
  '@/components/session/turn/activity-sheet': { ActivitySheetHost: Empty },
  '@/components/session/QuestionPrompt': { QuestionPrompt: (props: any) => props.children ?? null },
  '@/components/session/PermissionPromptCard': { PermissionPromptCard: Empty },
  '@/components/session/ProjectHero': { ProjectHero: Empty },

  './SessionChatInput': {
    SessionChatInput: (props: any) => {
      composerProps = props;
      return props.inputSlot ?? null;
    },
  },
  './SessionTurn': {
    SessionTurn: (props: any) => {
      turnProps.push(props);
      return null;
    },
  },
  // SessionConnecting imports the same turns under the package alias.
  '@/components/session/SessionTurn': {
    SessionTurn: (props: any) => {
      turnProps.push(props);
      return null;
    },
  },
  './session-busy-indicator': { SessionBusyIndicator: Empty },
  './turn/compaction-divider': { CompactionMarker: Empty },
  '@/components/session/tool/shared/navigation': {
    ToolFilePreviewHost: () => {
      previewHostMounts += 1;
      return null;
    },
    useToolFilePreviewStore: {
      getState: () => ({
        openPreview: (path: string, line?: number) => previewCalls.push({ path, line }),
        closePreview: () => {},
        setAddToChat: () => {},
      }),
    },
  },
  '@/components/kortix/toast-provider': {
    useToast: () => ({
      error: (message: string) => toastCalls.push({ kind: 'error', message }),
      info: (message: string) => toastCalls.push({ kind: 'info', message }),
    }),
  },
  '@/components/markdown/inline-code': {
    MarkdownActionsProvider: (props: any) => {
      markdownActionsValue = props.value;
      return props.children ?? null;
    },
  },
  '@/lib/haptics': { haptics: { tap: spy('hapticsTap') } },
  // The real logger reads Metro's `__DEV__` global, absent under bun.
  '@/lib/logger': {
    log: { log() {}, warn() {}, error() {}, info() {} },
    setLoggerUserId() {},
    setLogLevel() {},
  },
  '@/lib/sounds': { playSound: spy('playSound') },
  // `API_URL` ships for the real `lib/platform/client` that the captured
  // hook modules below load.
  '@/api/config': { getAuthToken: async () => 'token-1', API_URL: 'https://api.test' },
  '@/lib/notifications/registration': { requestPushPermissionOnce: spy('pushPermission') },

  '@/contexts/SandboxContext': {
    useSandboxContext: () => ({ sandboxUrl: SANDBOX, switchSandbox: spy('switchSandbox') }),
  },

  // SessionConnecting's waking view.
  '@/components/kortix/composer': {
    Composer: (props: any) => {
      wakingComposerProps = props;
      return null;
    },
  },
  '@/components/session/attachment-tile': { AttachmentTile: Empty },
  '@/components/session/turn/user-message': {
    UserMessageBubble: (props: any) => props.children ?? null,
  },
  '@/components/kortix/kortix-loader': { KortixLoader: Empty },
};

// Overrides layered over the captured real modules in `beforeAll` — these
// modules are never registered partially (see MERGED below).
const mergedOverrides: Record<string, Record<string, any>> = {
  '@/lib/platform/hooks': {
    useSession: () => ({ data: { title: 'Saved title' } }),
    useSessions: () => ({ data: [] }),
    replyToQuestion: spy('replyToQuestion'),
    rejectQuestion: spy('rejectQuestion'),
    replyToPermission: spy('replyToPermission'),
  },
  '@/lib/projects/hooks': {
    useProjectDetail: () => ({ data: { config: null } }),
    useComposerModels: () => ({
      gatewayEnabled: false,
      providers: null,
      models: [],
      modelDefaults: null,
      isLoading: false,
      refetchModelCount: spy('refetchModels'),
    }),
  },
  '@/lib/opencode/hooks/use-opencode-data': {
    useOpenCodeConfig: () => ({ data: null }),
    useOpenCodeCommands: () => ({ data: [] }),
  },
  '@/lib/opencode/hooks/use-local-config': { useResolvedConfig: () => resolvedConfig },
  '@/lib/opencode/session-sync': {
    useSessionSync: () => ({ hasOlder: false, isLoadingOlder: false, loadOlder: spy('loadOlder') }),
    reconcileLiveSession: spy('reconcile'),
  },
  '@/lib/opencode/session-rewind': {
    revertSession: async (...args: any[]) => {
      calls.push({ name: 'revertSession', args });
    },
  },
  '@/hooks/useLiveUpdates': {
    useLiveUpdates: () => ({ paused: false, statusLabel: '', reconnect: spy('liveReconnect') }),
  },
  '@/lib/session/use-composer-draft': { useComposerDraft: () => {} },
};

// Everything these two sources import is either mocked above, kept real, or a
// type-only import. Unlisted value imports get inert stand-ins so an omitted
// mock fails loudly in a test instead of silently at import time.
const KEEP_REAL = new Set([
  'react',
  '@kortix/sdk',
  '@/lib/opencode/types',
  '@/lib/opencode/sync-store',
  '@/lib/opencode/runtime-capabilities',
  '@/lib/opencode/stream-policy',
  '@/lib/session/auto-scroll',
  '@/lib/session/stable-turns',
  '@/lib/session/turn-body',
  '@/lib/session/user-message',
  '@/lib/session/optimistic-parts',
  '@/lib/session/wire-message-id',
  '@/lib/session/failed-sends',
  '@/lib/session/composer-draft',
  '@/lib/session/prompt-parts',
  '@/lib/session/composer-config',
  '@/lib/session/composer-model',
  '@/lib/session/model-picker',
  '@/lib/session/question-poll',
  '@/lib/session/permission-prompt',
  '@/lib/session/queue-undo',
  '@/lib/session/older-history',
  '@/lib/session/attachment-tile',
  '@/lib/utils/theme',
  '@/stores/tab-store',
  '@/stores/message-queue-store',
  '@/stores/session-prompt-request-store',
  '@/stores/compaction-store',
  '@/stores/composer-draft-store',
  '@/components/session/tool/shared/connector-handoff-context',
]);

const CAPTURE = [
  '@/lib/projects/hooks',
  '@/lib/platform/hooks',
  '@/lib/opencode/hooks/use-opencode-data',
  '@/lib/opencode/hooks/use-local-config',
  '@/lib/opencode/session-sync',
  '@/lib/opencode/session-rewind',
  '@/hooks/useLiveUpdates',
  '@/lib/session/use-composer-draft',
] as const;

const sources =
  readFileSync(import.meta.dir + '/SessionPage.tsx', 'utf8') +
  readFileSync(import.meta.dir + '/SessionConnecting.tsx', 'utf8');
const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const specs = new Set<string>();
for (const [, name] of sources.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
  if (KEEP_REAL.has(name) || CAPTURE.includes(name as any)) continue;
  // Type-only imports need no runtime mock.
  if (
    new RegExp(`import\\s+type\\s*\\{[^}]*\\}\\s*from\\s*['"]${escape(name)}['"]`, 's').test(
      sources,
    )
  )
    continue;
  specs.add(name);
}
// Transitive imports of the kept-real modules (e.g. `expo-router/react-navigation`
// behind `lib/utils/theme.ts`) are not in the scan: mock every explicit entry too.
const toMock = [...specs, ...Object.keys(moduleMocks)];
for (const name of new Set(toMock)) {
  const values: Record<string, any> = { default: Empty, ...(moduleMocks[name] ?? {}) };
  // Named imports the explicit mock misses (an icon, a helper) get an inert
  // stand-in, so an incomplete mock fails a test instead of an import.
  for (const [, names] of sources.matchAll(
    new RegExp(`import\\s*\\{([^}]+)\\}\\s*from\\s*['"]${escape(name)}['"]`, 'gs'),
  )) {
    for (const item of names.split(',')) {
      const key = item
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0];
      if (key && !(key in values)) values[key] = Empty;
    }
  }
  mock.module(name, () => values);
}

// ── Message fixtures ─────────────────────────────────────────────────────────
let priorIds: string[] = [];
let idClock = 1_700_000_000_000;
const nid = () => {
  const id = mintWireMessageId({ nowMs: idClock, knownMessageIds: priorIds });
  priorIds.push(id);
  return id;
};
const userMsg = (text: string): MessageWithParts => {
  const id = nid();
  return {
    info: { id, role: 'user', sessionID: SID, time: { created: idClock++ } },
    parts: [{ id: `part-${id}`, type: 'text', text }],
  } as unknown as MessageWithParts;
};
const assistantMsg = (text: string, parentID?: string): MessageWithParts => {
  const id = nid();
  return {
    info: { id, role: 'assistant', sessionID: SID, parentID, time: { created: idClock++ } },
    parts: [{ id: `part-${id}`, type: 'text', text }],
  } as unknown as MessageWithParts;
};

/** One turn (user + assistant reply). 700pt tall once laid out — taller than
 *  the 600pt viewport, so every scroll-end math below is exact. */
const makeTurn = (text: string): [MessageWithParts, MessageWithParts] => {
  const user = userMsg(text);
  return [user, assistantMsg(`re: ${text}`, user.info.id)];
};
const seedTurns = (texts: string[]) => {
  useSyncStore.setState({
    messages: { [SID]: texts.flatMap((text) => makeTurn(text)) },
    sessionStatus: { [SID]: { type: 'idle' } },
  } as any);
};
const setStatus = (status: { type: string }) =>
  useSyncStore.setState(
    (state) => ({ sessionStatus: { ...state.sessionStatus, [SID]: status } }) as any,
  );
const appendMessages = (messages: MessageWithParts[]) =>
  useSyncStore.setState(
    (state) =>
      ({
        messages: { ...state.messages, [SID]: [...(state.messages[SID] ?? []), ...messages] },
      }) as any,
  );

// ── Harness ──────────────────────────────────────────────────────────────────
let tree: ReactTestRenderer | undefined;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const toastsOf = (kind: string) => toastCalls.filter((t) => t.kind === kind);

const renderPage = async (props: Record<string, unknown> = {}) => {
  await act(async () => {
    tree = create(
      React.createElement(SessionPage, {
        sessionId: SID,
        projectId: 'proj-1',
        projectSessionId: 'ps-1',
        onBack: () => {},
        ...props,
      } as any),
    );
  });
};

/** Fire every layout callback the list owns, in the order a device delivers
 *  them — including the spacer re-laying-out after a settle changed the room,
 *  which re-settles, exactly as the device delivers. */
const layoutTranscript = async (contentHeight: number, turnHeights: number[]) => {
  for (const [index, height] of turnHeights.entries()) {
    const element = listProps.renderItem({ item: listProps.data[index], index });
    element.props.onLayout?.({ nativeEvent: { layout: { height } } });
  }
  listProps.onLayout?.({ nativeEvent: { layout: { height: 600 } } });
  listProps.onContentSizeChange?.(320, contentHeight);
  await act(async () => {
    await sleep(15);
  });
  for (let pass = 0; pass < 3; pass += 1) {
    // The room spacer is the only View with a numeric height style.
    const spacer = viewProps.findLast(
      (props) => props.onLayout && typeof props.style?.height === 'number',
    );
    if (!spacer || spacerFired === spacer.style.height) return;
    spacerFired = spacer.style.height;
    spacer.onLayout?.({ nativeEvent: { layout: { height: spacer.style.height } } });
    await act(async () => {
      await sleep(15);
    });
  }
};
let spacerFired: number | null = null;

const resetStores = () => {
  useSyncStore.setState({ messages: {}, sessionStatus: {}, questions: {}, permissions: {} } as any);
  useTabStore.setState({ tabStateById: {} } as any);
  useMessageQueueStore.setState({ messages: [], hydrated: true } as any);
  useFailedSendStore.setState({ bySession: {} } as any);
  useSessionPromptRequestStore.setState({ request: null } as any);
  useCompactionStore.setState({ compactingBySession: {} } as any);
};

// Hook and lib modules whose real versions other surfaces import are captured
// first and re-mocked merged, so a concurrent test file (they share one module
// registry) never sees a module missing an export it needs.
const MERGED: Record<string, Record<string, any>> = {};
beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    (globalThis as any).requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
    (globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
  }
  for (const name of CAPTURE) {
    MERGED[name] = { ...(await import(name)) };
    mock.module(name, () => ({
      ...MERGED[name],
      ...(mergedOverrides[name] ?? {}),
      default: MERGED[name].default ?? Empty,
    }));
  }
  ({ useMessageQueueStore } = await import('@/stores/message-queue-store'));
  SessionPage = (await import('./SessionPage')).SessionPage;
  SessionConnecting = (await import('./SessionConnecting')).SessionConnecting;
});

beforeEach(() => {
  calls.length = 0;
  turnProps = [];
  scrollToEndCalls.length = 0;
  previewCalls.length = 0;
  previewHostMounts = 0;
  toastCalls.length = 0;
  fetchCalls.length = 0;
  scrollToCalls.length = 0;
  buttons.length = 0;
  viewProps.length = 0;
  listProps = null;
  spacerFired = null;
  composerProps = null;
  wakingComposerProps = null;
  markdownActionsValue = null;
  priorIds = [];
  idClock = 1_700_000_000_000;
  resolvedConfig = {
    agent: { name: 'builder' },
    agents: [{ name: 'builder' }],
    model: { providerID: 'prov', modelID: 'mod' },
    modelKey: { providerID: 'prov', modelID: 'mod' },
    variant: 'high',
    variants: ['high'],
    setAgent: spy('setAgent'),
    setModel: spy('setModel'),
    setVariant: spy('setVariant'),
  };
  promptResponder = pass;
  abortResponder = pass;
  commandResponder = pass;
  abortThrows = false;
  resetStores();
  globalThis.fetch = (async (input: any, init?: any) => {
    if (abortThrows) throw new Error('offline');
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: any;
    try {
      body = init?.body ? JSON.parse(init.body) : undefined;
    } catch {
      body = init?.body;
    }
    fetchCalls.push({ url, method, body });
    if (method === 'POST' && url.endsWith(`/session/${SID}/prompt_async`))
      return respond(promptResponder);
    if (method === 'POST' && url.endsWith('/abort')) return respond(abortResponder);
    if (method === 'POST' && url.endsWith('/command')) return respond(commandResponder);
    if (url.endsWith('/question') || url.endsWith('/permission')) return okResponse([]);
    return okResponse({});
  }) as any;
});

afterEach(async () => {
  if (tree) await act(async () => tree?.unmount());
  tree = undefined;
});

// ── Scroll physics ───────────────────────────────────────────────────────────

describe('SessionPage scroll physics', () => {
  test('follows layout changes to the end while follow is on, instantly on the first settle', async () => {
    seedTurns(['one']);
    await renderPage();
    // content = turn 700 + room 24 → the end sits 148 past the 600pt viewport.
    await layoutTranscript(724, [700]);
    expect(scrollToCalls).toEqual([{ offset: 148, animated: false }]);
  });

  test('a new turn from another client glides to the new end; a reader touch that released follow re-arms on it', async () => {
    seedTurns(['one']);
    await renderPage();
    await layoutTranscript(724, [700]);
    expect(scrollToCalls).toEqual([{ offset: 148, animated: false }]);

    // Another client's turn arrives while the reader follows.
    await act(async () => {
      appendMessages(makeTurn('two'));
      await sleep(15);
    });
    // content = 700 + gap 44 + 700 + room 24 = 1468 → end 868; a whole-turn
    // move over GLIDE_MIN_PX glides.
    await layoutTranscript(1468, [700, 700]);
    expect(scrollToCalls.at(-1)).toEqual({ offset: 868, animated: true });

    // The glide lands at its target: no further move.
    listProps.onScroll?.({
      nativeEvent: {
        contentOffset: { y: 868 },
        contentSize: { height: 1468 },
        layoutMeasurement: { height: 600 },
      },
    });
    await act(async () => {
      await sleep(15);
    });
    expect(scrollToCalls).toHaveLength(2);

    // A touch on the idle thread releases follow; a foreign scroll away keeps it off.
    await act(async () => {
      await sleep(350); // the glide's own-scroll window expires
    });
    listProps.onTouchStart?.();
    listProps.onScroll?.({
      nativeEvent: {
        contentOffset: { y: 300 },
        contentSize: { height: 1468 },
        layoutMeasurement: { height: 600 },
      },
    });
    await act(async () => {
      await sleep(15);
    });
    expect(scrollToCalls).toHaveLength(2);

    // A new turn nobody sent still scrolls into view: the touch was the only release.
    await act(async () => {
      appendMessages(makeTurn('three'));
      await sleep(15);
    });
    // content = 3 × 700 + 2 × 44 + 24 = 2212 → end 1612.
    await layoutTranscript(2212, [700, 700, 700]);
    expect(scrollToCalls.at(-1)).toEqual({ offset: 1612, animated: true });
  });

  test('a drag releases follow and the send sticks back to the end with a glide', async () => {
    seedTurns(['one']);
    await renderPage();
    await layoutTranscript(724, [700]);

    listProps.onScrollBeginDrag?.();
    await act(async () => {
      await sleep(15);
    });
    expect(scrollToCalls).toHaveLength(1);

    await act(async () => {
      composerProps.onSend('hello', {});
      await sleep(15);
    });
    // The optimistic turn exists and the session is busy.
    const messages = useSyncStore.getState().messages[SID] ?? [];
    expect(
      messages.some((m) => m.info.role === 'user' && (m.parts[0] as any).text === 'hello'),
    ).toBe(true);
    expect(useSyncStore.getState().sessionStatus[SID]).toEqual({ type: 'busy' });

    await layoutTranscript(1468, [700, 700]);
    expect(scrollToCalls.at(-1)).toEqual({ offset: 868, animated: true });
  });
});

// ── Scroll save / restore across tab switches ────────────────────────────────

describe('SessionPage scroll save and restore', () => {
  test('a saved offset restores without following, a user scroll persists, and following saves 0', async () => {
    seedTurns(['one', 'two']);
    useTabStore.setState((state: any) => ({
      tabStateById: { ...state.tabStateById, [SID]: { scrollOffset: 300 } },
    }));
    await renderPage();
    await layoutTranscript(1468, [700, 700]);
    await act(async () => {
      await sleep(80); // the restore's 60 ms timer
    });
    // Restored once, instantly, and a restored position does not follow.
    expect(scrollToCalls).toEqual([{ offset: 300, animated: false }]);

    // A user scroll away from the end persists on rest (the reader is not following).
    await act(async () => {
      await sleep(350); // the restore's own-scroll window expires
    });
    listProps.onScrollEndDrag?.({
      nativeEvent: {
        contentOffset: { y: 500 },
        contentSize: { height: 1468 },
        layoutMeasurement: { height: 600 },
        velocity: { y: 0 },
      },
    });
    expect(useTabStore.getState().tabStateById[SID]?.scrollOffset).toBe(500);

    // The scroll-to-bottom button glides to the end and follows from there.
    const jumpButton = buttons.find((props) => props.accessibilityLabel === 'Scroll to bottom');
    expect(jumpButton).toBeTruthy();
    await act(async () => {
      jumpButton.onPress();
      await sleep(15);
    });
    console.error('SCROLLS', JSON.stringify(scrollToCalls));
    expect(scrollToCalls.at(-1)).toEqual({ offset: 868, animated: true });

    // Land the glide, then rest at the end: following saves 0 (reopen at the end).
    listProps.onScroll?.({
      nativeEvent: {
        contentOffset: { y: 868 },
        contentSize: { height: 1468 },
        layoutMeasurement: { height: 600 },
      },
    });
    listProps.onScrollEndDrag?.({
      nativeEvent: {
        contentOffset: { y: 868 },
        contentSize: { height: 1468 },
        layoutMeasurement: { height: 600 },
        velocity: { y: 0 },
      },
    });
    expect(useTabStore.getState().tabStateById[SID]?.scrollOffset).toBe(0);

    // Leaving the session keeps the last persisted value.
    await act(async () => tree?.unmount());
    tree = undefined;
    expect(useTabStore.getState().tabStateById[SID]?.scrollOffset).toBe(0);
  });

  test('an offset saved while the reader is mid-thread re-restores on the next open', async () => {
    seedTurns(['one', 'two']);
    useTabStore.setState((state: any) => ({
      tabStateById: { ...state.tabStateById, [SID]: { scrollOffset: 400 } },
    }));
    await renderPage();
    await layoutTranscript(1468, [700, 700]);
    await act(async () => {
      await sleep(80);
    });
    expect(scrollToCalls).toEqual([{ offset: 400, animated: false }]);
    await act(async () => tree?.unmount());
    tree = undefined;

    // The tab switch back: the same restore, nothing follows the end meanwhile.
    scrollToCalls.length = 0;
    await renderPage();
    await layoutTranscript(1468, [700, 700]);
    await act(async () => {
      await sleep(80);
    });
    expect(scrollToCalls).toEqual([{ offset: 400, animated: false }]);
  });
});

// ── Message queue ────────────────────────────────────────────────────────────

describe('SessionPage message queue', () => {
  test('drains queued messages in order once the agent settles, with the composer defaults', async () => {
    await renderPage();
    await act(async () => {
      composerProps.onEnqueue('first');
      composerProps.onEnqueue('second');
      composerProps.onEnqueue('third');
    });
    expect(useMessageQueueStore.getState().messages.map((m) => m.text)).toEqual([
      'first',
      'second',
      'third',
    ]);

    await act(async () => {
      setStatus({ type: 'idle' });
      await sleep(650); // the drain's 500 ms settle delay
    });
    expect(fetchCalls.filter((c) => c.url.endsWith('/prompt_async')).map((c) => c.body)).toEqual([
      { parts: [{ type: 'text', text: 'first' }] },
    ]);
    expect(useMessageQueueStore.getState().messages.map((m) => m.text)).toEqual([
      'second',
      'third',
    ]);
    expect(useSyncStore.getState().sessionStatus[SID]).toEqual({ type: 'busy' });

    // The agent settles again: the in-flight lock releases and the next goes out.
    await act(async () => {
      setStatus({ type: 'idle' });
      await sleep(750); // 100 ms release + 500 ms settle + slack
    });
    await act(async () => {
      setStatus({ type: 'idle' });
      await sleep(750);
    });
    expect(
      fetchCalls
        .filter((c) => c.url.endsWith('/prompt_async'))
        .map((c) => (c.body as any).parts[0].text),
    ).toEqual(['first', 'second', 'third']);
    expect(useMessageQueueStore.getState().messages).toEqual([]);
  });

  test('a drain does not start while the agent is busy or a question is pending', async () => {
    seedTurns(['one']);
    await renderPage();
    await act(async () => {
      setStatus({ type: 'busy' });
      composerProps.onEnqueue('held');
      await sleep(650);
    });
    expect(fetchCalls.filter((c) => c.url.endsWith('/prompt_async'))).toHaveLength(0);

    // A pending question holds the drain even when the agent is idle.
    await act(async () => {
      setStatus({ type: 'idle' });
      useSyncStore.setState(
        (state) =>
          ({ questions: { ...state.questions, [SID]: [{ id: 'q1', sessionID: SID }] } }) as any,
      );
      await sleep(650);
    });
    expect(fetchCalls.filter((c) => c.url.endsWith('/prompt_async'))).toHaveLength(0);
  });

  test('Send now stops the current reply and sends the queued message outside the drain', async () => {
    seedTurns(['one']);
    await renderPage();
    await act(async () => {
      setStatus({ type: 'busy' });
      composerProps.onEnqueue('urgent');
      await sleep(15);
    });

    console.error('BTNS', JSON.stringify(buttons.map((b) => b.accessibilityLabel)));
    const toggle = buttons.find((props) =>
      String(props.accessibilityLabel ?? '').includes('queued messages'),
    );
    expect(toggle).toBeTruthy();
    await act(async () => {
      toggle.onPress();
      await sleep(15);
    });
    const sendNow = buttons.filter((props) => props.accessibilityLabel === 'Send now');
    expect(sendNow).toHaveLength(1);
    await act(async () => {
      sendNow[0].onPress();
      await sleep(350); // the 200 ms interrupt delay
    });
    expect(toastCalls).toContainEqual({
      kind: 'info',
      message: 'Stopped the current reply to send this now',
    });
    expect(fetchCalls.some((c) => c.url.endsWith('/abort'))).toBe(true);
    expect(
      fetchCalls
        .filter((c) => c.url.endsWith('/prompt_async'))
        .map((c) => (c.body as any).parts[0].text),
    ).toEqual(['urgent']);
    expect(useMessageQueueStore.getState().messages).toEqual([]);
  });
});

// ── Send / retry / stop ──────────────────────────────────────────────────────

describe('SessionPage send, retry and stop', () => {
  test('a failed prompt keeps the message in the thread and a retry re-sends it under the same ids', async () => {
    seedTurns(['one']);
    await renderPage();
    await act(async () => {
      promptResponder = fail;
      composerProps.onSend('hello', {});
      await sleep(15);
    });
    expect(useSyncStore.getState().sessionStatus[SID]).toEqual({ type: 'idle' });
    // The message stays in the thread, dimmed: not optimistic, not gone.
    const messages = useSyncStore.getState().messages[SID] ?? [];
    const failedMessage = messages.find(
      (m) => m.info.role === 'user' && (m.parts[0] as any).text === 'hello',
    );
    expect(failedMessage).toBeTruthy();
    expect(useFailedSendStore.getState().bySession[SID]?.[failedMessage!.info.id]).toMatchObject({
      text: 'hello',
    });

    const retryTurn = turnProps.find((props) => props.uploadStatus?.state === 'failed');
    expect(retryTurn.uploadStatus.onRetry).toBeTypeOf('function');
    await act(async () => {
      promptResponder = pass;
      retryTurn.uploadStatus.onRetry();
      await sleep(15);
    });
    const promptPosts = fetchCalls.filter((c) => c.url.endsWith('/prompt_async'));
    expect(promptPosts).toHaveLength(2);
    expect(JSON.stringify(promptPosts[1].body)).toBe(JSON.stringify(promptPosts[0].body));
    // One 'hello' user message again, under the failed attempt's wire id —
    // the prompt inbox dedupes on `clientMessageId`, so a retry cannot double-run.
    const after = (useSyncStore.getState().messages[SID] ?? []).filter(
      (m) => m.info.role === 'user' && (m.parts[0] as any).text === 'hello',
    );
    expect(after).toHaveLength(1);
    expect(after[0].info.id).toBe(failedMessage!.info.id);
    expect(useFailedSendStore.getState().bySession[SID]?.[after[0].info.id]).toBeUndefined();
  });

  test('stop rolls the session status back when the runtime refuses or errors', async () => {
    seedTurns(['one']);
    await renderPage();
    await act(async () => {
      setStatus({ type: 'busy' });
    });

    await act(async () => {
      abortResponder = fail;
      composerProps.onStop();
      await sleep(15);
    });
    expect(fetchCalls.some((c) => c.url.endsWith('/abort'))).toBe(true);
    expect(useSyncStore.getState().sessionStatus[SID]).toEqual({ type: 'busy' });
    expect(toastsOf('error')).toEqual([
      { kind: 'error', message: "Couldn't stop. Kortix is still working." },
    ]);

    await act(async () => {
      abortThrows = true;
      composerProps.onStop();
      await sleep(15);
    });
    expect(useSyncStore.getState().sessionStatus[SID]).toEqual({ type: 'busy' });
    expect(toastsOf('error')).toHaveLength(2);

    await act(async () => {
      abortThrows = false;
      abortResponder = pass;
      composerProps.onStop();
      await sleep(15);
    });
    expect(useSyncStore.getState().sessionStatus[SID]).toEqual({ type: 'idle' });
    expect(toastsOf('error')).toHaveLength(2);
  });
});

// ── Composer option assembly ────────────────────────────────────────────────

describe('SessionPage prompt-options assembly', () => {
  test('a requested prompt sends with the resolved agent, model key and variant', async () => {
    await renderPage();
    await act(async () => {
      useSessionPromptRequestStore.getState().requestSend(SID, 'open change text');
      await sleep(15);
    });
    const post = fetchCalls.find((c) => c.url.endsWith('/prompt_async'));
    expect(post?.body).toEqual({
      parts: [{ type: 'text', text: 'open change text' }],
      agent: 'builder',
      model: { providerID: 'prov', modelID: 'mod' },
      variant: 'high',
    });
    expect(useSessionPromptRequestStore.getState().request).toBeNull();
  });

  test('editing a message reverts to it and sends the edited text with the same resolved options', async () => {
    const [user, assistant] = makeTurn('original');
    useSyncStore.setState({
      messages: { [SID]: [user, assistant] },
      sessionStatus: { [SID]: { type: 'idle' } },
    } as any);
    await renderPage();
    await act(async () => {
      turnProps[0].onEditStart(user.info.id, 'edited');
      await sleep(15);
    });
    await act(async () => {
      turnProps.at(-1).onEditSend(user.info.id, 'edited');
      await sleep(15);
    });
    expect(seen('revertSession')[0]?.args[0]).toMatchObject({
      sandboxUrl: SANDBOX,
      sessionId: SID,
      messageId: user.info.id,
      token: 'token-1',
    });
    // The messages the revert hides leave the thread; the edit goes out as a send.
    const after = useSyncStore.getState().messages[SID] ?? [];
    expect(after.map((m) => [(m.parts[0] as any).text, m.info.role])).toEqual([['edited', 'user']]);
    const post = fetchCalls.find((c) => c.url.endsWith('/prompt_async'));
    expect(post?.body).toEqual({
      parts: [{ type: 'text', text: 'edited' }],
      agent: 'builder',
      model: { providerID: 'prov', modelID: 'mod' },
      variant: 'high',
    });
  });

  test('a slash command posts the command with the resolved agent, model string and variant', async () => {
    await renderPage();
    await act(async () => {
      composerProps.onCommand({ name: 'review' }, 'args');
      await sleep(15);
    });
    const post = fetchCalls.find((c) => c.url.endsWith('/command'));
    expect(post?.body).toEqual({
      command: 'review',
      arguments: 'args',
      agent: 'builder',
      model: 'prov/mod',
      variant: 'high',
    });
  });
});

// ── File mentions (replaces `transcript-file-preview.test.ts`) ───────────────

describe('SessionPage file mentions', () => {
  test('a file mention and an inline-code path open the Recent files sheet store, and the host is mounted', async () => {
    seedTurns(['one']);
    await renderPage();
    expect(previewHostMounts).toBeGreaterThan(0);
    turnProps[0].onFileMention?.('src/app.ts');
    expect(previewCalls).toEqual([{ path: 'src/app.ts', line: undefined }]);
    markdownActionsValue.onOpenFile?.('src/lib/x.ts');
    expect(previewCalls.at(-1)).toEqual({ path: 'src/lib/x.ts', line: undefined });
  });
});

// ── The waking view's saved thread (replaces `saved-thread-layout.test.ts`) ──

describe('SessionConnecting saved thread', () => {
  const renderSavedThread = async (props: Record<string, unknown> = {}) => {
    const messages = [...makeTurn('one'), ...makeTurn('two')];
    await act(async () => {
      tree = create(
        React.createElement(SessionConnecting, {
          messages,
          statusLabel: 'Waking the computer',
          sessionId: SID,
          onCancel: () => {},
          ...props,
        } as any),
      );
    });
  };

  test('the saved copy is laid out like the live thread and opens files in the Recent files sheet', async () => {
    await renderSavedThread();
    // Turns render — the thread is the content, not a loader.
    expect(turnProps.length).toBe(2);
    expect(previewHostMounts).toBeGreaterThan(0);

    // Same turn spacing as the live thread: each turn pads itself, the list
    // adds none.
    const gaps = viewProps
      .map((props) => props.style?.marginTop)
      .filter((marginTop) => typeof marginTop === 'number');
    expect(gaps).toEqual([
      turnTopGap({ index: 1, working: false, pending: false, previousPending: false }),
    ]);
    expect(gaps[0]).toBe(TURN_GAP_PX);

    // A file mention inside a saved turn opens the same preview store.
    turnProps[0].onFileMention?.('src/app.ts');
    expect(previewCalls).toEqual([{ path: 'src/app.ts', line: undefined }]);

    // The saved thread opens at the newest message.
    const scroller = viewProps.find((props) => props.onContentSizeChange);
    expect(scroller).toBeTruthy();
    scroller.onContentSizeChange?.(320, 400);
    expect(scrollToEndCalls).toEqual([[{ animated: false }]]);
  });

  test('the waking composer takes a message and hands it to onSend', async () => {
    const sent: string[] = [];
    await renderSavedThread({
      onSend: (text: string) => {
        sent.push(text);
      },
    });
    await act(async () => {
      wakingComposerProps.onChangeText?.('wake-up ping');
    });
    await act(async () => {
      wakingComposerProps.onSubmit?.();
    });
    expect(sent).toEqual(['wake-up ping']);
    // The composer resets after the submit.
    expect(wakingComposerProps.value).toBe('');
  });

  test('a boot failure takes the composer slot while the readable thread stays', async () => {
    const restart = spy('restart');
    await renderSavedThread({
      error: { title: 'Boot failed', message: 'The runtime did not start' },
      onRestart: restart,
    });
    // The thread is still rendered; the failure replaced only the composer slot.
    expect(turnProps.length).toBe(2);
    const restartButton = buttons.find((props) => props.onPress && props.variant === 'outline');
    expect(restartButton).toBeTruthy();
    await act(async () => {
      restartButton.onPress();
    });
    expect(seen('restart')).toHaveLength(1);
  });
});
