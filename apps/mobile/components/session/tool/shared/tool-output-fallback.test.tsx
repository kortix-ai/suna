/**
 * Characterization of the tool-output fallback card (`ToolOutputFallback`).
 *
 * The card is what a user sees when a tool's output is not one of the shapes
 * a dedicated renderer handles. Its rules, locked in here before the card's
 * unreachable second JSON branch is removed (only
 * `parseJsonFailure` may speak the `{success:false,error}` dialect):
 * - the `{success:false,error}` contract renders the failure card, with the
 *   nested `{"message","status"}` payload surfaced as the failure message;
 * - an EMPTY error string in the contract still takes the failure branch (no
 *   raw JSON leaks into the card);
 * - a normal success JSON object renders pretty-printed via the raw-output
 *   block, not the failure card;
 * - malformed JSON falls through to the markdown output tile;
 * - a plain `Error: …` string renders the error tile;
 * - streaming parts do not reach the fallback at all (the busy card wins).
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { configureKortix, type ToolPart } from '@kortix/sdk';
import { mockGraph } from '@/lib/testing/mock-graph';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { __DEV__?: boolean }).__DEV__ = false;

const host =
  (name: string) =>
  ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>): React.ReactElement =>
    React.createElement(name, props, children);

await mockGraph(
  ['components/session/tool/shared/infrastructure.tsx'],
  ['@kortix/sdk', '@/lib/session/tool-part-accessors', '@/lib/session/activity', './styles', './surface', './result-card', '../tool-error'],
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
        light: { background: 'bg', surface: 'sf', foreground: 'fg', mutedForeground: 'mf', secondary: 'sec', danger: 'dgr', warning: 'wrn', border: 'bd' },
        dark: { background: 'bg-d', surface: 'sf-d', foreground: 'fg-d', mutedForeground: 'mf-d', secondary: 'sec-d', danger: 'dgr-d', warning: 'wrn-d', border: 'bd-d' },
        accent: { blue: 'blue', yellow: 'yellow', orange: 'orange', green: 'green', purple: 'purple', red: 'red' },
      },
      withAlpha: (color: string) => color,
      MOTION: { duration: { normal: 120 }, easing: { inOut: [0.4, 0, 0.2, 1] } },
    },
    '@/lib/utils/mono-font': { MONO_FONT_FAMILY: 'mono' },
    '@/lib/session/user-message': { webSpace: (n: number) => n * 4 },
    '@/lib/session/disclosure-store': {
      disclosureKey: (kind: string, id: string) => `${kind}:${id}`,
      useDisclosureStore: (selector: (s: Record<string, never>) => unknown) => selector({}),
      useDisclosureChoice: () => undefined,
      useDisclosureState: () => ({ open: false, toggle: () => {}, set: () => {} }),
      useDisclosureOpen: () => false,
      useDisclosureToggle: () => {},
      resolveDisclosureOpen: () => false,
      DisclosureToggle: host('disclosure'),
    },
    '@/components/ui/text': { Text: host('text') },
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
    'expo-clipboard': { setStringAsync: async () => {} },
    'components/session/tool/shared/code-card': {
      ToolMarkdown: ({ content }: { content: string }) => React.createElement('text', null, content),
      ToolCode: ({ content }: { content: string }) => React.createElement('text', null, content),
      ToolCodeCard: host('code-card'),
      ToolMarkdownCard: host('markdown-card'),
      ToolOutputCard: host('output-card'),
    },
  },
);

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'test-token' });

let ToolOutputFallback: (props: { output: string; isStreaming?: boolean; toolName?: string }) => React.ReactNode;
beforeAll(async () => {
  ({ ToolOutputFallback } = await import('./infrastructure'));
});

const texts = (instance: ReturnType<typeof create>): string[] =>
  instance.root
    .findAll((n: { props: { children?: unknown } }) => typeof n.props?.children === 'string')
    .map((n: { props: { children?: unknown } }) => n.props.children as string);

const render = (output: string, isStreaming = false): ReturnType<typeof create> => {
  let instance!: ReturnType<typeof create>;
  act(() => {
    instance = create(<ToolOutputFallback output={output} isStreaming={isStreaming} toolName="grep" />);
  });
  return instance;
};

/** A completed part whose output is the given string, the way callers pass it. */
const completed = (output: unknown): ToolPart =>
  ({ type: 'tool', id: 'fpt-1', callID: 'call-1', tool: 'grep', state: { status: 'complete', input: {}, output, time: {} } }) as unknown as ToolPart;

describe('ToolOutputFallback', () => {
  test('renders the failure card for the {"success":false,"error"} contract', () => {
    const tree = render('{"success":false,"error":"Tool crashed"}');
    expect(texts(tree)).toContain('Tool crashed');
    expect(texts(tree).some((t) => t.includes('"success"'))).toBe(false);
  });

  test('surfaces the nested {"message","status"} payload as the failure message', () => {
    const nested = JSON.stringify({
      success: false,
      error: `Request failed: ${JSON.stringify({ message: 'Nothing found', status: 500 })}`,
    });
    const tree = render(nested);
    expect(texts(tree)).toContain('Nothing found');
  });

  test('an empty error string in the contract still takes the failure branch', () => {
    const tree = render('{"success":false,"error":""}');
    expect(texts(tree).some((t) => t.includes('"success"'))).toBe(false);
  });

  test('renders pretty-printed raw JSON for a normal success output', () => {
    const tree = render('{"result":{"files":["a.ts","b.ts"],"count":2}}');
    const rendered = texts(tree).join('\n');
    expect(rendered).toContain('"files"');
    expect(rendered).toContain('"a.ts"');
  });

  test('malformed JSON output falls back to the markdown output tile', () => {
    const tree = render('{oops');
    expect(texts(tree)).toContain('{oops');
  });

  test('a plain `Error: …` string renders the error tile', () => {
    const tree = render('Error: boom');
    expect(texts(tree)).toContain('boom');
  });

  test('a streaming part renders the tile without any failure or raw-JSON framing', () => {
    const tree = render('partial output', true);
    expect(texts(tree)).toEqual(['partial output']);
  });
});
