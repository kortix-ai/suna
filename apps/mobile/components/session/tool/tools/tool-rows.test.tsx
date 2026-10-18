/**
 * Characterization for the row surfaces the panel deletion must not disturb:
 * the `agent_spawn` row while the worker runs and once it completes (trigger
 * title, verification line, the worker's output), and the `read` row's loaded
 * instruction rows (one tappable row per loaded path, tapping opens the file).
 */

import { beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
// @ts-ignore -- this app has no @types/react-test-renderer
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { toolCallBlock, type ToolPart } from '@kortix/sdk';
import { mockGraph } from '@/lib/testing/mock-graph';
import {
  isErrorOutput,
  partInput,
  partMetadata,
  partOutput,
  partRawOutput,
  partStatus,
  partStreamingInput,
} from '@/lib/session/tool-part-accessors';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { __DEV__?: boolean }).__DEV__ = false;

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host =
  (name: string) =>
  ({ children, ...props }: HostProps) =>
    React.createElement(name, props, children);
const none = () => null;

const openFile = mock(() => {});

await mockGraph(
  ['components/session/tool/tools/agent-spawn-tool.tsx', 'components/session/tool/tools/read-tool.tsx'],
  [
    '@kortix/sdk',
    '@kortix/shared',
    'lib/session/tools/agents-spawn',
    'components/session/tool/tools/sub-agent',
    'lib/session/tools/files-search',
    'lib/session/tools/files-write-edit',
    'lib/session/turn-body',
    'lib/session/activity',
    'lib/session/tool-part-accessors',
    'lib/session/connector-handoff',
  ],
  {
    '@rn-primitives/slot': { Slot: host('slot'), SlotPressable: host('slot-pressable') },
    'react-native/Libraries/Utilities/codegenNativeComponent': { default: () => null },
    'react-native/Libraries/Utilities/codegenNativeCommands': { default: () => null },
    'react-native-css-interop': { jsx: host('jsx'), jsxs: host('jsx'), Fragment: 'frag', cssInterop: () => {}, remapProps: () => {}, useRGBA: () => '' },
    'react-native': {
      View: host('view'),
      Pressable: host('pressable'),
      ScrollView: host('scroll-view'),
      Text: host('rn-text'),
      Image: host('image'),
      StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s, hairlineWidth: 1 },
      Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios },
    },
    'nativewind': { useColorScheme: () => ({ colorScheme: 'light' }) },
    '@/lib/utils/theme': {
      THEME: {
        light: { background: 'bg', foreground: 'fg', card: 'card', muted: 'mu', mutedForeground: 'mfg', border: 'bd', destructive: 'dest', success: 'ok', warning: 'w', secondary: 'sec', popover: 'po' },
        dark: { mutedForeground: 'mfg-d' },
        accent: { blue: 'blue', yellow: 'yellow', orange: 'orange', green: 'green', purple: 'purple', red: 'red' },
      },
      MOTION: { duration: { normal: 150, fast: 100 }, easing: { inOut: [0.4, 0, 0.2, 1] } },
      withAlpha: (c: string, a?: number) => `alpha(${c},${a})`,
    },
    '@/lib/utils/mono-font': { MONO_FONT_FAMILY: 'mono' },
    '@/lib/session/user-message': { webSpace: (n: number) => n * 4 },
    '@/components/ui/text': { Text: host('text') },
    '@/components/ui/button': { Button: host('button') },
    '@/components/ui/icon': { Icon: none },
    '@/components/kortix/text-shimmer': {
      TextShimmer: host('shimmer'),
      RunningLoader: none,
      ToolMotionContext: React.createContext(true),
    },
    '@/components/session/chain-of-thought': { DisclosureContent: host('disclosure') },
    '@/lib/session/disclosure-store': {
      disclosureKey: (kind: string, id: string) => `${kind}:${id}`,
      useDisclosureState: () => ({ open: true, toggle: () => {} }),
    },
    // The row chrome under test's outer shells, as prop-printing stand-ins.
    'components/session/tool/shared/infrastructure': {
      BasicTool: ({ trigger, children }: { trigger?: unknown; children?: React.ReactNode }) => (
        <view>
          {typeof trigger === 'object' && trigger !== null && 'title' in (trigger as Record<string, unknown>)
            ? <text>{String((trigger as { title?: string }).title)}</text>
            : null}
          {children}
        </view>
      ),
      isErrorOutput,
      partInput,
      partMetadata,
      partOutput,
      partRawOutput,
      partStatus,
      partStreamingInput,
      ToolCodeCard: host('code-card'),
      ToolOutputFallback: host('tool-output-fallback'),
      ToolResultCard: ({ children }: HostProps) => <view>{children}</view>,
      ToolEmptyState: ({ message }: { message: string }) => <text>{message}</text>,
      ToolRunningContext: React.createContext(false),
      ToolSurfaceContext: React.createContext<'transcript' | 'panel'>('transcript'),
      TurnLiveContext: React.createContext(false),
      useToolNavigation: () => ({ openFile, openSession: () => {}, openExternal: () => {}, openPreview: () => {}, enabled: true }),
    },
    'components/session/tool/shared/output-block': {
      OutputBlock: ({ text, children }: { text?: unknown; children?: React.ReactNode }) => (
        <view>
          {typeof text === 'string' && text.length > 0 ? <text>{text}</text> : null}
          {children}
        </view>
      ),
      FoldedSection: ({ children }: HostProps) => <view>{children}</view>,
      ToolSection: ({ children }: HostProps) => <view>{children}</view>,
    },
    'components/session/tool/shared/registry': { ToolRegistry: { register: () => {}, get: () => undefined } },
    'components/session/tool/shared/styles': {
      TURN_SPACE: { gap1_5: 6, gap2: 8, icon: 16 },
      TURN_TYPE: { xs: {}, sm: {} },
      monoFont: 'mono',
      useTurnPalette: () => ({
        background: 'bg', foreground: 'fg', card: 'card', muted: 'mu', mutedForeground: 'mfg',
        border: 'bd', destructive: 'dest', success: 'ok', warning: 'w',
      }),
    },
    'components/session/tool/shared/surface': {
      ToolSurfaceContext: React.createContext<'transcript' | 'panel'>('transcript'),
      ToolDetailContext: React.createContext(false),
      ToolIconSlot: React.createContext(null),
      useToolIndent: () => 0,
      useToolRowVariant: () => 'default',
    },
    'components/session/tool/shared/navigation': {
      InlineServicePreview: none,
      ServicePreviewActions: none,
      ServicePreviewUrlFallback: none,
      ServicePreviewViewport: none,
      ToolFilePreviewHost: none,
      ToolNavigationContext: React.createContext(true),
      useProxyUrl: () => null,
      useServicePreview: () => ({}),
      useToolFilePreviewStore: () => ({}),
      useToolNavigation: () => ({ openFile, openSession: () => {}, openExternal: () => {}, openPreview: () => {}, enabled: true }),
    },
    'components/session/tool/tool-part-renderer': { ToolPartRenderer: none },
    '../tool-error': { ToolError: host('tool-error') },
    'components/session/tool/shared/code-card': {
      HighlightedCode: none,
      MD_FLUSH_CLASSES: '',
      MarkdownFrontmatterCard: none,
      ToolCode: none,
      ToolCodeCard: host('code-card'),
      ToolMarkdown: host('markdown'),
      ToolOutputCard: host('output-card'),
    },
    'components/session/tool/shared/inline-diff-view': { DiffView: none, InlineDiffView: none },
    'components/session/tool/shared/structured-output': { StructuredOutput: none },
    'components/session/tool/shared/diagnostics': { DiagnosticsDisplay: none, getToolDiagnostics: () => null },
    // Sub-agent's data sources: no child thread, an idle child session.
    '@/components/session/SessionRuntime': { useRuntimeThread: () => null },
    '@/lib/session/session-store': {
      useSessionStatus: () => null,
      usePendingPermissions: () => [],
      useSessionStreaming: () => false,
    },
    '@/components/session/session-retry-display': {
      SessionRetryDisplay: none,
      useRetrySecondsLeft: () => 0,
    },
    '@/components/session/SessionErrorBanner': { TurnErrorDisplay: none },
  },
);

type AgentSpawn = typeof import('./agent-spawn-tool');
type ReadToolMod = typeof import('./read-tool');
let agentMod: AgentSpawn;
let readMod: ReadToolMod;
beforeAll(async () => {
  agentMod = await import('./agent-spawn-tool');
  readMod = await import('./read-tool');
});

const call = (tool: string, state: Record<string, unknown>) =>
  toolCallBlock({ type: 'tool', id: 'p', callID: 'c', tool, state } as unknown as ToolPart);

const texts = (renderer: ReactTestRenderer): string[] =>
  renderer.root
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- host fakes are untyped strings
    .findAll((node: any) => node.type === 'text' || node.type === 'rn-text')
    .flatMap((node) => {
      const children = node.props?.children;
      return Array.isArray(children) ? children.filter((c): c is string => typeof c === 'string') : typeof children === 'string' ? [children] : [];
    });

describe('agent_spawn rows', () => {
  test('a running worker shows its title and verification, not its output', async () => {
    let r!: ReactTestRenderer;
    await act(async () => {
      r = create(
        React.createElement(agentMod.AgentSpawnTool, {
          call: call('agent_spawn', { status: 'running', input: { verification_condition: 'tests pass' }, output: '' }),
        }),
      );
    });
    const t = texts(r).join('\n');
    expect(t).toContain('Spawn agent');
    expect(t).toContain('tests pass');
    expect(t).not.toContain('All done');
  });

  test('a completed worker shows the verification and its output', async () => {
    let r!: ReactTestRenderer;
    await act(async () => {
      r = create(
        React.createElement(agentMod.AgentSpawnTool, {
          call: call('agent_spawn', { status: 'completed', input: { verification_condition: 'tests pass' }, output: 'All done.' }),
        }),
      );
    });
    const t = texts(r).join('\n');
    expect(t).toContain('Spawn agent');
    expect(t).toContain('tests pass');
    expect(t).toContain('All done.');
  });
});

describe('read rows', () => {
  test('a completed read lists one tappable row per loaded path; a tap opens the file', async () => {
    openFile.mockClear();
    let r!: ReactTestRenderer;
    await act(async () => {
      r = create(
        React.createElement(readMod.ReadTool, {
          call: call('read', {
            status: 'completed',
            input: { path: '/a.ts' },
            output: JSON.stringify({ content: 'export {}' }),
            metadata: { loaded: ['/a.ts', '/b.ts'] },
          }),
        }),
      );
    });
    const t = texts(r).join('\n');
    expect(t).toContain('/a.ts');
    expect(t).toContain('/b.ts');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- host fakes are untyped strings
    const rows = r.root.findAll((n: any) => n.type === 'pressable' && n.props.accessibilityRole === 'link');
    expect(rows.length).toBe(2);
    await act(async () => rows[0].props.onPress());
    expect(openFile).toHaveBeenCalled();
  });
});
