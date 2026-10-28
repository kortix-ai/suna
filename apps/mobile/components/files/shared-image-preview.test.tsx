/**
 * R38 on mobile: an image the card loaded opens in the file sheet from the
 * app's shared image store (its native source, no blob read, no loader), and
 * a `show` of the same bytes at another path (a Drive copy) draws that source
 * with no probe. Native surfaces are host stand-ins.
 */
import { afterEach, beforeAll, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host = (name: string) => ({ children, ...props }: HostProps) => React.createElement(name, props, children);
const none = () => null;
const SANDBOX = 'https://sandbox.example/v1/p/synthetic/8000';

mock.module('react-native', () => ({
  Platform: { OS: 'ios' },
  View: host('view'),
  Image: host('image'),
  ScrollView: host('scroll'),
  Pressable: host('pressable'),
  StyleSheet: { absoluteFill: {} },
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
mock.module('react-native-webview', () => ({ WebView: host('webview') }));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'dark' }) }));
mock.module('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
mock.module('expo-file-system/legacy', () => ({}));
mock.module('@/components/markdown/mermaid/MermaidBlock', () => ({ MermaidBlock: none }));
mock.module('@/components/ui/text', () => ({ Text: host('text') }));
mock.module('@/components/ui/icon', () => ({ Icon: none }));
mock.module('@/components/ui/button', () => ({ Button: host('button') }));
mock.module('@/components/kortix/kortix-loader', () => ({ KortixLoader: host('loader') }));
mock.module('@/components/kortix/pressable-surface', () => ({ PressableSurface: host('pressable') }));
mock.module('@/components/kortix/selectable-markdown', () => ({ SelectableMarkdownText: host('markdown') }));
mock.module('@/lib/utils/theme', () => ({
  THEME: {
    light: { background: 'bg', foreground: 'fg', card: 'card', border: 'border', destructive: 'red', muted: 'muted', mutedForeground: 'mfg', accent: { blue: 'blue' } },
    dark: { background: 'bg', foreground: 'fg', card: 'card', border: 'border', destructive: 'red', muted: 'muted', mutedForeground: 'mfg', accent: { blue: 'blue' } },
  },
  withAlpha: (color: string) => color,
  MOTION: { duration: { fast: 100, normal: 150, moderate: 200, slow: 300, slower: 500 }, easing: { default: [0.2, 0, 0, 1], in: [0.4, 0, 1, 1], out: [0, 0, 0.2, 1], inOut: [0.4, 0, 0.2, 1] } },
}));
/** Every Reanimated timing the caption disclosure started: its target and duration. A timing completes at once. */
const timings: { to: number; duration: number }[] = [];
mock.module('react-native-reanimated', () => ({
  default: { View: host('animated') },
  Easing: { bezier: (...curve: number[]) => curve, out: () => 0, cubic: 0 },
  runOnJS: (fn: () => void) => fn,
  // One object per mount, as Reanimated keeps it.
  useSharedValue: (value: unknown) => React.useRef({ value }).current,
  useAnimatedStyle: () => ({}),
  withTiming: (to: number, config: { duration: number }, done?: (finished: boolean) => void) => {
    timings.push({ to, duration: config.duration });
    done?.(true);
    return to;
  },
}));
let reduceMotion = false;
mock.module('@/components/session/dot-matrix/use-reduce-motion', () => ({ useReduceMotion: () => reduceMotion }));
mock.module('@/lib/utils/mono-font', () => ({ MONO_FONT_FAMILY: 'mono' }));
mock.module('@/lib/logger', () => ({ log: { error: none, warn: none } }));
mock.module('@/lib/utils/open-link', () => ({ openLink: async () => {} }));
mock.module('@/lib/utils/html-embed', () => ({ HTML_SANITIZER_SCRIPT: '', decidePreviewNavigation: () => 'allow', escapeForInlineScript: (s: string) => s }));
mock.module('@/lib/icons', () =>
  Object.fromEntries(
    ['ArrowSquareOutIcon', 'FileIcon', 'FileTextIcon', 'FileXIcon', 'GlobeIcon', 'MusicNotesIcon', 'PlayIcon', 'WarningIcon', 'WarningCircleIcon', 'InfoIcon', 'DownloadSimpleIcon', 'PlusIcon', 'CaretRightIcon'].map((name) => [name, none]),
  ),
);
mock.module('@/contexts/SandboxContext', () => ({ useSandboxContext: () => ({ sandboxUrl: SANDBOX }) }));
/** Every file read the sheet started: the blob read and the text read, by path. */
const reads: (string | undefined)[] = [];
mock.module('@/lib/files/hooks', () => ({
  useSandboxFileContent: (_url: string | undefined, path: string | undefined) => (reads.push(path && `text:${path}`), { data: undefined, isLoading: false, error: null, refetch: none }),
  useSandboxFileBlob: (_url: string | undefined, path: string | undefined) => (reads.push(path && `blob:${path}`), { data: undefined, isLoading: !!path, error: null, refetch: none }),
  blobToDataURL: async () => 'data:',
  downloadSandboxFileToCache: async () => 'file:///cache/fox.png',
}));
mock.module('@/components/kortix/pinned-bar', () => ({ PinnedBar: host('bar'), usePinnedBarInset: () => 56 }));
mock.module('@/components/kortix/sheet', () => ({ CopyContentButton: none, KortixBottomSheetModal: host('sheet') }));
mock.module('@/components/kortix/toast-provider', () => ({ useToast: () => ({ success: none, error: none }) }));
mock.module('@/components/session/tool/shared/tool-icons', () => ({ showFileTypeIcon: () => none }));
mock.module('@/lib/files/save-to-device', () => ({ saveFileToDevice: async () => ({ status: 'saved', folder: 'Downloads' }) }));
mock.module('@/lib/haptics', () => ({ haptics: { tap: none, selection: none, success: none, warning: none } }));
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => ({ 'imageGen.details': 'Image details' })[key] ?? key }) }));
/** Every path the show card's own sandbox-image load was enabled for. */
const probes: string[] = [];
mock.module('@/components/session/turn/use-sandbox-image', () => ({
  useSandboxImage: (path: string, enabled: boolean) => {
    if (enabled) probes.push(path);
    return { phase: 'probing', source: undefined, sizeBytes: null, attempt: 0, loadAnyway: none, handleError: none };
  },
  useSandboxUrl: () => SANDBOX,
}));
mock.module('../session/tool/shared/infrastructure', () => ({
  HighlightedCode: none,
  MarkdownFrontmatterCard: none,
  ToolMarkdown: none,
  useToolNavigation: () => ({ enabled: true, openFile: none, openExternal: none }),
}));
mock.module('../session/tool/shared/surface', () => ({ ToolScroll: host('scroll') }));
mock.module('../session/tool/shared/styles', () => ({
  FONT_MEDIUM: 'medium',
  TURN_SPACE: { gap2: 8, radiusMd: 8 },
  TURN_TYPE: { xs: {} },
  monoFont: 'mono',
  useTurnPalette: () => ({ muted: '#eee', foreground: '#000', mutedForeground: '#777', secondary: '#ddd', border: '#ccc' }),
}));

let rememberSharedImage: typeof import('@/lib/files/shared-image').rememberSharedImage;
let clearSharedImages: typeof import('@/lib/files/shared-image').clearSharedImages;
let useFilePreviewData: typeof import('./use-file-preview-data').useFilePreviewData;
let FilePreview: typeof import('./FilePreviewRenderers').FilePreview;
let ShowContentRenderer: typeof import('../session/tool/tools/show-content-renderer').ShowContentRenderer;
let FilePreviewBody: typeof import('./FilePreviewSheet').FilePreviewBody;
beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ rememberSharedImage, clearSharedImages } = await import('@/lib/files/shared-image'));
  ({ useFilePreviewData } = await import('./use-file-preview-data'));
  ({ FilePreview } = await import('./FilePreviewRenderers'));
  ({ ShowContentRenderer } = await import('../session/tool/tools/show-content-renderer'));
  ({ FilePreviewBody } = await import('./FilePreviewSheet'));
});

let tree: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => tree?.unmount());
  tree = undefined;
  reads.length = 0;
  probes.length = 0;
  timings.length = 0;
  reduceMotion = false;
  // Order-independent: an empty store per test.
  clearSharedImages();
});

const FOX = '/workspace/output/images/fox.png';
const SHA = 'e'.repeat(64);
const CARD_SOURCE = { uri: `${SANDBOX}/file/raw?path=${encodeURIComponent(FOX)}`, headers: { Authorization: 'Bearer synthetic' } };

function Sheet({ path }: { path: string }) {
  const file = { name: path.split('/').pop()!, path, type: 'file' as const, size: 0, modified: 0 };
  const preview = useFilePreviewData(file as never, SANDBOX);
  return (
    <FilePreview
      content={null}
      fileName={file.name}
      previewType={preview.previewType}
      blobUrl={preview.blobUrl}
      filePath={path}
      sandboxUrl={SANDBOX}
      imageSource={preview.imageSource}
      imageRatio={preview.imageRatio}
      onImageSourceError={preview.dropImageSource}
    />
  );
}
const texts = () => (tree?.root.findAll((node) => node.type === 'text') ?? []).map((node) => ([] as unknown[]).concat(node.props.children).join(''));

test('full screen opens without a loading state when the card already loaded the image', async () => {
  // What the card stores when its image decodes (`SandboxImageAttempt`).
  rememberSharedImage(SANDBOX, FOX, SHA, CARD_SOURCE, { width: 1254, height: 836 });
  await act(async () => {
    tree = create(<Sheet path={FOX} />);
  });
  const images = tree!.root.findAll((node) => node.type === 'image');
  expect(images.map((image) => image.props.source)).toEqual([CARD_SOURCE]);
  // At the measured ratio at once, with no loader and no "Loading image...".
  expect(images[0]!.props.style).toMatchObject({ width: 368, height: 368 / (1254 / 836) });
  expect(tree!.root.findAll((node) => (node.type as string) === 'loader')).toHaveLength(0);
  expect(texts().join(' ')).not.toContain('Loading image');
  expect(reads.filter(Boolean)).toEqual([]);
});

test('a miss reads the file as before', async () => {
  await act(async () => {
    tree = create(<Sheet path="/workspace/other.png" />);
  });
  expect(reads.filter(Boolean)).toEqual(['blob:/workspace/other.png']);
});

test('a show image with the same sha256 as a generated image renders from cache, with no probe', async () => {
  rememberSharedImage(SANDBOX, FOX, SHA, CARD_SOURCE);
  const DRIVE = '/workspace/drives/me/space/images/fox.png';
  await act(async () => {
    tree = create(<ShowContentRenderer type="image" path={DRIVE} sha256={SHA} />);
  });
  expect(tree!.root.findAll((node) => node.type === 'image').map((image) => image.props.source)).toEqual([CARD_SOURCE]);
  expect(probes).toEqual([]);
  // The copy is linked: the sheet opened on the Drive path is a hit too.
  await act(async () => tree?.unmount());
  await act(async () => {
    tree = create(<Sheet path={DRIVE} />);
  });
  expect(tree!.root.findAll((node) => node.type === 'image').map((image) => image.props.source)).toEqual([CARD_SOURCE]);
  expect(reads.filter(Boolean)).toEqual([]);
});

test('the caption is hidden until the info button is pressed', async () => {
  rememberSharedImage(SANDBOX, FOX, SHA, CARD_SOURCE, { width: 1254, height: 836 });
  const caption = { text: 'A fox in a shuttle', model: 'codex/gpt-image-2' };
  await act(async () => {
    tree = create(<FilePreviewBody file={{ name: 'fox.png', path: FOX, caption }} sandboxUrl={SANDBOX} onCopyTextChange={none} />);
  });
  const toggle = () => tree!.root.find((node) => node.props.testID === 'file-caption-toggle' && typeof node.props.onPress === 'function');
  const section = () => tree!.root.findAll((node) => node.props.testID === 'file-caption-section' && typeof node.type === 'string');
  expect(texts()).not.toContain('A fox in a shuttle');
  expect(section()).toHaveLength(0);
  expect(toggle().props.accessibilityLabel).toBe('Image details');
  expect(toggle().props.accessibilityRole).toBe('togglebutton');
  expect(toggle().props.accessibilityState).toEqual({ checked: false });
  // Open: the disclosure expands (height + opacity) over 200 ms.
  await act(async () => (toggle().props.onPress as () => void)());
  expect(texts()).toEqual(expect.arrayContaining(['A fox in a shuttle', 'codex/gpt-image-2']));
  expect(toggle().props.accessibilityState).toEqual({ checked: true });
  expect(timings).toEqual([{ to: 1, duration: 200 }]);
  // Close: it collapses faster, 150 ms, then unmounts.
  await act(async () => (toggle().props.onPress as () => void)());
  expect(timings).toEqual([{ to: 1, duration: 200 }, { to: 0, duration: 150 }]);
  expect(section()).toHaveLength(0);
  expect(texts()).not.toContain('A fox in a shuttle');
});

test('reduced motion skips the caption transition', async () => {
  reduceMotion = true;
  const caption = { text: 'A fox in a shuttle', model: 'codex/gpt-image-2' };
  await act(async () => {
    tree = create(<FilePreviewBody file={{ name: 'fox.png', path: FOX, caption }} sandboxUrl={SANDBOX} onCopyTextChange={none} />);
  });
  const toggle = () => tree!.root.find((node) => node.props.testID === 'file-caption-toggle' && typeof node.props.onPress === 'function');
  await act(async () => (toggle().props.onPress as () => void)());
  expect(texts()).toContain('A fox in a shuttle');
  await act(async () => (toggle().props.onPress as () => void)());
  expect(texts()).not.toContain('A fox in a shuttle');
  expect(timings).toEqual([]);
});

test('the info button is absent without caption data', async () => {
  await act(async () => {
    tree = create(<FilePreviewBody file={{ name: 'fox.png', path: FOX }} sandboxUrl={SANDBOX} onCopyTextChange={none} />);
  });
  expect(tree!.root.findAll((node) => node.props.testID === 'file-caption-toggle')).toHaveLength(0);
});

