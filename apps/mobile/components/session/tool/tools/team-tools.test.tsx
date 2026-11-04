import { afterEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { toolCallBlock, type ToolCallBlock, type ToolPart } from '@kortix/sdk';
import { partError, partInput, partRawOutput, partStatus } from '@/lib/session/tool-part-accessors';

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host =
  (name: string) =>
  ({ children, ...props }: HostProps) =>
    React.createElement(name, props, children);
const none = () => null;
const openSession = mock((_id: string) => {});

mock.module('react-native', () => ({
  View: host('view'),
  Pressable: ({ children, ...props }: HostProps) =>
    React.createElement('pressable', props, typeof children === 'function' ? (children as (s: { pressed: boolean }) => React.ReactNode)({ pressed: false }) : children),
}));
mock.module('react-native-svg', () => ({ default: host('svg'), Circle: host('circle'), Path: host('path'), Rect: host('rect') }));
mock.module('@/components/ui/text', () => ({ Text: host('text') }));
mock.module('@/components/ui/icon', () => ({ Icon: none }));
mock.module('@/lib/icons', () => ({ ArrowUpRightIcon: none, ChatCircleIcon: none, ListChecksIcon: none, StopCircleIcon: none, UsersThreeIcon: none }));
mock.module('@/components/ui/button', () => ({ Button: host('button') }));
mock.module('../tool-error', () => ({ ToolError: none }));
mock.module('@/lib/session/user-message', () => ({ webSpace: (n: number) => n * 4 }));
mock.module('@/components/session/SessionStatusMark', () => ({
  SessionStatusMark: ({ status }: { status: string }) => <mark data-status={status} />,
}));
mock.module('../shared/infrastructure', () => ({
  partInput,
  partStatus,
  partError,
  partRawOutput,
  BasicTool: ({ children, trigger }: React.PropsWithChildren<{ trigger: { title: string } | React.ReactNode }>) => (
    <details>
      <summary>
        {trigger && typeof trigger === 'object' && 'title' in (trigger as object) ? (trigger as { title: string }).title : (trigger as React.ReactNode)}
      </summary>
      {children}
    </details>
  ),
  useToolNavigation: () => ({ enabled: true, openSession }),
}));
mock.module('../shared/styles', () => ({
  FONT_MEDIUM: 'medium',
  TURN_TYPE: { xs: {}, sm: {} },
  useTurnPalette: () => ({ foreground: 'fg', mutedForeground: 'mfg', border: 'bd', card: 'card', muted: 'm', warning: 'w', pressed: 'pr' }),
}));
mock.module('./agent-spawn-tool', () => ({ AgentSpawnTool: () => React.createElement('legacy') }));
mock.module('./agent-task-update-tool', () => ({ AgentTaskUpdateTool: () => React.createElement('legacy') }));
mock.module('./task-list-tool', () => ({ TaskListTool: () => React.createElement('legacy') }));

const { MultiAgentToolCard } = await import('./team-tools');
const { ToolRegistry } = await import('../shared/registry');
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => tree?.unmount());
  tree = undefined;
  openSession.mockClear();
});

function call(tool: string, output: unknown, input: Record<string, unknown> = {}): ToolCallBlock {
  return toolCallBlock({
    type: 'tool',
    id: `p-${tool}`,
    tool,
    callID: `call-${tool}`,
    state: { status: 'completed', input, output: JSON.stringify(output) },
  } as unknown as ToolPart);
}

const result = (tool: string, data: unknown, title = 'Done') => ({ ok: true, tool, action: tool, card: { title, status: 'done' }, data });
const texts = (renderer: ReactTestRenderer): string =>
  renderer.root
    .findAllByType('text' as never)
    .map((node) => [node.props.children].flat().filter((c: unknown) => typeof c === 'string' || typeof c === 'number').join(''))
    .join('|');

async function render(block: ToolCallBlock) {
  const Component = ToolRegistry.get(block.name)!;
  await act(async () => {
    tree = create(<Component call={block} />);
  });
  return tree!;
}

test('send_message is one plain tool row: the receiver, the message, delivered', async () => {
  const t = await render(
    call('send_message', result('send_message', { status: 'delivered', to: { handle: 'scout' }, message: { message: 'Migration finished', summary: null } })),
  );
  expect(t.root.findAll((node) => node.props?.testID === 'peer-send-row').length).toBeGreaterThan(0);
  expect(t.root.findAll((node) => node.props?.testID === 'peer-send-card')).toHaveLength(0);
  expect(texts(t)).toContain('To scout');
  expect(texts(t)).toContain('Delivered');
  expect(texts(t)).toContain('Migration finished');
});

test('a send that did not arrive is the same row: the reason as its line, the state in red', async () => {
  const t = await render(
    call('send_message', result('send_message', { status: 'refused', to: { handle: 'scout' }, message: { message: 'Also check the free tier', summary: null }, note: 'scout is not running.' })),
  );
  expect(t.root.findAll((node) => node.props?.testID === 'peer-send-row').length).toBeGreaterThan(0);
  expect(texts(t)).toContain('Not sent');
  expect(texts(t)).toContain('scout is not running.');
});

test('a team task result is one row per task: status mark, #seq, subject, owner', async () => {
  const t = await render(
    call('task_list', result('task_list', { tasks: [{ seq: 2, subject: 'Write the fix', status: 'in_progress', owner_handle: 'dev' }] }), {}),
  );
  expect(texts(t)).toContain('#2');
  expect(texts(t)).toContain('Write the fix');
  expect(texts(t)).toContain('@dev');
  expect(t.root.findAll((node) => node.props?.['data-status'] === 'running')).toHaveLength(1);
});

test('an older plugin task tool keeps its old row', async () => {
  const block = toolCallBlock({
    type: 'tool',
    id: 'p-old',
    tool: 'task_create',
    callID: 'call-old',
    state: { status: 'completed', input: { description: 'old' }, output: 'Created task 1' },
  } as unknown as ToolPart);
  const t = await render(block);
  expect(t.root.findAllByType('legacy' as never)).toHaveLength(1);
});

test('list_agents rows open their agent', async () => {
  const t = await render(call('list_agents', result('list_agents', { agents: [{ handle: 'scout', session_id: 'ses_9', state: 'working', title: 'Market scan' }] })));
  const row = t.root.findAll((node) => node.props?.accessibilityLabel === 'Open @scout, working')[0]!;
  await act(async () => row.props.onPress());
  expect(openSession).toHaveBeenCalledWith('ses_9');
  expect(MultiAgentToolCard).toBeDefined();
});
