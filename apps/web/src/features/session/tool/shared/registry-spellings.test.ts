import { describe, expect, test } from 'bun:test';
import { ToolRegistry } from './registry';
import '../tools/register';

// Each renderer registers one spelling per tool. `get()` owns the variants a
// runtime emits: `_` or `-`, an `oc-` plugin prefix, an MCP server prefix.
describe('ToolRegistry.get', () => {
  test('every spelling of a registered tool resolves to its renderer', () => {
    for (const key of ToolRegistry.keys()) {
      // `kortix-connectors_call` mixes both separators: a runtime emits it verbatim.
      if (key.includes('-') && key.includes('_')) continue;
      const component = ToolRegistry.get(key);
      for (const spelling of [
        key.replace(/-/g, '_'),
        key.replace(/_/g, '-'),
        `oc-${key}`,
        `oc-${key.replace(/-/g, '_')}`,
        `mcp/${key}`,
      ]) {
        expect({ spelling, same: ToolRegistry.get(spelling) === component }).toEqual({ spelling, same: true });
      }
    }
  });

  test('a prefixed name takes the longest registered suffix', () => {
    const list = ToolRegistry.get('list');
    expect(ToolRegistry.get('oc-trigger-list')).toBe(ToolRegistry.get('trigger-list'));
    expect(ToolRegistry.get('oc-task-list')).toBe(ToolRegistry.get('task-list'));
    expect(ToolRegistry.get('oc-task-list')).not.toBe(list);
  });
});
