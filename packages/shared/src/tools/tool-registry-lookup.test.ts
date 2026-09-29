import { describe, expect, test } from 'bun:test';
import { resolveRegisteredKey, toolRegistryCandidates } from './tool-registry-lookup';

describe('tool registry lookup order', () => {
  test.each([
    ['  Foo_Bar  ', ['Foo_Bar', 'foo_bar', 'Foo-Bar', 'foo-bar']],
    ['mcp/Run_Task', ['mcp/Run_Task', 'mcp/run_task', 'mcp/Run-Task', 'mcp/run-task', 'Run_Task', 'run_task', 'Run-Task', 'run-task']],
    ['one/two/Task-Name', ['one/two/Task-Name', 'one/two/task-name', 'one/two/Task_Name', 'one/two/task_name', 'Task-Name', 'task-name', 'Task_Name', 'task_name']],
    ['', []],
  ])('candidates for %s', (name, expected) => {
    expect([...toolRegistryCandidates(name)]).toEqual(expected);
  });

  test.each([
    ['Foo', ['Foo', 'foo'], 'Foo'],
    ['FOO', ['foo'], 'foo'],
    ['foo_bar', ['foo-bar'], 'foo-bar'],
    ['foo-bar', ['foo_bar'], 'foo_bar'],
    ['mcp/Task', ['Task'], 'Task'],
    ['oc-trigger_create', ['trigger_create'], 'trigger_create'],
    ['oc-mem-search', ['mem_search'], 'mem_search'],
    ['prefix/task', ['task', 'prefix/task'], 'prefix/task'],
    ['prefix/task', ['task'], 'task'],
    ['other', ['task'], undefined],
  ])('%s resolves against %j', (name, keys, expected) => {
    expect(resolveRegisteredKey(toolRegistryCandidates(name), keys)).toBe(expected);
  });
});
