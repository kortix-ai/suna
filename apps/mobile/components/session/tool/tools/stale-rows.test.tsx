/**
 * A call left `pending` with no input after its turn ended (Stop, interrupted
 * turn) is stale: its run is over. History must show it as still text, never
 * as the animated "working" shimmer. A live running call keeps the shimmer.
 */

import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host = (name: string) => ({ children, ...props }: HostProps) => React.createElement(name, props, children);
const Passthrough = ({ children }: HostProps) => React.createElement(React.Fragment, null, children);

const ToolMotionContext = React.createContext(true);
const PALETTE = { foreground: 'fg', muted60: 'm60', muted40: 'm40', muted80: 'm80', success: 'ok' };
const none = () => null;

mock.module('react-native', () => ({ View: host('view'), Pressable: host('pressable') }));
mock.module('@/components/kortix/text-shimmer', () => ({
  // Like the real one: still text while the row's motion is off.
  TextShimmer: ({ children }: HostProps) =>
    React.useContext(ToolMotionContext)
      ? React.createElement('shimmer', null, children)
      : React.createElement('text', null, children),
  RunningLoader: none,
  ToolMotionContext,
}));
mock.module('@/components/ui/text', () => ({ Text: host('text') }));
mock.module('@/lib/icons', () => ({
  ArrowClockwiseIcon: none,
  CalendarDotsIcon: none,
  CheckIcon: none,
  FileIcon: none,
  FolderIcon: none,
  GlobeIcon: none,
  MagnifyingGlassIcon: none,
  MonitorPlayIcon: none,
  PlusIcon: none,
  ProhibitIcon: none,
  ReadCvLogoIcon: none,
  TerminalIcon: none,
  TrashIcon: none,
  TreeStructureIcon: none,
  WarningCircleIcon: none,
  WarningIcon: none,
}));
mock.module('@/components/ui/badge', () => ({ Badge: Passthrough }));
mock.module('@/lib/session/disclosure-store', () => ({
  disclosureKey: (kind: string, id: string) => `${kind}:${id}`,
  useDisclosureState: () => ({ open: true, toggle: () => {} }),
}));
mock.module('@/components/session/chain-of-thought', () => ({
  DisclosureContent: ({ open, children }: HostProps) => (open ? React.createElement(React.Fragment, null, children) : null),
}));
mock.module('@/lib/session/turn-body', () => ({ toDisplayPath: (path: string) => path }));
mock.module('@/lib/utils/theme', () => ({ THEME: { accent: { red: 'red' } } }));

// The REAL `../shared/infrastructure` runs (its contexts, `BasicTool`, `ToolEmptyState`,
// `useToolLive`, the `partOutput` accessors). Only its heavy leaf modules are stubbed.
mock.module('../shared/navigation', () => ({
  InlineServicePreview: none,
  ServicePreviewActions: none,
  ServicePreviewUrlFallback: none,
  ServicePreviewViewport: none,
  ToolFilePreviewHost: none,
  ToolNavigationContext: React.createContext(true),
  useProxyUrl: () => null,
  useServicePreview: () => ({}),
  useToolFilePreviewStore: () => ({}),
  useToolNavigation: () => ({ openFile: () => {} }),
}));
mock.module('../shared/code-card', () => ({
  HighlightedCode: none,
  MD_FLUSH_CLASSES: '',
  MarkdownFrontmatterCard: none,
  ToolCode: none,
  ToolCodeCard: none,
  ToolMarkdown: none,
  ToolMarkdownCard: none,
  ToolOutputCard: none,
}));
mock.module('../shared/inline-diff-view', () => ({ DiffView: none, InlineDiffView: none }));
mock.module('../shared/structured-output', () => ({ StructuredOutput: none }));
mock.module('../shared/diagnostics', () => ({ DiagnosticsDisplay: none, getToolDiagnostics: () => [] }));
mock.module('../shared/result-card', () => ({ ToolResultCard: Passthrough }));
mock.module('../tool-error', () => ({ ToolError: none }));
mock.module('../shared/surface', () => ({
  TOOL_INDENT: 0,
  ToolCardFrame: Passthrough,
  ToolCaret: none,
  ToolCopyButton: none,
  ToolDetailContext: React.createContext(null),
  ToolIconSlot: none,
  ToolRowVariantContext: React.createContext({ chain: false, hideIcon: false }),
  ToolScroll: Passthrough,
  ToolSurfaceContext: React.createContext('inline'),
  useToolCardFrame: () => null,
  useToolCardPad: () => 0,
  useToolIndent: () => 0,
  useToolRowVariant: () => ({ chain: false, hideIcon: false }),
}));
mock.module('../shared/output-block', () => ({
  OutputBlock: ({ text }: { text: string }) => React.createElement('text', null, text),
  FoldedSection: Passthrough,
}));
mock.module('../shared/session-helpers', () => ({ InlineSessionMessagesList: none, SessionMetadataList: none }));
mock.module('../shared/styles', () => ({
  TURN_SPACE: { gap1_5: 6, statusIcon: 12, icon: 14, rowPadY: 2, bodyPadY: 4, cardPad: 8, gap2: 8, gap3: 12 },
  TURN_TYPE: { xs: {}, sm: {}, rowSm: {} },
  FONT_MEDIUM: 'medium',
  fg: () => ({}),
  monoFont: 'mono',
  muted: () => ({}),
  useTurnPalette: () => PALETTE,
}));

let BashTrigger: typeof import('./bash-tool').BashTrigger;
let ReadTool: typeof import('./read-tool').ReadTool;
let ProjectGetTool: typeof import('./project-get-tool').ProjectGetTool;
let TriggersTool: typeof import('./triggers-tool').TriggersTool;
let infrastructure: typeof import('../shared/infrastructure');

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  infrastructure = await import('../shared/infrastructure');
  ({ BashTrigger } = await import('./bash-tool'));
  ({ ReadTool } = await import('./read-tool'));
  ({ ProjectGetTool } = await import('./project-get-tool'));
  ({ TriggersTool } = await import('./triggers-tool'));
});

let tree: ReactTestRenderer | undefined;
afterEach(() => {
  if (tree) act(() => tree?.unmount());
  tree = undefined;
});

const shimmers = () => tree!.root.findAllByType('shimmer' as never);
const shimmerTexts = () => shimmers().map((node) => node.props.children);
const words = () => tree!.root.findAllByType('text' as never).map((node) => node.props.children);

function bash(props: { command: string; running: boolean; status: string }) {
  const element = React.createElement(BashTrigger as React.ComponentType<Record<string, unknown>>, {
    title: 'Ran command',
    failed: false,
    commandPreview: props.command,
    extraLines: 0,
    ...props,
  });
  act(() => {
    tree = create(element);
  });
}

function read(running: boolean) {
  const part = { id: 'p', callID: 'c', tool: 'read', state: { status: 'pending', input: {} } };
  const element = React.createElement(
    infrastructure.ToolRunningContext.Provider,
    { value: running },
    React.createElement(ReadTool as unknown as React.ComponentType<Record<string, unknown>>, { part }),
  );
  act(() => {
    tree = create(element);
  });
}

describe('bash row', () => {
  test('a stale input-less call is still muted text, with no shimmer', () => {
    bash({ command: '', running: false, status: 'pending' });
    expect(shimmers()).toHaveLength(0);
    expect(words()).toEqual(['Working...']);
  });

  test('a live running call keeps its shimmer', () => {
    bash({ command: 'ls -la', running: true, status: 'running' });
    expect(shimmers().length).toBeGreaterThan(0);
  });
});

describe('read row body', () => {
  test('a stale input-less read is still muted text, with no shimmer', () => {
    read(false);
    expect(shimmers()).toHaveLength(0);
    expect(words()).toContain('Waiting for file content...');
  });

  test('a live pending read draws no stale body at all', () => {
    read(true);
    expect(shimmers()).toHaveLength(0);
    expect(words()).not.toContain('Waiting for file content...');
  });
});

describe('empty-output bodies (project-get, triggers)', () => {
  const part = (tool: string, input: Record<string, unknown> = {}, output = '', status = 'running') => ({
    id: 'p',
    callID: 'c',
    tool,
    state: { status, input, output },
  });
  function body(
    Tool: React.ComponentType<Record<string, unknown>>,
    running: boolean,
    motion: boolean,
    input?: Record<string, unknown>,
    output = '',
    status = 'running',
  ) {
    const element = React.createElement(
      infrastructure.ToolRunningContext.Provider,
      { value: running },
      React.createElement(
        ToolMotionContext.Provider,
        { value: motion },
        React.createElement(Tool, { part: part('x', input, output, status) }),
      ),
    );
    act(() => {
      tree = create(element);
    });
  }
  const cases = [
    ['project-get', () => ProjectGetTool as unknown as React.ComponentType<Record<string, unknown>>],
    ['triggers', () => TriggersTool as unknown as React.ComponentType<Record<string, unknown>>],
  ] as const;

  for (const [name, tool] of cases) {
    test(`${name}: a running call in a live turn shows the loading shimmer`, () => {
      body(tool(), true, true);
      expect(shimmerTexts().some((text: unknown) => String(text).startsWith('Loading'))).toBe(true);
      expect(words()).not.toContain('No output');
    });
    test(`${name}: a running call in a finished turn shows a still empty state, not the shimmer`, () => {
      body(tool(), true, false);
      expect(shimmers()).toHaveLength(0);
      expect(words()).toContain('No output');
    });
    test(`${name}: a finished call with real output still renders that output`, () => {
      body(tool(), false, true, {}, 'plain result text', 'completed');
      expect(shimmers()).toHaveLength(0);
      expect(words()).toContain('plain result text');
      expect(words()).not.toContain('No output');
    });
    test(`${name}: a settled call with empty output shows the still empty state`, () => {
      body(tool(), false, true);
      expect(shimmers()).toHaveLength(0);
      expect(words()).toContain('No output');
    });
  }
});
