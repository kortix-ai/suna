import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
// @ts-ignore -- this app has no @types/react-test-renderer
import { act, create } from 'react-test-renderer';

// FileViewer's in-place text editor (KRTX-2732 pins it before the inline
// editor is lifted out of the shell): open into edit mode, the pencil enters
// edit, Save writes through `useWriteSandboxFile`, closing with unsaved edits
// confirms a discard first, closing without edits closes directly.
//
// The mock wall is direct `mock.module` calls in a fixed order: bun merges a
// mock with the real module it replaces, so the fakes must cover every name
// the real packages import (react-native's Text/LogBox for nativewind, a
// `default` for reanimated, `@kortix/sdk` so the real hooks module never
// reaches expo-file-system's native shim — it dies in a circular import
// under bun).

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;
(globalThis as any).ErrorUtils = { getGlobalHandler: () => null, setGlobalHandler() {} };
(globalThis as any).expo = {
  EventEmitter: class {} as any,
  constants: {},
  modules: { ExpoAsset: {}, ExponentConstants: {}, ExpoUpdates: {}, ExpoGo: {} },
};

const host = (name: string) => ({ children, ...props }: any) => React.createElement(name, props, children);

let textContent: string | null = 'hello';
let textLoading = false;
let textError: unknown = null;
const writeCalls: unknown[] = [];
let writeShouldFail = false;
const confirmCalls: any[] = [];
let confirmOnConfirm: (() => void) | null = null;
const closed: number[] = [];
const alerts: string[] = [];

mock.module('react-native', () => ({
  LogBox: host('logbox'),
  View: host('view'),
  Text: host('text'),
  Modal: host('modal'),
  Pressable: host('pressable'),
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios },
  TextInput: host('text-input'),
  Keyboard: { dismiss() {} },
  KeyboardAvoidingView: host('avoid'),
  Alert: { alert: (...a: unknown[]) => alerts.push(String(a[0])) },
  TurboModuleRegistry: { get: () => null, getEnforcing: () => null },
  Appearance: { getColorScheme: () => 'light' },
  NativeEventEmitter: host('native-event-emitter'),
  NativeModules: {},
  AppRegistry: { registerComponent() {}, registerRunnable() {}, getApplication() {} },
  StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s },
  I18nManager: { isRTL: false, allowRTL() {}, forceRTL() {} },
  Dimensions: { get: () => ({ width: 390, height: 844 }), addEventListener: () => ({ remove() {} }) },
  PixelRatio: { get: () => 2 },
  BackHandler: { addEventListener: () => ({ remove() {} }) },
  StatusBar: { currentHeight: 0 },
  DevSettings: {},
  Easing: {},
  InteractionManager: { runAfterInteractions: (cb: () => void) => { cb(); return { cancel() {} } } },
  Vibration: {},
  processColor: (c: unknown) => c,
}));
mock.module('react-native-webview', () => ({ WebView: host('webview') }));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
mock.module('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
mock.module('expo-file-system/legacy', () => ({ cacheDirectory: '/cache/' }));
mock.module('react-native-reanimated', () => ({
  default: { createAnimatedComponent: (c: unknown) => c, View: host('animated-view') },
  useAnimatedStyle: () => ({}),
  useSharedValue: () => ({ value: 1 }),
  withSpring: () => 1,
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
  createAnimatedComponent: (c: unknown) => c,
}));
mock.module('expo-haptics', () => ({
  impactAsync: async () => {},
  ImpactFeedbackStyle: { Light: 0, Medium: 1 },
  NotificationFeedbackType: { Success: 0 },
  notificationAsync: async () => {},
}));
mock.module('expo-modules-core', () => ({
  NativeModule: class {},
  requireNativeModule: () => ({}),
  requireOptionalNativeModule: () => ({}),
}));
mock.module('@rn-primitives/portal', () => ({ PortalHost: host('portal-host') }));
mock.module('react-native-css-interop', () => ({ setupCSSInterop() {}, cssInterop() {}, remapProps() {} }));
mock.module('@kortix/sdk', () => ({
  deleteFile: async () => {},
  fileDownloadRequest: async () => ({}),
  listFiles: async () => ({}),
  readBlob: async () => new Blob(),
  readFile: async () => '',
  renameFile: async () => ({}),
  uploadNativeFile: async () => ({}),
}));
mock.module('@/components/ui/text', () => ({ Text: host('text') }));
mock.module('@/components/ui/icon', () => ({ Icon: host('icon') }));
mock.module('@/components/kortix/kortix-loader', () => ({ KortixLoader: host('loader') }));
mock.module('@/components/kortix/toast-provider', () => ({ useToast: () => ({ success() {}, error() {} }) }));
mock.module('@/components/kortix/sheet', () => ({ sheetHandleIndicatorStyle: () => ({}) }));
mock.module('@/components/kortix/confirm-dialog', () => ({
  useConfirmDialog: () => ({
    confirm: (options: any) => {
      confirmCalls.push(options);
      confirmOnConfirm = options.onConfirm;
    },
    // The dialog only matters through its confirm callback in these tests.
    dialog: React.createElement('confirm-dialog'),
  }),
}));
mock.module('@/lib/icons', () => ({
  XIcon: host('x'),
  DownloadIcon: host('download'),
  CaretLeftIcon: host('chev-left'),
  CaretRightIcon: host('chev-right'),
  PencilIcon: host('pencil'),
  CheckIcon: host('check'),
}));
mock.module('@/lib/logger', () => ({ log: { error() {}, warn() {}, log() {} } }));
mock.module('@/lib/utils/mono-font', () => ({ MONO_FONT_FAMILY: 'mono' }));
mock.module('@/lib/utils/theme', () => ({
  THEME: { dark: { background: 'd-bg', foreground: 'd-fg' }, light: { background: 'l-bg', foreground: 'l-fg' } },
  withAlpha: (color: string, alpha: number) => `${color}@${alpha}`,
}));
mock.module('@/lib/files/hooks', () => ({
  useWriteSandboxFile: () => ({
    isPending: false,
    mutateAsync: async (args: unknown) => {
      if (writeShouldFail) throw new Error('nope');
      writeCalls.push(args);
    },
  }),
  downloadSandboxFileToCache: async () => '/cache/x',
  blobToDataURL: async () => 'data:text/plain;base64,aGVsbG8=',
}));
mock.module('@/lib/files/save-to-device', () => ({ saveFileToDevice: async () => ({ status: 'saved', folder: 'Downloads' }) }));
mock.module('./use-file-preview-data', () => ({
  useFilePreviewData: () => ({
    previewType: 'text',
    isBinaryFile: false,
    shouldFetchText: true,
    textContent,
    textError,
    blob: null,
    blobError: null,
    blobTooLarge: false,
    blobUrl: undefined,
    isLoading: textLoading,
    error: null,
    size: textContent?.length ?? 0,
  }),
}));
mock.module('./FilePreviewRenderers', () => ({ FilePreview: host('file-preview') }));

let FileViewer: typeof import('./FileViewer').FileViewer;
beforeAll(async () => {
  ({ FileViewer } = await import('./FileViewer'));
});

const FILE = { name: 'notes.txt', path: '/workspace/notes.txt' } as never;

let tree: any;
function renderViewer(props: Record<string, unknown> = {}) {
  act(() => {
    tree = create(<FileViewer visible onClose={() => closed.push(1)} file={FILE} sandboxId="sbx" sandboxUrl="https://sbx.test" {...props} />);
  });
  return tree.root;
}

afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  textContent = 'hello';
  textLoading = false;
  textError = null;
  writeCalls.length = 0;
  writeShouldFail = false;
  confirmCalls.length = 0;
  confirmOnConfirm = null;
  closed.length = 0;
  alerts.length = 0;
});

const press = (root: any, label: string) => {
  const node = root.findAll((n: any) => n.type === 'pressable' && n.props.accessibilityLabel === label);
  expect(node.length).toBe(1);
  act(() => node[0]!.props.onPress());
};

const findPressableByText = (root: any, label: string) => {
  const node = root.findAll(
    (n: any) =>
      n.type === 'pressable' &&
      n.findAll((c: any) => c.type === 'text').some((t: any) => String(t.props.children) === label),
  );
  expect(node.length).toBe(1);
  return node[0]!;
};

describe('FileViewer edit mode', () => {

  test('a loaded text file shows the preview, not the editor', () => {
    const root = renderViewer();
    expect(root.findAllByType('file-preview').length).toBe(1);
    expect(root.findAllByType('text-input').length).toBe(0);
  });

  test('the pencil enters edit; the field starts from the file content', () => {
    const root = renderViewer();
    press(root, 'Edit file');
    const input = root.findByType('text-input');
    expect(input.props.value).toBe('hello');
    expect(root.findAllByType('file-preview').length).toBe(0);
  });

  test('initialEditing opens straight into the editor with an empty draft', () => {
    const root = renderViewer({ initialEditing: true });
    expect(root.findAllByType('file-preview').length).toBe(0);
    // Real behavior: the draft starts empty; only the pencil seeds it from the
    // loaded content (`handleStartEdit`), because initialEditing is for a file
    // that was just created.
    expect(root.findByType('text-input').props.value).toBe('');
  });

  test('Save writes the draft through useWriteSandboxFile and leaves edit mode', async () => {
    const root = renderViewer({ initialEditing: true });
    const input = root.findByType('text-input');
    act(() => input.props.onChangeText('hello world'));
    await act(async () => {
      await findPressableByText(root, 'Save').props.onPress();
    });
    expect(writeCalls).toEqual([{ sandboxUrl: 'https://sbx.test', path: '/workspace/notes.txt', content: 'hello world' }]);
    expect(root.findAllByType('file-preview').length).toBe(1);
  });

  test('a failed save keeps the editor and the draft, and alerts instead of toasting', async () => {
    writeShouldFail = true;
    const root = renderViewer({ initialEditing: true });
    const input = root.findByType('text-input');
    act(() => input.props.onChangeText('hello world'));
    await act(async () => {
      await findPressableByText(root, 'Save').props.onPress();
    });
    expect(alerts).toEqual(['Save failed']);
    expect(root.findByType('text-input').props.value).toBe('hello world');
  });

  test('leaving edit with unsaved changes confirms a discard first; confirming drops back to the preview, viewer stays open', () => {
    const root = renderViewer({ initialEditing: true });
    act(() => root.findByType('text-input').props.onChangeText('changed'));
    act(() => findPressableByText(root, 'Cancel').props.onPress());
    expect(confirmCalls.length).toBe(1);
    expect(confirmCalls[0]!.title).toBe('Discard changes?');
    expect(confirmCalls[0]!.description).toBe('Your edits will be lost.');
    expect(confirmCalls[0]!.cancelLabel).toBe('Keep editing');
    expect(confirmCalls[0]!.confirmLabel).toBe('Discard');
    expect(confirmCalls[0]!.destructive).toBe(true);
    // Nothing closed, still editing while the dialog is up.
    expect(closed).toEqual([]);
    expect(root.findAllByType('text-input').length).toBe(1);
    // Confirm discards the edits: back to the preview, viewer still open.
    act(() => confirmOnConfirm!());
    expect(closed).toEqual([]);
    expect(root.findAllByType('text-input').length).toBe(0);
    expect(root.findAllByType('file-preview').length).toBe(1);
  });

  test('keeping the edits (dialog cancel) returns to the editor untouched', () => {
    const root = renderViewer({ initialEditing: true });
    act(() => root.findByType('text-input').props.onChangeText('changed'));
    act(() => findPressableByText(root, 'Cancel').props.onPress());
    // Cancel is modelled as not calling onConfirm.
    expect(closed).toEqual([]);
    expect(root.findAllByType('text-input').length).toBe(1);
    expect(root.findByType('text-input').props.value).toBe('changed');
  });

  test('leaving edit without changes skips the confirm when the draft matches, and Close then closes directly', () => {
    const root = renderViewer();
    press(root, 'Edit file');
    // The pencil seeds the draft from the loaded content: not dirty, no confirm.
    act(() => findPressableByText(root, 'Cancel').props.onPress());
    expect(confirmCalls).toEqual([]);
    expect(root.findAllByType('text-input').length).toBe(0);
    press(root, 'Close');
    expect(closed).toEqual([1]);
  });

  test('from initialEditing the empty draft counts as dirty, so Cancel still confirms', () => {
    // Real quirk: the draft starts empty while the loaded content is not, so
    // `dirty` is true before any keystroke. Pinning it — created files are
    // empty in practice (draft === content === ''), this only bites when a
    // non-empty file is force-opened with initialEditing.
    const root = renderViewer({ initialEditing: true });
    act(() => findPressableByText(root, 'Cancel').props.onPress());
    expect(confirmCalls.length).toBe(1);
    expect(confirmCalls[0]!.title).toBe('Discard changes?');
  });

  test('closing without edits closes directly, no confirm', () => {
    const root = renderViewer();
    press(root, 'Close');
    expect(closed).toEqual([1]);
    expect(confirmCalls).toEqual([]);
  });

  test('a loading or failed text file cannot enter edit mode', () => {
    textLoading = true;
    const root = renderViewer();
    expect(root.findAll((n: any) => n.props.accessibilityLabel === 'Edit file').length).toBe(0);
    act(() => tree.unmount());
    textLoading = false;
    textError = 'boom';
    const failed = renderViewer();
    expect(failed.findAll((n: any) => n.props.accessibilityLabel === 'Edit file').length).toBe(0);
  });
});
