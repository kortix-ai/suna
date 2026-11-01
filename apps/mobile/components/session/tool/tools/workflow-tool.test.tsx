import { afterEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ToolCallBlock } from '@kortix/sdk';
import { partInput, partMetadata, partOutput } from '@/lib/session/tool-part-accessors';

mock.module('@/lib/icons', () => ({ TreeStructureIcon: () => null }));
mock.module('../shared/infrastructure', () => ({
  partInput, partMetadata, partOutput,
  BasicTool: ({ children, trigger, ...props }: React.PropsWithChildren<{ trigger: { title: string; subtitle: string } }>) =>
    <details {...props}><summary>{trigger.title} {trigger.subtitle}</summary>{children}</details>,
  ToolOutputFallback: ({ output }: { output: string }) => <output>{output}</output>,
}));
mock.module('../shared/output-block', () => ({ OutputBlock: ({ text }: { text: string }) => <pre>{text}</pre> }));
const { WorkflowTool } = await import('./workflow-tool');
const { ToolRegistry } = await import('../shared/registry');
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReactTestRenderer | undefined;
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; });

const call: ToolCallBlock = {
  id: 'workflow-1', type: 'tool_call', call_id: 'call-1', name: 'workflow', kind: 'other', status: 'complete',
  input: { title: 'Review changes', code: 'await agents.run()' },
  result: { is_error: false, content: [{ type: 'text', text: 'Review complete' }], details: { status: 'completed', agents: [] } },
};

test('workflow and runtime aliases resolve to the workflow renderer, not a single-agent card', () => {
  for (const name of ['workflow', 'oc-workflow', 'mcp/workflow']) expect(ToolRegistry.get(name)).toBe(WorkflowTool);
});

test('renders workflow identity, script, run metadata and result using existing read-only surfaces', async () => {
  await act(async () => { tree = create(<WorkflowTool call={call} defaultOpen locked />); });
  expect(tree?.root.findByType('summary').children.join('')).toBe('Workflow Review changes');
  expect(tree?.root.findAllByType('pre').map((node) => node.children.join(''))).toEqual([
    'await agents.run()', JSON.stringify({ status: 'completed', agents: [] }, null, 2),
  ]);
  expect(tree?.root.findByType('output').children).toEqual(['Review complete']);
  expect(tree?.root.findByType('details').props.locked).toBe(true);
});

test('pending and malformed optional data do not invent a run or controls', async () => {
  await act(async () => { tree = create(<WorkflowTool call={{ ...call, status: 'pending', input: {}, result: undefined }} />); });
  expect(tree?.root.findAllByType('pre')).toHaveLength(0);
  expect(tree?.root.findAllByType('output')).toHaveLength(0);
  expect(tree?.root.findAllByType('button')).toHaveLength(0);
});
