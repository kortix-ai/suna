import { describe, expect, test } from 'bun:test';

import { restoreStrippedToolParts } from './session-transcript-mirror';

describe('a row the old mirror stripped is served with what it kept', () => {
  // The old mirror kept each tool call's status, title, time and metadata.
  // OpenCode (1.17.11 to 1.18.23, every version it ran against) writes each
  // call's defining input into that title or metadata, so the row still proves
  // it. Served as stored, the call drew an empty row until its computer woke.
  const stripped = (tool: string, state: Record<string, unknown>) => ({
    id: 'prt_1',
    type: 'tool',
    tool,
    callID: 'call_1',
    state: { status: 'completed', time: { start: 1, end: 2 }, ...state },
  });
  const served = (tool: string, state: Record<string, unknown>) =>
    (restoreStrippedToolParts([stripped(tool, state)])[0] as { state: Record<string, unknown> }).state;

  test('a command gets its command from the title and its output from the metadata', () => {
    const metadata = { output: 'bundle.min.js\n', exit: 0, truncated: false };
    expect(served('bash', { title: 'ls -la dist', metadata })).toEqual({
      status: 'completed',
      time: { start: 1, end: 2 },
      title: 'ls -la dist',
      metadata,
      input: { command: 'ls -la dist' },
      output: 'bundle.min.js\n',
    });
  });

  test('a file call gets the absolute path its metadata kept, else the relative path in its title', () => {
    expect(
      served('read', {
        title: 'src/app.ts',
        metadata: { preview: 'export {}', display: { type: 'file', path: '/workspace/src/app.ts', text: 'export {}' } },
      }).input,
    ).toEqual({ filePath: '/workspace/src/app.ts' });
    expect(served('read', { title: 'shot.png', metadata: { preview: 'Image read successfully' } }).input).toEqual({
      filePath: 'shot.png',
    });
    expect(
      served('edit', {
        title: 'src/app.ts',
        metadata: { diff: '@@', filediff: { file: '/workspace/src/app.ts', patch: '@@', additions: 1, deletions: 1 } },
      }).input,
    ).toEqual({ filePath: '/workspace/src/app.ts' });
    expect(served('write', { title: 'notes.md', metadata: { filepath: '/workspace/notes.md', exists: false } }).input).toEqual({
      filePath: '/workspace/notes.md',
    });
  });

  test('a search, a sub-agent, a fetch, a todo list and a skill get the input their title or metadata proves', () => {
    expect(served('grep', { title: 'TODO', metadata: { matches: 3 } }).input).toEqual({ pattern: 'TODO' });
    expect(served('glob', { title: 'src', metadata: { count: 12 } }).input).toEqual({ path: 'src' });
    expect(served('task', { title: 'Count the files', metadata: { sessionId: 'ses_child' } }).input).toEqual({
      description: 'Count the files',
    });
    expect(
      served('webfetch', { title: 'https://example.com/docs (text/html; charset=utf-8)', metadata: {} }).input,
    ).toEqual({ url: 'https://example.com/docs' });
    const todos = [{ content: 'Ship it', status: 'pending', priority: 'high' }];
    expect(served('todowrite', { title: '1 todos', metadata: { todos } }).input).toEqual({ todos });
    expect(served('skill', { title: 'Loaded skill: release-notes', metadata: {} }).input).toEqual({
      name: 'release-notes',
    });
  });

  test('only a completed call gets an output: a failed one carries an error, and this row lost it', () => {
    const state = served('bash', { status: 'error', title: 'false', metadata: { output: 'partial' } });
    expect(state.input).toEqual({ command: 'false' });
    expect('output' in state).toBe(false);
  });

  test('nothing is invented: a tool that proves no input, or a title in the wrong form, is served as stored', () => {
    const unknown = stripped('memory', { title: '', metadata: { truncated: false } });
    const notAUrl = stripped('webfetch', { title: 'Fetched the page', metadata: {} });
    const notASkill = stripped('skill', { title: 'release-notes', metadata: {} });
    const untitled = stripped('bash', { metadata: { output: 'x' } });
    expect(restoreStrippedToolParts([unknown, notAUrl, notASkill, untitled])).toEqual([
      unknown,
      notAUrl,
      notASkill,
      untitled,
    ]);
  });

  test('a 1:1 call, a call still running and a non-tool part are served untouched', () => {
    const current = {
      id: 'p1',
      type: 'tool',
      tool: 'bash',
      state: { status: 'completed', title: 'ls', input: { command: 'ls' }, output: 'dist', metadata: {}, time: { start: 1, end: 2 } },
    };
    const running = { id: 'p2', type: 'tool', tool: 'bash', state: { status: 'running', title: 'ls', time: { start: 1 } } };
    const text = { id: 'p3', type: 'text', text: 'Checking the build.' };
    const parts = restoreStrippedToolParts([current, running, text]);
    expect(parts).toEqual([current, running, text]);
    expect(parts[0]).toBe(current);
  });
});
