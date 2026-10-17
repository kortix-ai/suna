import { describe, expect, test } from 'bun:test';
import { toolCallBlock, type ToolPart } from '@kortix/sdk';
import { blocksOf } from '@/lib/testing/session-log';

import { burstView } from './activity';
import {
  activitySheetEntries,
  burstHasPendingPermission,
  ownsBurst,
  toolHasDetail,
} from './activity-sheet';

// ─── Fixtures ────────────────────────────────────────────────────────────────

let seq = 0;

function tool(
  name: string,
  status: 'pending' | 'running' | 'completed' | 'error',
  input: Record<string, unknown> = {},
  state: Record<string, unknown> = {},
): ToolPart {
  seq += 1;
  return {
    type: 'tool',
    id: `prt_${seq}`,
    callID: `call_${seq}`,
    tool: name,
    sessionID: 's',
    messageID: 'm',
    state: { status, input, ...(status === 'error' ? { error: 'boom' } : {}), ...state },
  } as unknown as ToolPart;
}

/** One call as a block. */
function call(...args: Parameters<typeof tool>) {
  return toolCallBlock(tool(...args));
}

function reasoning(text: string, time: { start?: number; end?: number } = { start: 1, end: 2 }): unknown {
  seq += 1;
  return { type: 'reasoning', id: `prt_${seq}`, sessionID: 's', messageID: 'm', text, time };
}

function patch(): unknown {
  seq += 1;
  return { type: 'patch', id: `prt_${seq}`, sessionID: 's', messageID: 'm', hash: 'h', files: ['/w/a.ts'] };
}

function entriesFor(parts: unknown[], working = false, isTrailing = false) {
  return activitySheetEntries(burstView(blocksOf(parts), working, isTrailing));
}

// ─── Thought summary ─────────────────────────────────────────────────────────

describe('toolHasDetail', () => {
  test('a call with arguments, output, an error, or still running has a detail', () => {
    expect(toolHasDetail(call('bash', 'completed', { command: 'ls' }))).toBe(true);
    expect(toolHasDetail(call('bash', 'error'))).toBe(true);
    expect(toolHasDetail(call('bash', 'running'))).toBe(true);
    expect(toolHasDetail(call('custom', 'completed', {}, { output: 'ok' }))).toBe(true);
  });

  test('a finished call with no arguments and no output has none', () => {
    expect(toolHasDetail(call('bash', 'completed'))).toBe(false);
    expect(toolHasDetail(call('custom', 'completed', { a: '' }, { output: '  ' }))).toBe(false);
  });

  test('navigation-only rows have none', () => {
    expect(toolHasDetail(call('project_select', 'completed', { project: 'p' }))).toBe(false);
    expect(toolHasDetail(call('oc-project-create', 'completed', { name: 'p' }))).toBe(false);
    expect(toolHasDetail(call('todoread', 'completed', { x: 1 }))).toBe(false);
  });

  test('a block that is not a tool call has none: a kept patch summary is a bare "Used" entry', () => {
    const [entry] = entriesFor([patch(), tool('bash', 'completed')]);
    expect(entry).toMatchObject({ kind: 'tool', title: 'Used', openable: false, running: false, failed: false });
  });
});

// ─── Ownership ───────────────────────────────────────────────────────────────

describe('ownsBurst', () => {
  test('a burst owns the open sheet when it shares any block', () => {
    expect(ownsBurst(['a', 'b'], [{ id: 'b' }, { id: 'c' }])).toBe(true);
  });

  test('a burst with no shared block does not', () => {
    expect(ownsBurst(['a'], [{ id: 'b' }])).toBe(false);
    expect(ownsBurst([], [{ id: 'b' }])).toBe(false);
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
  test('thoughts are never entries, whatever their text', () => {
    const entries = entriesFor([reasoning('**Planning**\n\nFirst read the file.'), reasoning('   '), tool('bash', 'completed')]);
    expect(entries).toHaveLength(1);
    expect(entries.every((e) => e.kind === 'tool')).toBe(true);
    expect(entriesFor([reasoning('only thinking')])).toEqual([]);
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

  test('a failed call is flagged', () => {
    const entries = entriesFor([tool('bash', 'error', { command: 'ls' }), tool('bash', 'completed')]);
    expect(entries.map((e) => (e.kind === 'tool' ? e.failed : null))).toEqual([true, false]);
  });

  test('tool entries carry their block, icon key, and a stable key', () => {
    const part = tool('grep', 'completed', { pattern: 'queue' });
    const blocks = blocksOf([part, reasoning('x')]);
    const [entry] = activitySheetEntries(burstView(blocks, false, false));
    expect(entry).toMatchObject({ kind: 'tool', key: part.id, icon: 'search', openable: true });
    expect(entry?.block).toBe(blocks[0]);
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
