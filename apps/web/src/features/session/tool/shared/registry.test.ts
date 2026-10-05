import { expect, test } from 'bun:test';
import { ToolRegistry } from './registry';

test('web registry retains exact, alias, and suffix precedence', () => {
  const exact = (() => null) as never;
  const alias = (() => null) as never;
  ToolRegistry.register('task', alias);
  ToolRegistry.register('mcp/task', exact);
  expect(ToolRegistry.get('mcp/task')).toBe(exact);
  expect(ToolRegistry.get('prefix/task')).toBe(alias);
  expect(ToolRegistry.get(' TASK ')).toBe(alias);
  expect(ToolRegistry.get('missing')).toBeUndefined();
  ToolRegistry.register('foo-bar', alias);
  expect(ToolRegistry.get('FOO_BAR')).toBe(alias);
  expect(ToolRegistry.keys()).toContain('foo-bar');
});

test('an unregistered alias renders its kind’s renderer', () => {
  const edit = (() => null) as never;
  ToolRegistry.register('edit', edit);
  // `multiedit` has no renderer of its own; its kind is `edit`.
  expect(ToolRegistry.get('multiedit')).toBe(edit);
  expect(ToolRegistry.get('oc_multiedit')).toBe(edit);
});
