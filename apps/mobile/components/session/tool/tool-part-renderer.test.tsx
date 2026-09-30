/**
 * Dispatch characterization for `ToolPartRenderer` — renders the four live
 * paths the legacy-deletion spec (`code-spec:delete-mobile-legacy-expanded-content`)
 * must preserve:
 *
 * 1. a registered tool renders the registry's row — registry-first, before
 *    the legacy `getExpandedContent` switch ever runs;
 * 2. a completed unregistered tool with output renders the `RawOutputBlock`
 *    fallback (and whitespace-only output renders nothing);
 * 3. an error part renders the failed row with a `ToolError` body — the error
 *    branch wins even for a registered tool;
 * 4. a pending permission surfaces the inline prompt under the row.
 *
 * The module graph is stubbed the same way
 * `project-screen-characterization.test.tsx` stubs its graph: `View`/`Text`
 * render their children as hosts, the heavy shared render surfaces become
 * visible stand-ins, and the registered row is a marker component registered
 * under `bash` (registry parity with web is the conformance probe's job —
 * `tools/conformance.test.ts`). The pure contracts stay real: `@kortix/sdk`,
 * `shared/registry`, `shared/tool-part`, `lib/session/activity`,
 * `lib/session/disclosure-store`, `lib/session/user-message`,
 * `lib/opencode/diff-utils`, `stores/tab-store`. Mocks are file-scoped in
 * Bun 1.3; the graph here is only reachable from this file.
 */

import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { type ReactTestRenderer, act, create } from 'react-test-renderer';

// ─── Stand-ins for the heavy shared render surface ───────────────────────────

type HostProps = React.PropsWithChildren<Record<string, unknown>>;

/** Host `view`/`text` so the tree stays walkable without react-native. */
const View = ({ children, ...props }: HostProps) => React.createElement('view', props, children);
const Text = ({ children }: HostProps) => React.createElement('text', null, children);

/**
 * `BasicTool`'s trigger is an object on the fallback/error branches and a row
 * element on the registered one. The stand-in prints object triggers as one
 * `title · subtitle · args` line, so a row asserts by its own text.
 */
const triggerText = (trigger: unknown): React.ReactNode => {
  if (React.isValidElement(trigger)) return trigger;
  const { title, subtitle, args } = (trigger ?? {}) as {
    title?: string;
    subtitle?: string;
    args?: string[];
  };
  const words = [title, subtitle, ...(args ?? [])].filter((word): word is string => Boolean(word));
  return <Text>{words.join(' · ')}</Text>;
};

/** Only the palette field the code under test reads; styles never reach the host stand-ins. */
const PALETTE = { mutedForeground: '#71717a' };

mock.module('react-native', () => ({ View }));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
mock.module('@/components/ui/text', () => ({ Text }));
mock.module('@/lib/opencode/sync-store', () => ({
  useSyncStore: (selector: (store: { permissions: Record<string, unknown> }) => unknown) =>
    selector({ permissions: {} }),
}));
mock.module('./shared/infrastructure', () => ({
  ToolRunningContext: React.createContext(false),
  ToolOutcomeContext: React.createContext('ok'),
  StalePendingContext: React.createContext(false),
  ToolDurationContext: React.createContext<number | undefined>(undefined),
  TurnLiveContext: React.createContext(false),
  BasicTool: ({ trigger, children }: { trigger?: unknown; children?: React.ReactNode }) => (
    <view>
      {triggerText(trigger)}
      {children}
    </view>
  ),
  RawOutputBlock: ({ output }: { output: string }) => <text>{`RAW·${output}`}</text>,
}));
mock.module('./shared/styles', () => ({
  TURN_SPACE: { gap1_5: 6, gap2: 8 },
  TURN_TYPE: { xs: {} },
  useTurnPalette: () => PALETTE,
}));
mock.module('./shared/surface', () => ({
  ToolCardFrame: ({ children }: { children?: React.ReactNode }) => <view>{children}</view>,
}));
mock.module('./shared/tool-icons', () => ({ getToolIconByName: () => null }));
mock.module('./tool-error', () => ({
  ToolError: ({ error }: { error: unknown }) => <text>{`ERROR·${String(error)}`}</text>,
}));
mock.module('./generic-tool', () => ({
  GenericExpandedContent: () => <text>LEGACY-GENERIC-BODY</text>,
}));
mock.module('./tools/register', () => ({}));

// The legacy bodies `ToolPartRenderer` still imports. Markers, so a dispatch
// regression that reaches the legacy switch shows up as a rendered marker.
// From phase 2 on nothing imports these; the mocks then just sit unused.
mock.module('./tools/bash-tool', () => ({
  ShellExpandedContent: () => <text>LEGACY-SHELL-BODY</text>,
}));
mock.module('./tools/edit-tool', () => ({
  WriteEditExpandedContent: () => <text>LEGACY-WRITE-BODY</text>,
}));
mock.module('./tools/todo-write-tool', () => ({
  TodosExpandedContent: () => <text>LEGACY-TODOS-BODY</text>,
}));
mock.module('./tools/read-tool', () => ({
  ReadExpandedContent: () => <text>LEGACY-READ-BODY</text>,
}));
mock.module('./tools/web-search-tool', () => ({
  WebSearchExpandedContent: () => <text>LEGACY-WEBSEARCH-BODY</text>,
}));
mock.module('./tools/glob-tool', () => ({
  GlobGrepExpandedContent: () => <text>LEGACY-GLOB-BODY</text>,
}));
mock.module('./tools/question-tool', () => ({
  QuestionExpandedContent: () => <text>LEGACY-QUESTION-BODY</text>,
}));
mock.module('./tools/get-mem-tool', () => ({
  GetMemExpandedContent: () => <text>LEGACY-GETMEM-BODY</text>,
}));
mock.module('./tools/memory-search-tool', () => ({
  LtmSearchExpandedContent: () => <text>LEGACY-LTM-BODY</text>,
}));
mock.module('./tools/session-get-tool', () => ({
  SessionGetExpandedContent: () => <text>LEGACY-SESSIONGET-BODY</text>,
}));

// ─── The registry row under test ─────────────────────────────────────────────

/** What the registry's `bash` entry renders; the marker proves the row came from the registry. */
const RegisteredBashRow = ({ part }: { part: { callID: string } }) => (
  <text>{`REGISTERED-BASH-ROW:${part.callID}`}</text>
);

let ToolPartRenderer: typeof import('./tool-part-renderer').ToolPartRenderer;
let registry: typeof import('./shared/registry').ToolRegistry;

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ ToolRegistry: registry } = await import('./shared/registry'));
  registry.register('bash', RegisteredBashRow);
  ({ ToolPartRenderer } = await import('./tool-part-renderer'));
});

// ─── Render helpers ──────────────────────────────────────────────────────────

let tree: ReactTestRenderer | undefined;

afterEach(async () => {
  if (tree) await act(async () => tree?.unmount());
  tree = undefined;
});

async function renderPart(part: Record<string, unknown>, props: Record<string, unknown> = {}) {
  const Renderer = ToolPartRenderer as unknown as React.ComponentType<Record<string, unknown>>;
  await act(async () => {
    tree = create(React.createElement(Renderer, { part, ...props }));
  });
}

/** Every string the stubbed render surface put into a `text` host. */
function texts(): string[] {
  const rendered = tree;
  if (!rendered) return [];
  return rendered.root
    .findAll((node) => node.type === 'text')
    .flatMap((node) =>
      Array.isArray(node.props.children) ? node.props.children : [node.props.children],
    )
    .filter((child): child is string => typeof child === 'string');
}

const bashPart = (state: Record<string, unknown>) => ({
  type: 'tool',
  id: 'part-1',
  callID: 'call-1',
  tool: 'bash',
  state: { input: { command: 'echo hi', description: 'greet' }, ...state },
});

describe('ToolPartRenderer dispatch', () => {
  test('a completed bash part renders the registry row, not the legacy switch body', async () => {
    await renderPart(bashPart({ status: 'completed', output: 'hello\n' }));
    expect(texts()).toContain('REGISTERED-BASH-ROW:call-1');
    expect(texts().some((t) => t.startsWith('LEGACY-'))).toBe(false);
    expect(texts().some((t) => t.startsWith('RAW·'))).toBe(false);
  });

  test('a completed unregistered tool with output renders RawOutputBlock; without output it renders none', async () => {
    await renderPart({
      type: 'tool',
      id: 'part-2',
      callID: 'call-2',
      tool: 'mystery_tool',
      state: { status: 'completed', output: 'plain result\n' },
    });
    expect(texts()).toContain('RAW·plain result');
    expect(texts().some((t) => t.startsWith('LEGACY-'))).toBe(false);

    await renderPart({
      type: 'tool',
      id: 'part-3',
      callID: 'call-3',
      tool: 'mystery_tool',
      state: { status: 'completed', output: '   ' },
    });
    expect(texts().some((t) => t.startsWith('RAW·'))).toBe(false);
  });

  test('an error part renders the failed row with a ToolError body, even for a registered tool', async () => {
    await renderPart(bashPart({ status: 'error', error: 'boom' }));
    expect(texts()).toContain('Bash · failed');
    expect(texts()).toContain('ERROR·boom');
    expect(texts().some((t) => t.startsWith('REGISTERED-'))).toBe(false);
  });

  test('a pending permission surfaces the inline prompt under the registered row', async () => {
    await renderPart(bashPart({ status: 'pending' }), {
      permission: { id: 'req-1', tool: { messageID: 'm-1', callID: 'call-1' } },
      onPermissionReply: () => {},
    });
    expect(texts()).toContain('REGISTERED-BASH-ROW:call-1');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(texts()).toContain('Waiting for your permission');
  });
});
