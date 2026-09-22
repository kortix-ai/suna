import { describe, expect, test } from 'bun:test';

import type { ToolPart } from '../../runtime/client';
import {
  CONTEXT_TOOLS,
  contextToolSummary,
  contextToolTrigger,
  getToolPrimaryArg,
  isContextTool,
  normalizeName,
} from './tool-meta';

function part(tool: string, input: Record<string, unknown> = {}): ToolPart {
  return {
    id: `p-${tool}`,
    type: 'tool',
    tool,
    callID: `c-${tool}`,
    state: { status: 'completed', input },
  } as unknown as ToolPart;
}

describe('context tool grouping', () => {
  test('normalizeName drops oc- and folds kebab-case', () => {
    expect(normalizeName('oc-web-fetch')).toBe('web_fetch');
  });

  test('read, glob, grep and list are the context tools', () => {
    expect([...CONTEXT_TOOLS].sort()).toEqual(['glob', 'grep', 'list', 'read']);
    expect(isContextTool('oc-grep')).toBe(true);
    expect(isContextTool('bash')).toBe(false);
  });

  test('contextToolSummary counts glob and grep as search', () => {
    expect(
      contextToolSummary([part('read'), part('glob'), part('grep'), part('list'), part('bash')]),
    ).toEqual({ read: 1, search: 2, list: 1 });
  });
});

describe('getToolPrimaryArg', () => {
  test('file tools show the basename, for both separators', () => {
    expect(getToolPrimaryArg(part('read', { filePath: '/a/b/c.ts' }))).toBe('c.ts');
    expect(getToolPrimaryArg(part('write', { file_path: 'C:\\x\\y.md' }))).toBe('y.md');
    expect(getToolPrimaryArg(part('edit', {}))).toBe('');
  });

  test('grep quotes its pattern and names where it looked', () => {
    expect(getToolPrimaryArg(part('grep', { pattern: 'foo', path: '/src/lib/' }))).toBe(
      '"foo" in lib',
    );
    expect(getToolPrimaryArg(part('grep', { pattern: 'foo' }))).toBe('"foo"');
  });

  test('bash commands collapse whitespace and cap at 80 characters', () => {
    expect(getToolPrimaryArg(part('bash', { command: 'ls   -la\n  /tmp' }))).toBe('ls -la /tmp');
    const long = getToolPrimaryArg(part('bash', { command: 'x'.repeat(100) }));
    expect(long).toBe(`${'x'.repeat(80)}…`);
  });

  test('the generic fallback humanizes a search query', () => {
    expect(
      getToolPrimaryArg(part('some_search', { query: 'site:daytona.io Daytona sandboxes' })),
    ).toBe('Daytona sandboxes on daytona.io');
    expect(getToolPrimaryArg(part('mystery', {}))).toBe('');
  });
});

describe('contextToolTrigger', () => {
  test('English defaults are the labels web renders in its en locale', () => {
    const title = (tool: string) => contextToolTrigger(part(tool)).title;
    expect(title('read')).toBe('Read');
    expect(title('glob')).toBe('Search');
    expect(title('grep')).toBe('Search');
    expect(title('list')).toBe('List');
    expect(title('bash')).toBe('Shell');
    expect(title('edit')).toBe('Edit');
    expect(title('morph_edit')).toBe('Edit');
    expect(title('write')).toBe('Write');
    expect(title('webfetch')).toBe('Fetch');
    expect(title('web_fetch')).toBe('Fetch');
    expect(title('websearch')).toBe('Web Search');
    expect(title('web_search')).toBe('Web Search');
    expect(title('scrape')).toBe('Scrape');
    expect(title('scrape_webpage')).toBe('Scrape');
    expect(title('apply_patch')).toBe('Apply Patch');
    expect(title('task')).toBe('Task');
    expect(title('session_spawn')).toBe('Worker');
    expect(title('session_start_background')).toBe('Worker');
    expect(title('project_select')).toBe('Workspace');
    expect(title('project_list')).toBe('Workspace');
  });

  test('unknown tools title-case their normalized name', () => {
    expect(contextToolTrigger(part('oc-linear-create_issue')).title).toBe('Linear Create Issue');
  });

  test('the subtitle is the primary arg', () => {
    expect(contextToolTrigger(part('read', { path: '/x/README.md' }))).toEqual({
      title: 'Read',
      subtitle: 'README.md',
    });
  });

  test('a host overrides labels without losing the defaults it did not pass', () => {
    const labels = { read: 'Lire', search: 'Chercher' };
    expect(contextToolTrigger(part('read'), labels).title).toBe('Lire');
    expect(contextToolTrigger(part('grep'), labels).title).toBe('Chercher');
    expect(contextToolTrigger(part('bash'), labels).title).toBe('Shell');
  });
});
