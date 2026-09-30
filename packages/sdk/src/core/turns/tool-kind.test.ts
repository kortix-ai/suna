import { describe, expect, test } from 'bun:test';
import { inputPath, toolKind } from './tool-kind';

describe('toolKind', () => {
  test.each([
    // pi's tool names
    ['bash', 'bash'],
    ['read', 'read'],
    ['write', 'write'],
    ['edit', 'edit'],
    ['glob', 'glob'],
    ['grep', 'grep'],
    ['question', 'question'],
    ['task', 'task'],
    // OpenCode built-ins and aliases
    ['list', 'list'],
    ['ls', 'list'],
    ['multiedit', 'edit'],
    ['morph_edit', 'edit'],
    ['apply_patch', 'apply_patch'],
    ['patch', 'apply_patch'],
    ['webfetch', 'webfetch'],
    ['web_fetch', 'webfetch'],
    ['scrape_webpage', 'webfetch'],
    ['websearch', 'web_search'],
    ['web_search', 'web_search'],
    ['image_search', 'web_search'],
    ['todowrite', 'todowrite'],
    ['todo_write', 'todowrite'],
    ['todoread', 'todowrite'],
    ['ask', 'question'],
    ['skill', 'skill'],
    ['image_gen', 'media'],
    ['presentation_gen', 'show'],
    ['show_user', 'show'],
    ['prune', 'context'],
    ['context_info', 'context'],
    ['memory_search', 'memory'],
    ['kortix_connectors_call', 'connectors'],
    ['integration_run', 'retired'],
    // plugin families by prefix
    ['pty_spawn', 'pty'],
    ['pty_something_new', 'pty'],
    ['agent_spawn', 'delegate'],
    ['task_create', 'delegate'],
    ['session_spawn', 'delegate'],
    ['session_read', 'sessions'],
    ['triggers', 'automations'],
    ['trigger_pause', 'automations'],
    ['project_list', 'projects'],
    // prefixed and dashed spellings
    ['oc-bash', 'bash'],
    ['oc_bash', 'bash'],
    ['oc-apply-patch', 'apply_patch'],
    ['web-search', 'web_search'],
    // anything else
    ['linear/create_issue', 'other'],
    ['', 'other'],
  ] as const)('%s → %s', (name, kind) => {
    expect(toolKind(name)).toBe(kind);
  });
});

describe('inputPath', () => {
  test('reads OpenCode filePath, snake file_path and pi path', () => {
    expect(inputPath({ filePath: '/a.ts' })).toBe('/a.ts');
    expect(inputPath({ file_path: '/b.ts' })).toBe('/b.ts');
    expect(inputPath({ path: 'src/c.ts' })).toBe('src/c.ts');
    expect(inputPath({ filePath: '/a.ts', path: 'other' })).toBe('/a.ts');
  });

  test('is undefined without a string path', () => {
    expect(inputPath({})).toBeUndefined();
    expect(inputPath(undefined)).toBeUndefined();
    expect(inputPath({ path: 42 })).toBeUndefined();
    expect(inputPath({ filePath: '' })).toBeUndefined();
  });
});
