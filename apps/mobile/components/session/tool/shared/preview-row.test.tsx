/**
 * Characterization of the tool-preview surface (`ServicePreviewRow`,
 * `useServicePreview`, `ServicePreviewViewport`) before the unreachable
 * panel-context layer is removed (KRTX-2416):
 * - a preview row is ONE tappable target: label, `localhost:port` subtitle,
 *   open affordance — never a viewport wrapper around a second control;
 * - `openInSession` for a sandbox (proxiable localhost) URL opens the
 *   in-session preview sheet (the tool-preview store receives the proxy URL),
 *   and for a public URL hands off to the system browser (`openLink`);
 * - without navigation enabled or a URL the row renders without a tap;
 * - `ServicePreviewViewport` outside a panel IS the row; inside a panel it
 *   draws the viewport instead.
 *
 * The heavy shared row itself is a stand-in that prints its props (the
 * `tool-part-renderer.test.tsx` pattern); the contracts here stay real:
 * `useServicePreview`/`useProxyUrl`/`useToolNavigation`, the tool-preview
 * store, the SDK URL parsing and the tool-surface context.
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
// @ts-ignore -- this app has no @types/react-test-renderer
import { act, create } from 'react-test-renderer';
import { configureKortix } from '@kortix/sdk';
import { mockGraph } from '@/lib/testing/mock-graph';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { __DEV__?: boolean }).__DEV__ = false;

const host =
  (name: string) =>
  ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>): React.ReactElement =>
    React.createElement(name, props, children);

const openLink = mock(() => Promise.resolve());
const getSandboxPortUrl = mock((_sandboxId: string, port: string) => `https://proxy.test/${port}/`);
const SANDBOX = { sandboxId: 'sbx-1', sandboxUrl: 'https://sbx-1.test', sandboxUuid: 'u1', sandboxName: 'sbx' };

await mockGraph(
  ['components/session/tool/shared/navigation.tsx'],
  [
    '@kortix/sdk',
    '@kortix/shared',
    '@/lib/session/tool-part-accessors',
    './styles',
    './surface',
    '@/stores/tool-preview-store',
    '@/stores/tool-file-preview-store',
    '@/stores/tab-store',
    './connector-handoff-context',
    'zustand',
    'zustand/middleware',
    'components/kortix/pressable-surface',
    'components/kortix/surface-context',
  ],
  {
    'react-native': {
      View: host('view'),
      Pressable: host('pressable'),
      ScrollView: host('scroll-view'),
      Text: host('text'),
      StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s, hairlineWidth: 1 },
      Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios },
    },
    'nativewind': { useColorScheme: () => ({ colorScheme: 'light' }) },
    '@/lib/utils/theme': {
      THEME: {
        light: {
          background: 'bg', surface: 'sf', foreground: 'fg', mutedForeground: 'mf', muted: 'mu',
          secondary: 'sec', border: 'bd', card: 'card', popover: 'po', success: 'ok', warning: 'w', destructive: 'd',
        },
        dark: {
          background: 'bg-d', surface: 'sf-d', foreground: 'fg-d', mutedForeground: 'mf-d', muted: 'mu-d',
          secondary: 'sec-d', border: 'bd-d', card: 'card-d', popover: 'po-d', success: 'ok-d', warning: 'w-d', destructive: 'd-d',
        },
        accent: { blue: 'blue', yellow: 'yellow', orange: 'orange', green: 'green', purple: 'purple', red: 'red' },
      },
      withAlpha: (color: string) => color,
      MOTION: { duration: { normal: 120 }, easing: { inOut: [0.4, 0, 0.2, 1] } },
    },
    '@/lib/utils/mono-font': { MONO_FONT_FAMILY: 'mono' },
    '@/lib/session/user-message': { webSpace: (n: number) => n * 4 },
    '@/components/ui/text': { Text: host('text') },
    '@/lib/utils/open-link': { openLink },
    '@/lib/platform/client': { getSandboxPortUrl },
    '@/contexts/SandboxContext': {
      SandboxContext: React.createContext(SANDBOX),
      useSandboxContext: () => SANDBOX,
      SandboxProvider: host('sandbox-provider'),
    },
    'react-native-reanimated': {
      default: { View: host('reanimated-view') },
      Extrapolation: { CLAMP: 'clamp' },
      interpolate: () => 0,
      useAnimatedStyle: () => ({}),
      useSharedValue: (v: unknown) => ({ value: v }),
      withTiming: (v: unknown) => v,
      withRepeat: (v: unknown) => v,
      withDelay: (_: unknown, v: unknown) => v,
      cancelAnimation: () => {},
      runOnJS: (fn: unknown) => fn,
      useReducedMotion: () => false,
      Easing: { bezier: () => (t: number) => t, out: () => (t: number) => t, in: () => (t: number) => t, inOut: () => (t: number) => t, poly: () => (t: number) => t, linear: (t: number) => t },
    },
    '@/lib/session/disclosure-store': {
      disclosureKey: (kind: string, id: string) => `${kind}:${id}`,
      useDisclosureState: () => ({ open: false, toggle: () => {}, set: () => {} }),
      useDisclosureOpen: () => false,
      useDisclosureToggle: () => {},
      resolveDisclosureOpen: () => false,
      useDisclosureChoice: () => undefined,
      useDisclosureStore: (selector: (s: Record<string, never>) => unknown) => selector({}),
      DisclosureToggle: host('disclosure'),
    },
    // The shared row under test's outer shell, as a prop-printing stand-in.
    'components/session/tool/shared/result-row': {
      RESULT_ROW_TILE: 40,
      ResultRow: ({ title, subtitle, onPress }: { title: string; subtitle: string; onPress?: () => void }) =>
        React.createElement(
          'view',
          { 'data-title': title, onPress },
          React.createElement('text', null, `${title}|${subtitle}|${onPress ? 'open' : 'closed'}`),
        ),
    },
  },
);

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'test-token' });

let nav: typeof import('./navigation');
let useToolPreviewStore: (typeof import('@/stores/tool-preview-store'))['useToolPreviewStore'];
beforeAll(async () => {
  nav = await import('./navigation');
  ({ useToolPreviewStore } = await import('@/stores/tool-preview-store'));
});

const texts = (instance: ReturnType<typeof create>): string[] =>
  instance.root
    .findAll((n: { props: { children?: unknown } }) => typeof n.props?.children === 'string')
    .map((n: { props: { children?: unknown } }) => n.props.children as string);

const viewNodes = (instance: ReturnType<typeof create>) =>
  instance.root.findAll((n: { type: unknown }) => n.type === 'view');

/** Synthetic preview state, the shape `useServicePreview` returns. */
type ServicePreviewState = import('./navigation').ServicePreviewState;
const previewState = (over: Partial<ServicePreviewState> = {}): ServicePreviewState => ({
  navigationEnabled: true,
  proxy: null,
  previewUrl: 'https://example.com/report',
  isLoading: false,
  hasError: false,
  refreshKey: 0,
  handleRefresh: () => {},
  displayLabel: 'Report',
  openInSession: () => {},
  openInBrowser: () => {},
  onLoad: () => {},
  onError: () => {},
  ...over,
});

describe('tool preview rows', () => {
  test('a localhost preview renders ONE row: label, port subtitle, tap', async () => {
    const state = previewState({ displayLabel: 'Dev server', previewUrl: 'https://proxy.test/3000/' });
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<nav.ServicePreviewRow preview={state} url="http://localhost:3000/app" />);
    });
    expect(texts(tree)).toContain('Dev server|localhost:3000/app|open');
    // One row: the stand-in's single `view` node, no extra wrapper control.
    expect(viewNodes(tree).length).toBe(1);
  });

  test('a preview without navigation or URL renders closed, without a tap', async () => {
    const state = previewState({ navigationEnabled: false, previewUrl: null, displayLabel: 'Dev server' });
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<nav.ServicePreviewRow preview={state} url="http://localhost:3000/app" />);
    });
    expect(texts(tree)).toContain('Dev server|localhost:3000/app|closed');
  });

  test('useServicePreview: a sandbox preview opens the in-session preview sheet', async () => {
    let captured!: ServicePreviewState;
    const Probe = () => {
      captured = nav.useServicePreview('http://localhost:5173/app', 'Dev');
      return null;
    };
    await act(async () => {
      create(<Probe />);
    });
    expect(captured.proxy).not.toBeNull();
    expect(captured.previewUrl).toContain('proxy.test/5173');
    await act(async () => {
      captured.openInSession();
    });
    const store = useToolPreviewStore.getState();
    expect(store.url).toContain('proxy.test/5173');
    expect(store.label).toBe('Dev');
    expect(openLink).not.toHaveBeenCalled();
  });

  test('useServicePreview: a public-URL preview hands it to the system browser', async () => {
    let captured!: ServicePreviewState;
    const Probe = () => {
      captured = nav.useServicePreview('https://example.com/report', 'Report');
      return null;
    };
    await act(async () => {
      create(<Probe />);
    });
    expect(captured.proxy).toBeNull();
    expect(captured.previewUrl).toBe('https://example.com/report');
    openLink.mockClear();
    await act(async () => {
      captured.openInSession();
    });
    expect(openLink).toHaveBeenCalledWith('https://example.com/report');
  });

  test('the inline preview collapses to the one row (no panel wrapper remains)', async () => {
    const state = previewState({ displayLabel: 'Dev server', previewUrl: 'https://proxy.test/3000/' });
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<nav.InlineServicePreview url="http://localhost:3000/app" label="Dev server" />);
    });
    expect(texts(tree)).toContain('Dev server|localhost:3000/app|open');
  });
});
