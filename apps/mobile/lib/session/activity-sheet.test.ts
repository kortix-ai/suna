import { describe, expect, test } from 'bun:test';
import type { Part } from '@kortix/sdk';

import { burstView } from './activity';
import {
  activitySheetEntries,
  burstHasPendingPermission,
  ownsBurst,
  summarizeThought,
  toolHasDetail,
} from './activity-sheet';

// ─── Fixtures ────────────────────────────────────────────────────────────────

let seq = 0;

function tool(
  name: string,
  status: 'pending' | 'running' | 'completed' | 'error',
  input: Record<string, unknown> = {},
): Part {
  seq += 1;
  return {
    type: 'tool',
    id: `prt_${seq}`,
    callID: `call_${seq}`,
    tool: name,
    sessionID: 's',
    messageID: 'm',
    state: { status, input, ...(status === 'error' ? { error: 'boom' } : {}) },
  } as unknown as Part;
}

function reasoning(text: string, time: { start?: number; end?: number } = { start: 1, end: 2 }): Part {
  seq += 1;
  return { type: 'reasoning', id: `prt_${seq}`, sessionID: 's', messageID: 'm', text, time } as unknown as Part;
}

function entriesFor(parts: Part[], working = false, isTrailing = false) {
  return activitySheetEntries(burstView(parts, working, isTrailing));
}

// ─── Thought summary ─────────────────────────────────────────────────────────

describe('summarizeThought', () => {
  test('a leading bold heading is the title and leaves the body', () => {
    expect(summarizeThought(['**Drafting a prompt for the queue UI**\n\nI need to look at the composer first.'])).toEqual({
      title: 'Drafting a prompt for the queue UI',
      body: 'I need to look at the composer first.',
    });
  });

  test('the heading may sit in a later fragment', () => {
    expect(summarizeThought(['Some context.', '**Mapping queue behaviour**\n\nbody'])).toEqual({
      title: 'Mapping queue behaviour',
      body: 'Some context.\n\nbody',
    });
  });

  test('a fragment that is only a heading leaves no empty paragraph', () => {
    expect(summarizeThought(['**Planning**', 'Read the file.'])).toEqual({ title: 'Planning', body: 'Read the file.' });
  });

  test('without a heading, the first sentence is the title, with no prefix', () => {
    expect(summarizeThought(['Recalling how queued messages behave. Then check the drain order.'])).toEqual({
      title: 'Recalling how queued messages behave.',
      body: 'Recalling how queued messages behave. Then check the drain order.',
    });
  });

  test('markdown never leaks into the title, and whitespace collapses', () => {
    expect(summarizeThought(['Check `useQueue` in\n\n**composer** first'])).toMatchObject({
      title: 'Check useQueue in composer first',
    });
  });
});

// ─── Tool detail ─────────────────────────────────────────────────────────────

describe('toolHasDetail', () => {
  test('a call with arguments, output, an error, or still running has a detail', () => {
    expect(toolHasDetail(tool('bash', 'completed', { command: 'ls' }))).toBe(true);
    expect(toolHasDetail(tool('bash', 'error'))).toBe(true);
    expect(toolHasDetail(tool('bash', 'running'))).toBe(true);
    expect(toolHasDetail({ ...tool('custom', 'completed'), state: { status: 'completed', input: {}, output: 'ok' } } as unknown as Part)).toBe(true);
  });

  test('a finished call with no arguments and no output has none', () => {
    expect(toolHasDetail(tool('bash', 'completed'))).toBe(false);
    expect(toolHasDetail({ ...tool('custom', 'completed'), state: { status: 'completed', input: { a: '' }, output: '  ' } } as unknown as Part)).toBe(false);
  });

  test('navigation-only rows have none', () => {
    expect(toolHasDetail(tool('project_select', 'completed', { project: 'p' }))).toBe(false);
    expect(toolHasDetail(tool('oc-project-create', 'completed', { name: 'p' }))).toBe(false);
    expect(toolHasDetail(tool('todoread', 'completed', { x: 1 }))).toBe(false);
  });

  test('a part that is not a tool call has none', () => {
    expect(toolHasDetail(reasoning('x'))).toBe(false);
  });
});

// ─── Ownership ───────────────────────────────────────────────────────────────

describe('ownsBurst', () => {
  test('a burst owns the open sheet when it shares any part', () => {
    expect(ownsBurst(['a', 'b'], [{ id: 'b' }, { id: 'c' }] as Part[])).toBe(true);
  });

  test('a burst with no shared part does not', () => {
    expect(ownsBurst(['a'], [{ id: 'b' }] as Part[])).toBe(false);
    expect(ownsBurst([], [{ id: 'b' }] as Part[])).toBe(false);
  });
});

describe('burstHasPendingPermission', () => {
  test('true when a pending permission names a call the sheet showed', () => {
    expect(burstHasPendingPermission(['call_1', 'call_2'], [{ tool: { callID: 'call_2' } }])).toBe(true);
  });

  test('false for other calls and permissions without a call', () => {
    expect(burstHasPendingPermission(['call_1'], [{ tool: { callID: 'call_9' } }, {}])).toBe(false);
  });
});

// ─── Entries ─────────────────────────────────────────────────────────────────

describe('activitySheetEntries', () => {
  test('a thought is one entry with its summary as title and the rest as body', () => {
    const [entry] = entriesFor([reasoning('**Planning**\n\nFirst read the file.'), tool('bash', 'completed')]);
    expect(entry).toMatchObject({
      kind: 'thought',
      title: 'Planning',
      body: 'First read the file.',
      running: false,
      openable: true,
    });
  });

  test('thought fragments merge into one entry whose body keeps paragraphs', () => {
    const entries = entriesFor([reasoning('one'), reasoning('two'), tool('bash', 'completed')]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: 'thought', body: 'one\n\ntwo' });
  });

  test('a same-family group expands into one entry per call', () => {
    const entries = entriesFor([
      tool('read', 'completed', { filePath: '/w/a.ts' }),
      tool('read', 'completed', { filePath: '/w/b.ts' }),
    ]);
    expect(entries.map((e) => e.title)).toEqual(['Read a.ts', 'Read b.ts']);
    expect(entries.every((e) => e.kind === 'tool')).toBe(true);
  });

  test('tool titles use the SDK step label with its object', () => {
    const entries = entriesFor([
      tool('web_search', 'completed', { query: 'queue messages while working' }),
      tool('webfetch', 'completed', { url: 'https://example.com/docs' }),
    ]);
    expect(entries.map((e) => e.title)).toEqual([
      'Searched queue messages while working',
      'Fetched https://example.com/docs',
    ]);
  });

  test('an unknown tool is named in plain words, never by its identifier', () => {
    const entries = entriesFor([tool('linear/create_issue', 'completed'), tool('bash', 'completed')]);
    expect(entries[0]?.title).toBe('Used Create Issue');
  });

  test('a call without an object is the verb alone', () => {
    const entries = entriesFor([tool('bash', 'completed'), tool('read', 'completed')]);
    expect(entries.map((e) => e.title)).toEqual(['Ran', 'Read']);
  });

  test('a running call in a live burst uses the participle and is running', () => {
    const entries = entriesFor(
      [tool('bash', 'completed', { command: 'ls' }), tool('bash', 'running', { command: 'bun test' })],
      true,
      true,
    );
    expect(entries.map((e) => [e.title, e.running])).toEqual([
      ['Ran ls', false],
      ['Running bun test', true],
    ]);
  });

  test('a pending call in a settled turn is not running', () => {
    const entries = entriesFor([tool('bash', 'completed'), tool('bash', 'pending', { command: 'ls' })]);
    expect(entries[1]).toMatchObject({ title: 'Ran ls', running: false });
  });

  test('only the last thought of a live burst is running', () => {
    const entries = entriesFor(
      [reasoning('first', { start: 1 }), tool('bash', 'completed'), reasoning('second', { start: 3 })],
      true,
      true,
    );
    expect(entries.map((e) => e.running)).toEqual([false, false, true]);
  });

  test('a failed call is flagged', () => {
    const entries = entriesFor([tool('bash', 'error', { command: 'ls' }), tool('bash', 'completed')]);
    expect(entries.map((e) => (e.kind === 'tool' ? e.failed : null))).toEqual([true, false]);
  });

  test('tool entries carry their part, icon key, and a stable key', () => {
    const part = tool('grep', 'completed', { pattern: 'queue' });
    const [entry] = entriesFor([part, reasoning('x')]);
    expect(entry).toMatchObject({ kind: 'tool', key: part.id, part, icon: 'search', openable: true });
  });

  test('a tool entry without a detail is not openable', () => {
    const entries = entriesFor([tool('bash', 'completed'), tool('read', 'completed', { filePath: '/a.ts' })]);
    expect(entries.map((e) => e.openable)).toEqual([false, true]);
  });

  test('plumbing never becomes an entry', () => {
    const entries = entriesFor([tool('get_mem', 'completed'), tool('bash', 'completed'), tool('read', 'completed')]);
    expect(entries.map((e) => e.title)).toEqual(['Ran', 'Read']);
  });
});
