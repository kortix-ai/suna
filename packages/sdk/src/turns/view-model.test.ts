import { describe, expect, test } from 'bun:test';

import type { Part } from '../opencode/client';
import { classifyPart, type ClassifiedPart } from './classify';
import type { ToolView } from './classify';
import { toolViewModel } from './view-model';

/** Build a minimal ToolView directly — most tests here exercise `toolViewModel`
 *  in isolation rather than going through the full `classifyPart` pipeline. */
function toolView(overrides: Partial<ToolView> = {}): ToolView {
  return {
    name: 'unknown_tool',
    title: 'Unknown Tool',
    status: 'done',
    ...overrides,
  };
}

function classifyToolPart(tool: string, state: Record<string, unknown>): ToolView {
  const part = {
    id: 'p1',
    sessionID: 's1',
    messageID: 'm1',
    type: 'tool',
    callID: 'c1',
    tool,
    state,
  } as Part;
  const result = classifyPart(part) as Extract<ClassifiedPart, { kind: 'tool' }>;
  return result.tool;
}

describe('toolViewModel — web-search / image-search', () => {
  test('successful web_search maps results with title/url/snippet', () => {
    const tool = classifyToolPart('web_search', {
      status: 'completed',
      input: { query: 'kortix ai' },
      output: JSON.stringify({
        query: 'kortix ai',
        success: true,
        answer: 'Kortix is an open AI command center.',
        results: [
          { title: 'Kortix', url: 'https://kortix.ai', snippet: 'The open AI command center.' },
        ],
      }),
      title: 'Web Search',
      metadata: {},
      time: { start: 0, end: 1 },
    });
    const vm = toolViewModel(tool);
    expect(vm).toEqual({
      kind: 'web-search',
      query: 'kortix ai',
      results: [
        { title: 'Kortix', url: 'https://kortix.ai', snippet: 'The open AI command center.' },
      ],
      answer: 'Kortix is an open AI command center.',
    });
  });

  test('the real prod 402-in-completed-output transcript reclassifies to a destructive web-search error', () => {
    const tool = classifyToolPart('web_search', {
      status: 'completed',
      input: { query: 'anthropic claude opus pricing' },
      output: JSON.stringify({
        query: 'anthropic claude opus pricing',
        success: false,
        error: 'Error: 402 Error: {"error":true,"message":"Insufficient credits","status":402}',
      }),
      title: 'Web Search',
      metadata: {},
      time: { start: 0, end: 1 },
    });
    expect(tool.status).toBe('error');
    const vm = toolViewModel(tool);
    expect(vm).toEqual({
      kind: 'web-search',
      query: 'anthropic claude opus pricing',
      error: 'Insufficient credits',
    });
  });

  test('image_search results map images (url/title/description) into the same result shape', () => {
    const tool = classifyToolPart('image_search', {
      status: 'completed',
      input: { query: 'golden retriever' },
      output: JSON.stringify({
        query: 'golden retriever',
        total: 1,
        images: [
          {
            url: 'https://example.com/dog.jpg',
            title: 'Golden Retriever',
            source: 'https://example.com',
            width: 800,
            height: 600,
            description: 'A golden retriever sitting in a field.',
          },
        ],
      }),
      title: 'Image Search',
      metadata: {},
      time: { start: 0, end: 1 },
    });
    const vm = toolViewModel(tool);
    expect(vm.kind).toBe('web-search');
    if (vm.kind !== 'web-search') throw new Error('unreachable');
    expect(vm.results).toEqual([
      {
        title: 'Golden Retriever',
        url: 'https://example.com/dog.jpg',
        snippet: 'A golden retriever sitting in a field.',
      },
    ]);
  });
});

describe('toolViewModel — shell (bash)', () => {
  test('strips bash_metadata/system_info/exit_code tags and extracts exitCode', () => {
    const tool = classifyToolPart('bash', {
      status: 'completed',
      input: { command: 'ls -la' },
      output:
        'total 0\ndrwxr-xr-x 2 me me 64 Jan 1 00:00 .\n<bash_metadata>{"cwd":"/"}</bash_metadata><exit_code>0</exit_code>',
      title: 'Shell',
      metadata: {},
      time: { start: 0, end: 1 },
    });
    const vm = toolViewModel(tool);
    expect(vm).toEqual({
      kind: 'shell',
      command: 'ls -la',
      stdout: 'total 0\ndrwxr-xr-x 2 me me 64 Jan 1 00:00 .',
      exitCode: 0,
    });
  });

  test('a failed bash call falls back to the error text as stdout when output is empty', () => {
    const tool = classifyToolPart('bash', {
      status: 'error',
      input: { command: 'exit 1' },
      error: 'command failed with exit code 1',
      time: { start: 0, end: 1 },
    });
    const vm = toolViewModel(tool);
    expect(vm).toEqual({ kind: 'shell', command: 'exit 1', stdout: 'command failed with exit code 1', exitCode: undefined });
  });
});

describe('toolViewModel — file read/write/edit', () => {
  test('file-read exposes a preview of the output', () => {
    const tool = classifyToolPart('read', {
      status: 'completed',
      input: { filePath: '/repo/README.md' },
      output: '# Hello\n',
      title: 'Read',
      metadata: {},
      time: { start: 0, end: 1 },
    });
    expect(toolViewModel(tool)).toEqual({
      kind: 'file-read',
      path: '/repo/README.md',
      preview: '# Hello\n',
    });
  });

  test('file-write exposes a preview of the written content', () => {
    const tool = classifyToolPart('write', {
      status: 'completed',
      input: { filePath: '/repo/a.txt', content: 'hello world' },
      output: 'File written',
      title: 'Write',
      metadata: {},
      time: { start: 0, end: 1 },
    });
    expect(toolViewModel(tool)).toEqual({
      kind: 'file-write',
      path: '/repo/a.txt',
      preview: 'hello world',
    });
  });

  test('file-edit computes a prefix/suffix-trimmed line diff from oldString/newString', () => {
    const tool = classifyToolPart('edit', {
      status: 'completed',
      input: {
        filePath: '/repo/a.ts',
        oldString: 'line1\nline2\nline3',
        newString: 'line1\nCHANGED\nline3',
      },
      output: 'ok',
      title: 'Edit',
      metadata: {},
      time: { start: 0, end: 1 },
    });
    expect(toolViewModel(tool)).toEqual({
      kind: 'file-edit',
      path: '/repo/a.ts',
      diff: [
        { type: 'unchanged', text: 'line1' },
        { type: 'removed', text: 'line2' },
        { type: 'added', text: 'CHANGED' },
        { type: 'unchanged', text: 'line3' },
      ],
    });
  });
});

describe('toolViewModel — search (grep/glob)', () => {
  test('grep output parses into path/line/content matches', () => {
    const tool = classifyToolPart('grep', {
      status: 'completed',
      input: { pattern: 'TODO' },
      output: 'Found 2 matches\n\n/repo/a.ts: \nLine 3: // TODO fix this\nLine 9: // TODO cleanup',
      title: 'Grep',
      metadata: {},
      time: { start: 0, end: 1 },
    });
    const vm = toolViewModel(tool);
    expect(vm).toEqual({
      kind: 'search',
      pattern: 'TODO',
      matches: [
        { path: '/repo/a.ts', line: 3, content: '// TODO fix this' },
        { path: '/repo/a.ts', line: 9, content: '// TODO cleanup' },
      ],
    });
  });

  test('glob output parses into a flat path list', () => {
    const tool = classifyToolPart('glob', {
      status: 'completed',
      input: { pattern: '**/*.ts' },
      output: '/repo/a.ts\n/repo/b.ts',
      title: 'Glob',
      metadata: {},
      time: { start: 0, end: 1 },
    });
    expect(toolViewModel(tool)).toEqual({
      kind: 'search',
      pattern: '**/*.ts',
      matches: [{ path: '/repo/a.ts' }, { path: '/repo/b.ts' }],
    });
  });
});

describe('toolViewModel — task / todo / question', () => {
  test('task pulls description + subagent_type', () => {
    const tool = toolView({
      name: 'task',
      title: 'Delegate to Agent',
      input: { description: 'Fix the flaky test', subagent_type: 'general-purpose' },
    });
    expect(toolViewModel(tool)).toEqual({
      kind: 'task',
      description: 'Fix the flaky test',
      agent: 'general-purpose',
    });
  });

  test('todowrite normalizes todos from input', () => {
    const tool = toolView({
      name: 'todowrite',
      title: 'Plan Tasks',
      input: {
        todos: [
          { content: 'Write tests', status: 'in_progress', priority: 'high' },
          { content: 'Ship it', status: 'pending' },
        ],
      },
    });
    expect(toolViewModel(tool)).toEqual({
      kind: 'todo',
      items: [
        { content: 'Write tests', status: 'in_progress', priority: 'high' },
        { content: 'Ship it', status: 'pending' },
      ],
    });
  });

  test('question normalizes questions + options', () => {
    const tool = toolView({
      name: 'question',
      title: 'Ask Question',
      input: {
        questions: [
          {
            question: 'Which environment?',
            options: [{ label: 'staging' }, { label: 'prod', description: 'Careful!' }],
          },
        ],
      },
    });
    expect(toolViewModel(tool)).toEqual({
      kind: 'question',
      questions: [
        {
          question: 'Which environment?',
          header: undefined,
          options: [
            { label: 'staging', description: undefined },
            { label: 'prod', description: 'Careful!' },
          ],
        },
      ],
    });
  });
});

describe('toolViewModel — generic fallback', () => {
  test('an unrecognized tool falls back to generic with pretty input/output', () => {
    const tool = classifyToolPart('webfetch', {
      status: 'completed',
      input: { url: 'https://example.com' },
      output: JSON.stringify({ title: 'Example', content: 'hi' }),
      title: 'Fetch Page',
      metadata: {},
      time: { start: 0, end: 1 },
    });
    const vm = toolViewModel(tool);
    expect(vm.kind).toBe('generic');
    if (vm.kind !== 'generic') throw new Error('unreachable');
    expect(vm.label).toBe('Fetch Page');
    expect(vm.inputPretty).toContain('"url": "https://example.com"');
    expect(vm.outputPretty).toContain('"title": "Example"');
  });

  test('unparseable string output never throws and falls back to raw text, capped', () => {
    const tool = classifyToolPart('mystery_tool', {
      status: 'completed',
      input: {},
      output: 'not json at all, just plain text',
      title: 'Mystery Tool',
      metadata: {},
      time: { start: 0, end: 1 },
    });
    expect(() => toolViewModel(tool)).not.toThrow();
    const vm = toolViewModel(tool);
    expect(vm).toEqual({
      kind: 'generic',
      label: 'Mystery Tool',
      inputPretty: undefined,
      outputPretty: 'not json at all, just plain text',
    });
  });

  test('a huge output is capped, never blows up rendering', () => {
    const huge = 'x'.repeat(300_000);
    const tool = classifyToolPart('mystery_tool', {
      status: 'completed',
      input: {},
      output: huge,
      title: 'Mystery Tool',
      metadata: {},
      time: { start: 0, end: 1 },
    });
    expect(() => toolViewModel(tool)).not.toThrow();
    const vm = toolViewModel(tool);
    expect(vm.kind).toBe('generic');
    if (vm.kind !== 'generic') throw new Error('unreachable');
    expect(vm.outputPretty!.length).toBeLessThan(huge.length);
  });

  test('an error-status tool with no output surfaces the error as outputPretty', () => {
    const tool = classifyToolPart('mystery_tool', {
      status: 'error',
      input: {},
      error: 'boom',
      time: { start: 0, end: 1 },
    });
    expect(toolViewModel(tool)).toEqual({
      kind: 'generic',
      label: 'Mystery Tool',
      inputPretty: undefined,
      outputPretty: 'boom',
    });
  });
});
