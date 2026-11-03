import { afterEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { toolCallBlock, type ToolCallBlock, type ToolPart } from '@kortix/sdk';
import { partInput, partMetadata, partOutput, partStatus } from '@/lib/session/tool-part-accessors';

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host =
  (name: string) =>
  ({ children, ...props }: HostProps) =>
    React.createElement(name, props, children);
const none = () => null;
const openSession = mock((_id: string) => {});

mock.module('react-native', () => ({
  View: host('view'),
  Pressable: ({ children, style, ...props }: HostProps & { style?: unknown }) =>
    React.createElement('pressable', props, typeof children === 'function' ? (children as (s: { pressed: boolean }) => React.ReactNode)({ pressed: false }) : children),
}));
mock.module('react-native-svg', () => ({ default: host('svg'), Circle: host('circle'), Path: host('path'), Rect: host('rect') }));
mock.module('@/components/ui/text', () => ({ Text: host('text') }));
mock.module('@/components/ui/icon', () => ({ Icon: none }));
mock.module('@/lib/icons', () => ({ TreeStructureIcon: none }));
mock.module('@/lib/projects/hooks', () => ({ useProjectSession: () => ({ data: undefined }) }));
mock.module('@/lib/session/session-list', () => ({ sessionDisplayStatus: () => 'running' }));
mock.module('@/lib/session/user-message', () => ({ webSpace: (n: number) => n * 4 }));
mock.module('@/components/session/SessionStatusMark', () => ({
  SessionStatusMark: ({ status }: { status: string }) => <mark data-status={status} />,
}));
mock.module('../shared/connector-handoff-context', () => ({ ConnectorHandoffContext: React.createContext(null) }));
mock.module('../shared/infrastructure', () => ({
  partInput,
  partMetadata,
  partOutput,
  partStatus,
  BasicTool: ({ children, trigger }: React.PropsWithChildren<{ trigger: { title: string } }>) => (
    <details>
      <summary>{trigger.title}</summary>
      {children}
    </details>
  ),
  ToolOutputFallback: ({ output }: { output: string }) => <output>{output}</output>,
  useToolNavigation: () => ({ enabled: true, openSession }),
}));
mock.module('../shared/output-block', () => ({ OutputBlock: ({ text }: { text: string }) => <pre>{text}</pre> }));
mock.module('../shared/styles', () => ({
  FONT_MEDIUM: 'medium',
  TURN_TYPE: { xs: {}, sm: {} },
  monoFont: 'mono',
  useTurnPalette: () => ({ foreground: 'fg', mutedForeground: 'mfg', border: 'bd', card: 'card', destructive: 'dest', kortixGreen: 'green', pressed: 'pr' }),
}));

const { WorkflowTool } = await import('./workflow-tool');
const { ToolRegistry } = await import('../shared/registry');
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => tree?.unmount());
  tree = undefined;
  openSession.mockClear();
});

const RUN = {
  runId: 'run-1',
  title: 'Kortix growth marketing deep dive',
  status: 'running',
  phases: [
    { title: 'Investigate', status: 'running' },
    { title: 'Build strategy', status: 'pending' },
  ],
  agents: [
    { id: 'a1', label: 'Product and website', phase: 'Investigate', status: 'done', sessionId: 'ses_1' },
    { id: 'a2', label: 'Customers and demand', phase: 'Investigate', status: 'running', sessionId: 'ses_2' },
  ],
};

function call(metadata: unknown, status = 'running'): ToolCallBlock {
  return toolCallBlock({
    type: 'tool',
    id: 'p-1',
    tool: 'workflow',
    callID: 'call-1',
    state: { status, input: { script: 'await agent("go")' }, metadata },
  } as unknown as ToolPart);
}

const texts = (renderer: ReactTestRenderer): string =>
  renderer.root
    .findAllByType('text' as never)
    .map((node) => [node.props.children].flat().filter((c: unknown) => typeof c === 'string').join(''))
    .join('|');

test('workflow and runtime aliases resolve to the workflow card', () => {
  for (const name of ['workflow', 'oc-workflow', 'mcp/workflow']) expect(ToolRegistry.get(name)).toBe(WorkflowTool);
});

test('a run is one card: ring, title, phase line, rows under their phase, the phase not started as one row', async () => {
  await act(async () => {
    tree = create(<WorkflowTool call={call(RUN)} />);
  });
  const text = texts(tree!);
  expect(text).toContain('Kortix growth marketing deep dive');
  expect(text).toContain('Investigate 1 of 2 done');
  expect(text).toContain('Investigate');
  expect(text).toContain('Customers and demand');
  expect(text).toContain('Build strategy');
  expect(text).toContain('Waits for 1 more');
  // Never a fold: no disclosure row draws the run.
  expect(tree!.root.findAllByType('details' as never)).toHaveLength(0);
  // A row with a session opens it.
  const row = tree!.root.findAll((node) => node.props?.accessibilityLabel === 'Open Customers and demand')[0]!;
  await act(async () => row.props.onPress());
  expect(openSession).toHaveBeenCalledWith('ses_2');
});

test('before a run document it is the plain "Starting the workflow…" row, with no card', async () => {
  await act(async () => {
    tree = create(<WorkflowTool call={call({})} />);
  });
  expect(tree!.root.findByType('summary' as never).children).toEqual(['Starting the workflow…']);
});
