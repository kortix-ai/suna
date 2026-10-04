/**
 * Characterization tests for `SessionPage` — the transcript's scroll physics,
 * the message queue's send/retry/stop/drain semantics, and the composer's
 * resolved-config → prompt-options assembly (KRTX-757, phase 1 of the
 * SessionPage split; spec `code-spec:split-session-page`).
 *
 * The real component runs with every store real (the SDK's session and pending
 * stores, `@/stores/*`, `lib/session/failed-sends`) and React Native mocked.
 * The SDK's network hooks and runtime calls are stand-ins that record what the
 * page asked for; the prompt inbox is the real SDK call over a fake `fetch`. So the
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
import { configureKortix } from '@kortix/sdk';
import { readFileSync } from 'node:fs';
import React from 'react';
import { type ReactTestRenderer, act, create } from 'react-test-renderer';

// One in-memory AsyncStorage for every store this file loads — the shared
// module is the only place allowed to register that mock (see
// stores/in-memory-async-storage.ts). Import it before any store import.
import '@/stores/in-memory-async-storage';
import { useRuntimePendingStore, useSessionStateStore } from '@kortix/sdk/react';
import { sessionRows } from '@/lib/session/session-store';
import type { MessageWithParts } from '@/lib/session/types';
import { TURN_GAP_PX, turnTopGap } from '@/lib/session/auto-scroll';
import { useFailedSendStore } from '@/lib/session/failed-sends';
import { mintWireMessageId } from '@/lib/session/wire-message-id';
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
let healthPillProps: { onSwitch?: () => void } | null = null;
let composerProps: any = null; // SessionChatInput's latest props
let wakingComposerProps: any = null; // the SavedThread Composer's latest props
let markdownActionsValue: any = null; // MarkdownActionsProvider's value
let turnProps: any[] = []; // every mounted SessionTurn's props
let sessionParticipants: any; // what `useSessionParticipants` reads
let messageAuthors: any; // what `useSessionMessageAuthors` reads
const scrollToEndCalls: any[][] = [];
const previewCalls: { path: string; line?: number }[] = [];
let previewHostMounts = 0;
const toastCalls: { kind: string; message: string }[] = [];
const fetchCalls: { url: string; method: string; body: any }[] = [];
const scrollToCalls: { offset: number; animated: boolean }[] = [];
const buttons: any[] = []; // every mounted design-system Button's props
const viewProps: any[] = []; // every mounted react-native View's props
let composerRenders = 0; // how many times SessionChatInput rendered
let gestureAreaProps: any = null; // KeyboardGestureArea's latest props
/** keyboard-controller's `KeyboardEvents` listeners, by event name. */
const keyboardListeners = new Map<string, Set<() => void>>();
const keyboardEvent = (name: string) => keyboardListeners.get(name)?.forEach((cb) => cb());
/** The fresh-session hero's logo; found by type to tell whether it is mounted. */
const HeroLogo = () => null;
/** Every `Animated.timing(...).start(done)`, with its target and end callback. */
const timingStarts: { toValue: number; done?: (result: { finished: boolean }) => void }[] = [];
/** While true, `start` records its callback and does not end the animation. */
let holdTimings = false;

let resolvedConfig: any; // the mocked useResolvedConfig answer
/** The bound session's runtime the page reads (`useSessionRuntime`). */
let runtimeValue: any;
let abortResponder: () => { ok: boolean; status: number; text: string };
let commandResponder: () => { ok: boolean; status: number; text: string };
let abortThrows = false;
let inboxRows: any[] = []; // what GET .../prompts answers
let inboxFails = false; // POST .../prompts is refused

const respond = (r: () => { ok: boolean; status: number; text: string }) => ({
  ok: r().ok,
  status: r().status,
  text: async () => r().text,
  json: async () => ({}),
  headers: { get: () => null },
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
  text: async () => JSON.stringify(json),
  json: async () => json,
  headers: { get: () => 'application/json' },
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

const NO_ROWS: never[] = [];
const toastApi = {
  error: (message: string) => toastCalls.push({ kind: 'error', message }),
  info: (message: string) => toastCalls.push({ kind: 'info', message }),
};

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
    // The animation ends at once: `start`'s callback runs with `finished`.
    // With `holdTimings`, a test ends it by calling the recorded callback.
    timing: (_value: unknown, config: { toValue: number }) => ({
      start: (done?: (result: { finished: boolean }) => void) => {
        calls.push({ name: 'animatedTiming', args: [] });
        timingStarts.push({ toValue: config.toValue, done });
        if (!holdTimings) done?.({ finished: true });
      },
    }),
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
    KeyboardGestureArea: (props: any) => {
      gestureAreaProps = props;
      return props.children ?? null;
    },
    KeyboardController: { isVisible: () => false },
    KeyboardEvents: {
      addListener: (name: string, cb: () => void) => {
        const set = keyboardListeners.get(name) ?? new Set();
        set.add(cb);
        keyboardListeners.set(name, set);
        return { remove: () => set.delete(cb) };
      },
    },
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
  '@/components/session/SandboxHealthPill': { SandboxHealthPill: Capture((props: { onSwitch?: () => void }) => { healthPillProps = props; }) },
  '@/components/session/LiveUpdatesPausedPill': { LiveUpdatesPausedPill: Empty },
  '@/components/session/SandboxPreviewSheet': { SandboxPreviewSheet: Capture(() => {}) },
  '@/components/session/turn/activity-sheet': { ActivitySheetHost: Empty },
  '@/components/session/QuestionPrompt': { QuestionPrompt: (props: any) => props.children ?? null },
  '@/components/session/PermissionPromptCard': { PermissionPromptCard: Empty },
  '@/components/session/ProjectHero': { ProjectHero: HeroLogo },

  './SessionChatInput': {
    SessionChatInput: (props: any) => {
      composerProps = props;
      composerRenders += 1;
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
  // One object, as the real provider's context value is.
  '@/components/kortix/toast-provider': {
    useToast: () => toastApi,
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
  '@/components/session/SessionRuntime': { useSessionRuntime: () => runtimeValue },

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
  // The SDK's React layer: the stores and pure helpers stay real; the hooks
  // that read the network and the runtime calls are stand-ins.
  '@kortix/sdk/react': {
    useSessionSync: () => ({
      hasOlder: false,
      isLoadingOlder: false,
      loadOlder: spy('loadOlder'),
      retryTranscript: spy('reconcile'),
    }),
    // Unpaced: the page asks for a 64 ms pace, the tests read each change at once.
    useSessionMessages: (source: { runtimeSessionId?: string | null }) =>
      useSessionStateStore((state) => {
        const id = source.runtimeSessionId ?? '';
        return state.buildSessionMessages(id, state.messages[id], state.parts);
      }),
    useRuntimeSession: () => ({ data: { title: 'Saved title' } }),
    // React Query hands the same `data` until it changes.
    useRuntimeSessions: () => ({ data: NO_ROWS }),
    useRuntimeConfig: () => ({ data: null }),
    useRuntimeCommands: () => ({ data: NO_ROWS }),
    useQuestionSelfHeal: () => {},
    usePermissionSelfHeal: () => {},
    answerQuestion: spy('answerQuestion'),
    rejectQuestion: spy('rejectQuestion'),
    answerPermission: spy('answerPermission'),
    abortRuntimeSession: spy('abortRuntimeSession'),
    promptRuntimeMessage: spy('promptRuntimeMessage'),
    executeRuntimeCommand: async (input: unknown) => {
      calls.push({ name: 'command', args: [input] });
      if (!commandResponder().ok) throw new Error(commandResponder().text);
    },
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
    useSessionParticipants: () => ({ data: sessionParticipants }),
    useSessionMessageAuthors: () => ({ data: messageAuthors }),
  },
  '@/lib/session/local-config': { useResolvedConfig: () => resolvedConfig },
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
  '@/lib/session/participants',
  '@/lib/session/types',
  '@/lib/session/session-store',
  '@/lib/session/runtime-capabilities',
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
  '@/lib/session/permission-prompt',
  '@/lib/session/queue-undo',
  '@/lib/session/older-history',
  '@/lib/session/attachment-tile',
  '@/lib/utils/theme',
  '@/stores/tab-store',
  '@/stores/message-queue-store',
  '@/stores/session-prompt-request-store',
  '@/stores/composer-draft-store',
  '@/components/session/tool/shared/connector-handoff-context',
]);

const CAPTURE = [
  '@kortix/sdk/react',
  '@/lib/projects/hooks',
  '@/lib/session/local-config',
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
/** The SDK store keeps a session's message infos and each message's parts apart. */
const appendMessages = (rows: MessageWithParts[]) =>
  useSessionStateStore.setState(
    (state) =>
      ({
        messages: { ...state.messages, [SID]: [...(state.messages[SID] ?? []), ...rows.map((row) => row.info)] },
        parts: { ...state.parts, ...Object.fromEntries(rows.map((row) => [row.info.id, row.parts])) },
      }) as any,
  );
const setStatus = (status: { type: string }) =>
  useSessionStateStore.setState(
    (state) => ({ sessionStatus: { ...state.sessionStatus, [SID]: status } }) as any,
  );
const seedRows = (rows: MessageWithParts[]) => {
  appendMessages(rows);
  setStatus({ type: 'idle' });
};
const seedTurns = (texts: string[]) => seedRows(texts.flatMap((text) => makeTurn(text)));
const statusOf = () => useSessionStateStore.getState().sessionStatus[SID];
const userTexts = () =>
  sessionRows(SID)
    .filter((row) => row.info.role === 'user')
    .map((row) => (row.parts[0] as any)?.text);

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
  useSessionStateStore.getState().reset();
  useRuntimePendingStore.getState().clear();
  useTabStore.setState({ tabStateById: {} } as any);
  useMessageQueueStore.setState({ messages: [], hydrated: true } as any);
  useFailedSendStore.setState({ bySession: {} } as any);
  useSessionPromptRequestStore.setState({ request: null } as any);
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
  configureKortix({ backendUrl: 'https://api.test/v1', getToken: async () => 'token-1' });
  ({ useMessageQueueStore } = await import('@/stores/message-queue-store'));
  SessionPage = (await import('./SessionPage')).SessionPage;
  SessionConnecting = (await import('./SessionConnecting')).SessionConnecting;
});

beforeEach(() => {
  calls.length = 0;
  timingStarts.length = 0;
  holdTimings = false;
  turnProps = [];
  sessionParticipants = undefined;
  messageAuthors = undefined;
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
  healthPillProps = null;
  composerProps = null;
  composerRenders = 0;
  gestureAreaProps = null;
  keyboardListeners.clear();
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
  abortResponder = pass;
  commandResponder = pass;
  abortThrows = false;
  inboxRows = [];
  inboxFails = false;
  runtimeValue = {
    switched: true,
    runtimeSessionId: SID,
    isCompacting: false,
    // The SDK's Stop: it settles, it never rejects for a refused abort.
    cancel: async () => {
      calls.push({ name: 'cancel', args: [] });
      if (abortThrows) throw new Error('offline');
      return abortResponder().ok ? { status: 'aborted' } : { status: 'failed', error: new Error('boom') };
    },
    rewind: async (messageId: string) => {
      calls.push({ name: 'rewind', args: [messageId] });
    },
  };
  resetStores();
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: any;
    try {
      body = init?.body ? JSON.parse(init.body) : undefined;
    } catch {
      body = init?.body;
    }
    fetchCalls.push({ url, method, body });
    if (url.includes('/projects/proj-1/sessions/ps-1/prompts')) {
      // A new body per read, as the network gives.
      if (method === 'GET') return okResponse({ prompts: structuredClone(inboxRows) });
      if (method === 'POST' && url.endsWith('/prompts')) {
        if (inboxFails) return respond(fail);
        return okResponse({ prompt_id: 'p-new', state: 'queued', message_id: body?.message_id, deduped: false });
      }
      return okResponse({});
    }
    return okResponse({});
  }) as any;
});

afterEach(async () => {
  if (tree) await act(async () => tree?.unmount());
  tree = undefined;
});

// ── Scroll physics ───────────────────────────────────────────────────────────

describe('inactive sandbox navigation', () => {
  test('session health pill does not offer the legacy instance selector', async () => {
    await renderPage();
    expect(healthPillProps).not.toBeNull();
    expect(healthPillProps?.onSwitch).toBeUndefined();
  });
});

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
    expect(userTexts()).toContain('hello');
    expect(statusOf()).toEqual({ type: 'busy' });

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
  const inboxPosts = () =>
    fetchCalls.filter((c) => c.method === 'POST' && c.url.endsWith('/projects/proj-1/sessions/ps-1/prompts'));

  test('a queued message goes to the server inbox in order with the composer overrides', async () => {
    await renderPage();
    const options = { agent: 'builder', model: { providerID: 'prov', modelID: 'mod' }, variant: 'high' };
    await act(async () => {
      await composerProps.onEnqueue('first', options);
      await composerProps.onEnqueue('second', {});
    });
    expect(inboxPosts().map((c) => (c.body as any).parts[0].text)).toEqual(['first', 'second']);
    expect(inboxPosts()[0].body).toMatchObject({
      placement: 'composer',
      overrides: { agent: 'builder', model: { providerID: 'prov', modelID: 'mod' }, variant: 'high' },
    });
    expect((inboxPosts()[1].body as any).overrides).toEqual({ agent: null, model: null, variant: null });
    // The server drains the inbox: the client sends nothing to the runtime itself.
    expect(fetchCalls.some((c) => c.url.endsWith('/prompt_async'))).toBe(false);
  });

  test('a refused inbox write toasts, rethrows, and leaves nothing in the local queue', async () => {
    inboxFails = true;
    await renderPage();
    let thrown: unknown;
    await act(async () => {
      await composerProps.onEnqueue('held', {}).catch((e: unknown) => (thrown = e));
    });
    expect(thrown).toBeTruthy();
    expect(toastsOf('error').map((t) => t.message)).toContain('Could not queue the message. Try again.');
    expect(useMessageQueueStore.getState().messages).toEqual([]);
  });

  test('pre-upgrade local rows move to the server inbox and leave the local store', async () => {
    useMessageQueueStore.setState({
      hydrated: true,
      messages: [{ id: 'legacy-1', sessionId: SID, text: 'from before', timestamp: 1_700_000_000_000 }],
    } as any);
    await renderPage();
    await act(async () => {
      await sleep(30);
    });
    expect(inboxPosts().map((c) => c.body)).toMatchObject([
      { client_message_id: 'legacy-1', parts: [{ type: 'text', text: 'from before' }], remint_on_delivery: true },
    ]);
    expect(useMessageQueueStore.getState().messages).toEqual([]);
  });

  test('Send now asks the server to run that queued prompt next', async () => {
    inboxRows = [
      { prompt_id: 'p-1', client_message_id: 'c-1', message_id: 'm-1', state: 'queued', reason: 'turn_active', text: 'urgent', attempts: 0, last_error: null, created_at: '', available_at: '' },
    ];
    seedTurns(['one']);
    await renderPage();
    await act(async () => {
      await sleep(15);
    });
    const toggle = buttons.find((props) => String(props.accessibilityLabel ?? '').includes('queued messages'));
    expect(toggle).toBeTruthy();
    await act(async () => {
      toggle.onPress();
      await sleep(15);
    });
    const sendNow = buttons.filter((props) => props.accessibilityLabel === 'Send now');
    expect(sendNow).toHaveLength(1);
    await act(async () => {
      sendNow[0].onPress();
      await sleep(15);
    });
    expect(
      fetchCalls.filter((c) => c.method === 'POST' && c.url.endsWith('/prompts/p-1/retry')),
    ).toHaveLength(1);
  });
});

// ── Send / retry / stop ──────────────────────────────────────────────────────

describe('SessionPage send, retry and stop', () => {
  test('a failed prompt keeps the message in the thread and a retry re-sends it under the same ids', async () => {
    const inboxPosts = () =>
      fetchCalls.filter((c) => c.method === 'POST' && c.url.endsWith('/projects/proj-1/sessions/ps-1/prompts'));
    seedTurns(['one']);
    await renderPage();
    await act(async () => {
      inboxFails = true;
      composerProps.onSend('hello', {});
      await sleep(15);
    });
    expect(statusOf()).toEqual({ type: 'idle' });
    // The server never had it, so it is not in the transcript; the thread
    // still shows it, dimmed, from the failed-send store.
    expect(userTexts()).toEqual(['one']);
    const failed = useFailedSendStore.getState().bySession[SID] ?? {};
    const [failedId] = Object.keys(failed);
    expect(failed[failedId]).toMatchObject({ text: 'hello' });
    const shown = listProps.data.map((turn: any) => [
      turn.userMessage.info.id,
      turn.userMessage.parts[0]?.text,
    ]);
    expect(shown.at(-1)).toEqual([failedId, 'hello']);

    const retryTurn = turnProps.findLast((props) => props.uploadStatus?.state === 'failed');
    expect(retryTurn.turn.userMessage.info.id).toBe(failedId);
    expect(retryTurn.uploadStatus.onRetry).toBeTypeOf('function');
    await act(async () => {
      inboxFails = false;
      retryTurn.uploadStatus.onRetry();
      await sleep(15);
    });
    // The retry re-posts under the failed attempt's ids — the prompt inbox
    // dedupes on `client_message_id`, so a retry cannot double-run.
    const posts = inboxPosts();
    expect(posts).toHaveLength(2);
    expect(posts[1].body.client_message_id).toBe(posts[0].body.client_message_id);
    expect(posts[1].body.message_id).toBe(posts[0].body.message_id);
    expect(posts[1].body.message_id).toBe(failedId);
    expect(posts[1].body.parts).toEqual(posts[0].body.parts);
    // One 'hello' again, now an accepted optimistic message under the same id.
    const after = sessionRows(SID).filter(
      (row) => row.info.role === 'user' && (row.parts[0] as any).text === 'hello',
    );
    expect(after).toHaveLength(1);
    expect(after[0].info.id).toBe(failedId);
    expect(useFailedSendStore.getState().bySession[SID]?.[failedId]).toBeUndefined();
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
    // The root thread stops through the SDK (inbox hold, then abort).
    expect(seen('cancel')).toHaveLength(1);
    expect(statusOf()).toEqual({ type: 'busy' });
    expect(toastsOf('error')).toEqual([
      { kind: 'error', message: "Couldn't stop. Kortix is still working." },
    ]);

    await act(async () => {
      abortThrows = true;
      composerProps.onStop();
      await sleep(15);
    });
    expect(statusOf()).toEqual({ type: 'busy' });
    expect(toastsOf('error')).toHaveLength(2);

    await act(async () => {
      abortThrows = false;
      abortResponder = pass;
      composerProps.onStop();
      await sleep(15);
    });
    expect(statusOf()).toEqual({ type: 'idle' });
    expect(toastsOf('error')).toHaveLength(2);
  });
});

// ── Composer option assembly ────────────────────────────────────────────────

describe('SessionPage prompt-options assembly', () => {
  test('a requested prompt goes to the prompt inbox with the resolved agent, model key and variant', async () => {
    await renderPage();
    await act(async () => {
      useSessionPromptRequestStore.getState().requestSend(SID, 'open change text');
      await sleep(15);
    });
    // Through the prompt inbox, like every send of the session's own thread.
    const post = fetchCalls.find((c) => c.method === 'POST' && c.url.endsWith('/prompts'));
    expect(post?.body).toMatchObject({
      parts: [{ type: 'text', text: 'open change text' }],
      overrides: { agent: 'builder', model: { providerID: 'prov', modelID: 'mod' }, variant: 'high' },
    });
    expect(fetchCalls.some((c) => c.url.endsWith('/prompt_async'))).toBe(false);
    expect(useSessionPromptRequestStore.getState().request).toBeNull();
  });

  test('editing a message reverts to it and sends the edited text with the same resolved options', async () => {
    const [user, assistant] = makeTurn('original');
    seedRows([user, assistant]);
    await renderPage();
    await act(async () => {
      turnProps[0].onEditStart(user.info.id, 'edited');
      await sleep(15);
    });
    await act(async () => {
      turnProps.at(-1).onEditSend(user.info.id, 'edited');
      await sleep(15);
    });
    // The SDK rewinds the session to the edited message.
    expect(seen('rewind')[0]?.args).toEqual([user.info.id]);
    // The messages the revert hides leave the thread; the edit goes out as a send.
    expect(sessionRows(SID).map((row) => [(row.parts[0] as any).text, row.info.role])).toEqual([
      ['edited', 'user'],
    ]);
    const post = fetchCalls.find((c) => c.method === 'POST' && c.url.endsWith('/prompts'));
    expect(post?.body).toMatchObject({
      parts: [{ type: 'text', text: 'edited' }],
      overrides: { agent: 'builder', model: { providerID: 'prov', modelID: 'mod' }, variant: 'high' },
    });
    expect(fetchCalls.some((c) => c.url.endsWith('/prompt_async'))).toBe(false);
  });

  test('a slash command posts the command with the resolved agent, model string and variant', async () => {
    await renderPage();
    await act(async () => {
      composerProps.onCommand({ name: 'review' }, 'args');
      await sleep(15);
    });
    expect(seen('command')[0]?.args[0]).toEqual({
      sessionId: SID,
      command: 'review',
      args: 'args',
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

// ── Shared session: who sent each prompt ─────────────────────────────────────

describe('SessionPage shared-session sender', () => {
  const MEMBER = { user_id: 'member', name: 'Marko', email: 'member@example.test', avatar_url: null, is_viewer: false };
  const ME = { ...MEMBER, user_id: 'me', name: 'Me', is_viewer: true };
  const author = (person: typeof MEMBER) => ({
    kind: 'member' as const,
    user_id: person.user_id,
    name: person.name,
    email: person.email,
    avatar_url: person.avatar_url,
  });
  const avatarOf = (person: typeof MEMBER) => ({ name: person.name, email: person.email, avatar_url: person.avatar_url });
  const shared = { participants: [ME, MEMBER], total: 2, multi_user: true };
  const userMessageId = () =>
    sessionRows(SID).find((row) => row.info.role === 'user')!.info.id;

  test("a single-user session passes no sender for the viewer's own prompt", async () => {
    seedTurns(['one']);
    sessionParticipants = { participants: [ME], total: 1, multi_user: false };
    messageAuthors = { authors: { [userMessageId()]: author(ME) }, initial_author: null };
    await renderPage();
    expect(turnProps.at(-1).sender).toBeNull();
  });

  test("the viewer's own prompt passes the viewer as its sender in a shared session", async () => {
    seedTurns(['one']);
    sessionParticipants = shared;
    messageAuthors = { authors: { [userMessageId()]: author(ME) }, initial_author: null };
    await renderPage();
    expect(turnProps.at(-1).sender).toEqual(avatarOf(ME));
  });

  test('a shared session passes a turn the other person who wrote its prompt', async () => {
    seedTurns(['one']);
    sessionParticipants = shared;
    messageAuthors = { authors: { [userMessageId()]: author(MEMBER) }, initial_author: null };
    await renderPage();
    expect(turnProps.at(-1).sender).toEqual(avatarOf(MEMBER));
  });

  test("a prompt with no recorded author, or another session's agent, stays without an avatar", async () => {
    seedTurns(['one']);
    sessionParticipants = shared;
    messageAuthors = { authors: {}, initial_author: null };
    await renderPage();
    expect(turnProps.at(-1).sender).toBeNull();
    messageAuthors = { authors: { [userMessageId()]: { kind: 'session', session_id: 'ses_lead', name: 'Lead' } }, initial_author: null };
    await renderPage();
    expect(turnProps.at(-1).sender).toBeNull();
  });
});

// ── Render work: what must not re-render, and what must not stay mounted ─────

describe('SessionPage render work', () => {
  const aborted = { name: 'MessageAbortedError', data: { message: 'aborted' } };
  /** A stream delta: new text on one message, nothing else. */
  const streamDelta = async (messageId: string, text: string) => {
    await act(async () => {
      useSessionStateStore.setState(
        (state) => ({ parts: { ...state.parts, [messageId]: [{ id: `part-${messageId}`, type: 'text', text }] } }) as any,
      );
      await sleep(15);
    });
  };
  const heroMounted = () => tree!.root.findAllByType(HeroLogo).length > 0;
  const spacerHeight = () =>
    viewProps.findLast((props) => props.onLayout && typeof props.style?.height === 'number')?.style.height;

  test('the fresh-session hero shows on an empty session and unmounts once its fade-out ends', async () => {
    await renderPage();
    expect(heroMounted()).toBe(true);
    await act(async () => {
      appendMessages(makeTurn('one'));
      await sleep(15);
    });
    expect(heroMounted()).toBe(false);
  });

  /** The hero's opacity fades: the only timings the page starts with an end callback. */
  const heroFades = () => timingStarts.filter((start) => start.done);
  const clearMessages = () =>
    useSessionStateStore.setState((state) => ({ messages: { ...state.messages, [SID]: [] } }) as any);

  test('the fresh-session hero mounts again, fading in, when the session is empty again', async () => {
    await renderPage();
    await act(async () => {
      appendMessages(makeTurn('one'));
      await sleep(15);
    });
    expect(heroMounted()).toBe(false);
    expect(heroFades().at(-1)?.toValue).toBe(0);
    await act(async () => {
      clearMessages();
      await sleep(15);
    });
    expect(heroMounted()).toBe(true);
    expect(heroFades().at(-1)?.toValue).toBe(1);
  });

  test('an interrupted fade-out keeps the fresh-session hero mounted', async () => {
    holdTimings = true;
    await renderPage();
    await act(async () => {
      appendMessages(makeTurn('one'));
      await sleep(15);
    });
    const fadeOut = heroFades().at(-1)!;
    expect(fadeOut.toValue).toBe(0);
    await act(async () => fadeOut.done!({ finished: false }));
    expect(heroMounted()).toBe(true);
    // The same callback with a finished fade unmounts it: the check above is not vacuous.
    await act(async () => fadeOut.done!({ finished: true }));
    expect(heroMounted()).toBe(false);
  });

  test('a session with messages never mounts the fresh-session hero', async () => {
    seedTurns(['one']);
    await renderPage();
    expect(heroMounted()).toBe(false);
  });

  test('a stream delta and a new runtime object keep renderItem and Stop, and a stranded prompt stays interrupted', async () => {
    const user = userMsg('one');
    const reply = assistantMsg('partial', user.info.id);
    (reply.info as any).error = aborted;
    const stranded = userMsg('two');
    seedRows([user, reply, stranded]);
    await renderPage();
    const queueStateOf = (id: string) => turnProps.findLast((props) => props.turn.userMessage.info.id === id)?.queueState;
    expect(queueStateOf(stranded.info.id)).toBe('interrupted');
    const renderItem = listProps.renderItem;
    const onStop = composerProps.onStop;

    await streamDelta(reply.info.id, 'partial, more');
    expect(listProps.renderItem).toBe(renderItem);
    expect(queueStateOf(stranded.info.id)).toBe('interrupted');

    // `useSession` hands a new object on every render; the fields are the same.
    runtimeValue = { ...runtimeValue };
    await streamDelta(reply.info.id, 'partial, more, again');
    expect(listProps.renderItem).toBe(renderItem);
    expect(composerProps.onStop).toBe(onStop);

    // Stop still reaches the runtime the page has now.
    let cancelled = 0;
    runtimeValue = { ...runtimeValue, cancel: async () => ((cancelled += 1), { status: 'aborted' }) };
    await act(async () => {
      setStatus({ type: 'busy' });
      await sleep(15);
    });
    await act(async () => {
      composerProps.onStop();
      await sleep(15);
    });
    expect(cancelled).toBe(1);
  });

  test('a shared session hands each turn the same sender object until the authors change', async () => {
    seedTurns(['one']);
    const id = sessionRows(SID).find((row) => row.info.role === 'user')!.info.id;
    sessionParticipants = { participants: [], total: 2, multi_user: true };
    messageAuthors = {
      authors: { [id]: { kind: 'member', user_id: 'member', name: 'Marko', email: 'member@example.test', avatar_url: null } },
      initial_author: null,
    };
    await renderPage();
    const first = turnProps.at(-1).sender;
    expect(first).toEqual({ name: 'Marko', email: 'member@example.test', avatar_url: null });
    const reply = sessionRows(SID).find((row) => row.info.role === 'assistant')!.info.id;
    const before = turnProps.length;
    await streamDelta(reply, 'a longer reply');
    expect(turnProps.length).toBeGreaterThan(before);
    expect(turnProps.at(-1).sender).toBe(first);
  });

  test('an inbox read with the same rows does not re-render the composer, and the rows still show', async () => {
    inboxRows = [
      { prompt_id: 'p-1', client_message_id: 'c-1', message_id: 'm-1', state: 'queued', reason: 'turn_active', text: 'later', attempts: 0, last_error: null, created_at: '', available_at: '' },
    ];
    seedTurns(['one']);
    await renderPage();
    await act(async () => {
      await sleep(15);
    });
    const toggle = buttons.find((props) => String(props.accessibilityLabel ?? '').includes('queued messages'));
    expect(toggle).toBeTruthy();
    await act(async () => {
      toggle.onPress();
      await sleep(15);
    });
    const renders = composerRenders;
    // Send now re-reads the inbox: the same row comes back.
    const sendNow = buttons.findLast((props) => props.accessibilityLabel === 'Send now');
    await act(async () => {
      sendNow.onPress();
      await sleep(15);
    });
    expect(fetchCalls.filter((c) => c.method === 'GET' && c.url.endsWith('/prompts')).length).toBeGreaterThan(1);
    expect(composerRenders).toBe(renders);
    expect(composerProps.inputSlot).toBeTruthy();
  });

  test('the composer height reaches the gesture area without a page render', async () => {
    seedTurns(['one']);
    await renderPage();
    const bottomArea = viewProps.findLast(
      (props) => props.onLayout && props.children?.props?.inputNativeID === `composer-input-${SID}`,
    );
    expect(bottomArea).toBeTruthy();
    const renders = composerRenders;
    await act(async () => {
      bottomArea.onLayout({ nativeEvent: { layout: { height: 120.4 } } });
    });
    expect(gestureAreaProps.offset).toBe(120);
    expect(composerRenders).toBe(renders);
  });

  test('while the keyboard moves a shrinking room waits for it to stop, a growing room commits at once', async () => {
    seedTurns(['one']);
    await renderPage();
    // One 200pt turn in a 600pt list: room = 600 − 200 − 24 = 376.
    await layoutTranscript(576, [200]);
    expect(spacerHeight()).toBe(376);
    const renders = composerRenders;

    await act(async () => {
      keyboardEvent('keyboardWillShow');
    });
    for (const height of [500, 400, 300]) {
      listProps.onLayout({ nativeEvent: { layout: { height } } });
      await act(async () => {
        await sleep(5);
      });
    }
    // No page render per keyboard frame; the blank room is clipped meanwhile.
    expect(composerRenders).toBe(renders);
    expect(spacerHeight()).toBe(376);
    await act(async () => {
      keyboardEvent('keyboardDidShow');
      await sleep(15);
    });
    expect(spacerHeight()).toBe(76);

    // Closing: the room grows with the list, frame by frame, as before.
    await act(async () => {
      keyboardEvent('keyboardWillHide');
    });
    listProps.onLayout({ nativeEvent: { layout: { height: 400 } } });
    await act(async () => {
      await sleep(5);
    });
    expect(spacerHeight()).toBe(176);
  });

  test('a long thread stays pinned to its end while the keyboard opens', async () => {
    seedTurns(['one']);
    await renderPage();
    await layoutTranscript(724, [700]);
    expect(scrollToCalls.at(-1)).toEqual({ offset: 148, animated: false });
    await act(async () => {
      keyboardEvent('keyboardWillShow');
    });
    listProps.onLayout({ nativeEvent: { layout: { height: 300 } } });
    await act(async () => {
      await sleep(5);
    });
    // content 724 − viewport 300.
    expect(scrollToCalls.at(-1)).toEqual({ offset: 424, animated: false });
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

  test('a shared session labels the saved prompts while the computer wakes, not only once it runs', async () => {
    const MEMBER = { user_id: 'member', name: 'Marko', email: 'member@example.test', avatar_url: null, is_viewer: false };
    const messages = [...makeTurn('one'), ...makeTurn('two')];
    const firstPrompt = messages.find((m) => m.info.role === 'user')!.info.id;
    sessionParticipants = { participants: [MEMBER], total: 2, multi_user: true };
    messageAuthors = {
      authors: { [firstPrompt]: { kind: 'member', user_id: 'member', name: 'Marko', email: 'member@example.test', avatar_url: null } },
      initial_author: null,
    };
    await act(async () => {
      tree = create(
        React.createElement(SessionConnecting, {
          messages,
          statusLabel: 'Waking the computer',
          sessionId: SID,
          onCancel: () => {},
          projectId: 'project',
          projectSessionId: 'project-session',
        } as any),
      );
    });
    expect(turnProps.map((props) => props.sender)).toEqual([
      { name: 'Marko', email: 'member@example.test', avatar_url: null },
      null,
    ]);
  });

  test('the waking composer is disabled: no text, no send', async () => {
    await renderSavedThread({});
    expect(wakingComposerProps.disabled).toBe(true);
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
    // Restart is the default (primary) pill; Back to project is secondary.
    const restartButton = buttons.find((props) => props.onPress && props.variant === 'default');
    expect(buttons.some((props) => props.onPress && props.variant === 'secondary')).toBe(true);
    expect(restartButton).toBeTruthy();
    await act(async () => {
      restartButton.onPress();
    });
    expect(seen('restart')).toHaveLength(1);
  });
});
