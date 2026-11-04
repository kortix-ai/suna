import { describe, expect, test } from 'bun:test';
import { act } from 'react';

import { testRender } from '@opentui/react/test-utils';

import { editText } from './keys.ts';
import { hitRow, memoryWebUrl, pageDetail, pageRow } from './memory-screen.tsx';
import {
  type MemoryPageDetail,
  type MemoryRow,
  MemoryView,
  type MemoryViewProps,
  memoryRowText,
} from './memory-view.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 8, 17, 12, 0, 0).getTime();
const HOUR = 3_600_000;
const SIZE = { width: 84, height: 24 };

function rows(): MemoryRow[] {
  return [
    {
      id: 'p1',
      title: 'Pricing decision',
      type: 'decisions',
      summary: 'Annual plans only',
      updatedMs: NOW - 2 * HOUR,
      layer: null,
    },
    {
      id: 'p2',
      title: 'Ana Silva',
      type: 'people',
      summary: 'Head of support',
      updatedMs: NOW - 30 * HOUR,
      layer: null,
    },
    {
      id: 'p3',
      title: 'Notes',
      type: 'note',
      summary: '',
      updatedMs: NOW - 50 * HOUR,
      layer: null,
    },
  ];
}

const PAGE: MemoryPageDetail = {
  id: 'p1',
  title: 'Pricing decision',
  type: 'decisions',
  body: '# Heading\n\nWe sell annual plans only.',
  updatedMs: NOW - 2 * HOUR,
  author: 'Ana Silva',
  path: '/Company/Memory/decisions/pricing.md',
  sourceCount: 2,
};

function props(overrides: Partial<MemoryViewProps> = {}): MemoryViewProps {
  return {
    rows: rows(),
    focused: true,
    width: 82,
    height: 20,
    now: NOW,
    loading: false,
    errorMessage: null,
    typeOptions: ['people', 'decisions'],
    page: null,
    onQueryChange: () => {},
    onTypeFilter: () => {},
    onOpenPage: () => {},
    onOpenWeb: () => {},
    onRefresh: () => {},
    onBack: () => {},
    ...overrides,
  };
}

async function pressEscape(mockInput: { pressEscape: () => void }): Promise<void> {
  await act(async () => {
    mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}

describe('editText', () => {
  test('appends printable characters and deletes on backspace', () => {
    expect(editText('ab', { name: 'c', sequence: 'c' })).toBe('abc');
    expect(editText('ab', { name: 'backspace', sequence: '\x7f' })).toBe('a');
  });

  test('ignores modified and control keys', () => {
    expect(editText('ab', { name: 'c', sequence: 'c', ctrl: true })).toBeNull();
    expect(editText('ab', { name: 'return', sequence: '\r' })).toBeNull();
    expect(editText('ab', { name: 'up', sequence: '\x1b[A' })).toBeNull();
  });
});

describe('row mappers', () => {
  test('memoryRowText prints the type, title, summary and age', () => {
    const text = memoryRowText(rows()[0] as MemoryRow, NOW, 82);
    expect(text).toContain('decisions');
    expect(text).toContain('Pricing decision · Annual plans only');
    expect(text.trimEnd().endsWith('2h')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(81);
  });

  test('a search hit from a channel prints its layer name', () => {
    const row = hitRow({
      page_id: 'x',
      layer_key: 'space-1',
      layer_name: '#marketing',
      scope: 'channel',
      type: 'playbooks',
      title: 'Launch',
      summary: 's',
      snippet: '…the launch plan…',
    });
    expect(memoryRowText(row, NOW, 82)).toContain('#marketing');
    expect(row.summary).toBe('…the launch plan…');
  });

  test('pageRow and pageDetail carry the API fields', () => {
    const base = {
      page_id: 'p9',
      layer_id: 'company',
      type: 'note' as const,
      title: 'Notes',
      summary: 'S',
      excerpt: '',
      updated_at: '2026-09-17T10:00:00.000Z',
      updated_by: { kind: 'agent' as const, user_id: null, name: null, agent: 'kortix' },
      path: '/Company/Memory/Notes.md',
    };
    expect(pageRow(base)).toMatchObject({ id: 'p9', type: 'note', layer: null });
    const detail = pageDetail({
      ...base,
      body: 'b',
      sources: [],
      related: [],
      version_no: 1,
      can_edit: false,
      can_delete: false,
    });
    expect(detail).toMatchObject({ author: 'kortix', body: 'b', sourceCount: 0 });
  });

  test('memoryWebUrl joins the origin and the project without a double slash', () => {
    expect(memoryWebUrl('https://kortix.com/', 'p1')).toBe('https://kortix.com/projects/p1/memory');
  });
});

describe('<MemoryView/> through the OpenTUI test renderer', () => {
  test('renders one row per page and moves the cursor with j/k/G/g', async () => {
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <MemoryView {...props()} />,
      SIZE,
    );
    await flush();
    const frame = () => captureCharFrame();
    expect(frame()).toContain('Pricing decision');
    expect(frame()).toContain('3 pages');
    const marked = () =>
      frame()
        .split('\n')
        .find((line) => line.startsWith('▌'))
        ?.trim();
    expect(marked()).toContain('Pricing decision');
    await act(async () => mockInput.pressKey('j'));
    await flush();
    expect(marked()).toContain('Ana Silva');
    await act(async () => mockInput.pressKey('G'));
    await flush();
    expect(marked()).toContain('Notes');
    renderer.destroy();
  });

  test('/ takes typed text, reports each change, and Esc clears it', async () => {
    const queries: string[] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <MemoryView {...props({ onQueryChange: (q) => queries.push(q) })} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('/'));
    await act(async () => mockInput.pressKey('p'));
    await act(async () => mockInput.pressKey('r'));
    await flush();
    expect(queries).toEqual(['p', 'pr']);
    expect(captureCharFrame()).toContain('/ pr');
    await pressEscape(mockInput);
    await flush();
    expect(queries.at(-1)).toBe('');
    renderer.destroy();
  });

  test('a one-character query says how many characters search needs', async () => {
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <MemoryView {...props({ rows: [] })} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('/'));
    await act(async () => mockInput.pressKey('a'));
    await flush();
    expect(captureCharFrame()).toContain('Type 2 or more characters to search.');
    renderer.destroy();
  });

  test('Enter asks the host for the page and draws it as Markdown', async () => {
    const asked: Array<string | null> = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <MemoryView {...props({ page: PAGE, onOpenPage: (id) => asked.push(id) })} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 600));
    await flush();
    expect(asked).toEqual(['p1']);
    const frame = captureCharFrame();
    expect(frame).toContain('Ana Silva');
    expect(frame).toContain('2 sources');
    expect(frame).toContain('/Company/Memory/decisions/pricing.md');
    expect(frame).toContain('We sell annual plans only.');

    await pressEscape(mockInput);
    await flush();
    expect(asked).toEqual(['p1', null]);
    expect(captureCharFrame()).toContain('Ana Silva');
    renderer.destroy();
  });

  test('t cycles the type filter through the options, then back to all', async () => {
    const seen: Array<string | null> = [];
    const { flush, mockInput, renderer } = await testRender(
      <MemoryView {...props({ typeFilter: 'decisions', onTypeFilter: (t) => seen.push(t) })} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('t'));
    expect(seen).toEqual([null]);
    renderer.destroy();
  });

  test('o asks the host to open the browser; r asks for a refresh', async () => {
    const calls: string[] = [];
    const { flush, mockInput, renderer } = await testRender(
      <MemoryView
        {...props({ onOpenWeb: () => calls.push('web'), onRefresh: () => calls.push('refresh') })}
      />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('o'));
    await act(async () => mockInput.pressKey('r'));
    expect(calls).toEqual(['web', 'refresh']);
    renderer.destroy();
  });

  test('loading, error and empty states each say what is happening', async () => {
    const loading = await testRender(<MemoryView {...props({ rows: [], loading: true })} />, SIZE);
    await loading.flush();
    expect(loading.captureCharFrame()).toContain('loading pages');
    loading.renderer.destroy();

    const failed = await testRender(
      <MemoryView {...props({ rows: [], errorMessage: 'HTTP 403: feature_disabled' })} />,
      SIZE,
    );
    await failed.flush();
    expect(failed.captureCharFrame()).toContain('HTTP 403: feature_disabled');
    failed.renderer.destroy();

    const empty = await testRender(<MemoryView {...props({ rows: [] })} />, SIZE);
    await empty.flush();
    expect(empty.captureCharFrame()).toContain('No memory pages yet');
    empty.renderer.destroy();
  });
});
