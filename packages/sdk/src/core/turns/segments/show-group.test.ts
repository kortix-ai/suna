import type { Part, ToolPart } from '../../runtime/client';
import { describe, expect, test } from 'bun:test';
import { segmentTurn } from './segment-turn';
import { groupShowSegments, showGroupItems } from './show-group';

function tool(
  id: string,
  name: string,
  input?: Record<string, unknown>,
  status: string = 'completed',
  extra: Record<string, unknown> = {},
): ToolPart {
  return {
    id,
    type: 'tool',
    tool: name,
    callID: `call_${id}`,
    state: { status, ...(input ? { input } : {}), ...extra },
  } as unknown as ToolPart;
}

function shown(id: string, path = `/workspace/${id}.png`, name = 'show'): ToolPart {
  return tool(id, name, { type: 'image', title: `Shot ${id}`, path });
}

function text(id: string, body: string): Part {
  return { id, type: 'text', text: body } as unknown as Part;
}

describe('groupShowSegments', () => {
  test('two consecutive show calls become one show-group', () => {
    const grouped = groupShowSegments(segmentTurn([shown('1'), shown('2')]));

    expect(grouped).toHaveLength(1);
    expect(grouped[0].kind).toBe('show-group');
    expect((grouped[0] as { parts: ToolPart[] }).parts.map((p) => p.id)).toEqual(['1', '2']);
  });

  test('a single show call stays a standalone segment', () => {
    const grouped = groupShowSegments(segmentTurn([shown('1')]));

    expect(grouped).toHaveLength(1);
    expect(grouped[0].kind).toBe('standalone');
  });

  test('show and show-user in a row group together', () => {
    const grouped = groupShowSegments(segmentTurn([shown('1'), shown('2', undefined, 'show-user')]));

    expect(grouped.map((s) => s.kind)).toEqual(['show-group']);
  });

  test('a text part between two show calls breaks the group', () => {
    const grouped = groupShowSegments(
      segmentTurn([shown('1'), text('t', 'And here is the docs page.'), shown('2')]),
    );

    expect(grouped.map((s) => s.kind)).toEqual(['standalone', 'text', 'standalone']);
  });

  test('another tool call between two show calls breaks the group', () => {
    const grouped = groupShowSegments(segmentTurn([shown('1'), tool('b', 'bash'), shown('2')]));

    expect(grouped.map((s) => s.kind)).toEqual(['standalone', 'burst', 'standalone']);
  });

  test('a non-show standalone tool is never grouped', () => {
    const grouped = groupShowSegments(
      segmentTurn([tool('a', 'agent_spawn'), tool('b', 'agent_status')]),
    );

    expect(grouped.map((s) => s.kind)).toEqual(['standalone', 'standalone']);
  });

  test('invisible parts between show calls do not break the group', () => {
    const snapshot = { id: 's', type: 'snapshot' } as unknown as Part;
    const grouped = groupShowSegments(segmentTurn([shown('1'), snapshot, shown('2')]));

    expect(grouped.map((s) => s.kind)).toEqual(['show-group']);
  });

  test('a show with a pending permission stays on its own', () => {
    const parts = [shown('1'), shown('2'), shown('3')];
    const standaloneCallIds = new Set(['call_2']);
    const grouped = groupShowSegments(segmentTurn(parts, { standaloneCallIds }), {
      standaloneCallIds,
    });

    expect(grouped.map((s) => s.kind)).toEqual(['standalone', 'standalone', 'standalone']);
  });

  test('three shows, text, two shows → two groups in narrative order', () => {
    const grouped = groupShowSegments(
      segmentTurn([shown('1'), shown('2'), shown('3'), text('t', 'More.'), shown('4'), shown('5')]),
    );

    expect(grouped.map((s) => s.kind)).toEqual(['show-group', 'text', 'show-group']);
    expect((grouped[2] as { parts: ToolPart[] }).parts.map((p) => p.id)).toEqual(['4', '5']);
  });

  test('keeps segment identity for segments it does not change', () => {
    const segments = segmentTurn([tool('b', 'bash'), text('t', 'Done.')]);
    const grouped = groupShowSegments(segments);

    expect(grouped[0]).toBe(segments[0]);
    expect(grouped[1]).toBe(segments[1]);
  });
});

describe('showGroupItems', () => {
  test('one item per single-item show call, in call order', () => {
    const items = showGroupItems([shown('1'), shown('2')]);

    expect(items).toEqual([
      {
        callID: 'call_1',
        status: 'ready',
        type: 'image',
        title: 'Shot 1',
        path: '/workspace/1.png',
      },
      {
        callID: 'call_2',
        status: 'ready',
        type: 'image',
        title: 'Shot 2',
        path: '/workspace/2.png',
      },
    ]);
  });

  test('a multi-item show call contributes each of its items', () => {
    const multi = tool('m', 'show', {
      items: JSON.stringify([
        { type: 'image', path: '/workspace/a.png' },
        { type: 'url', url: 'https://example.com' },
      ]),
    });
    const items = showGroupItems([shown('1'), multi]);

    expect(items.map((i) => i.path ?? i.url)).toEqual([
      '/workspace/1.png',
      '/workspace/a.png',
      'https://example.com',
    ]);
    expect(items.map((i) => i.callID)).toEqual(['call_1', 'call_m', 'call_m']);
  });

  test('an items array (not a JSON string) is read the same way', () => {
    const multi = tool('m', 'show', { items: [{ type: 'image', path: '/workspace/a.png' }] });

    expect(showGroupItems([multi]).map((i) => i.path)).toEqual(['/workspace/a.png']);
  });

  test('the stored attachment of a single-item call rides on its item', () => {
    const saved = tool('1', 'show', {
      type: 'image',
      path: '/workspace/1.png',
      attachment: 'att_1',
    });

    expect(showGroupItems([saved])[0].attachment).toBe('att_1');
  });

  test('a running call whose input has not arrived is one pending slot', () => {
    const running = tool('2', 'show', undefined, 'running');
    const items = showGroupItems([shown('1'), running]);

    expect(items).toHaveLength(2);
    expect(items[1]).toEqual({ callID: 'call_2', status: 'pending', type: '' });
  });

  test('a running call that already carries its artifact renders as ready', () => {
    const running = tool('2', 'show', { type: 'image', path: '/workspace/2.png' }, 'running');

    expect(showGroupItems([running])[0].status).toBe('ready');
  });

  test('a failed call keeps its slot and carries the error', () => {
    const failed = tool('2', 'show', { type: 'image', title: 'Docs' }, 'error', {
      error: 'File not found: /workspace/docs.png',
    });
    const items = showGroupItems([shown('1'), failed]);

    expect(items[1]).toEqual({
      callID: 'call_2',
      status: 'error',
      type: 'error',
      title: 'Docs',
      error: 'File not found: /workspace/docs.png',
    });
  });

  test('a settled call with an empty payload is dropped', () => {
    const empty = tool('2', 'show', { type: 'markdown' });

    expect(showGroupItems([shown('1'), empty]).map((i) => i.callID)).toEqual(['call_1']);
  });

  test('items with no artifact inside a multi-item call are dropped', () => {
    const multi = tool('m', 'show', {
      items: [{ type: 'image', path: '/workspace/a.png' }, { type: 'markdown' }],
    });

    expect(showGroupItems([multi])).toHaveLength(1);
  });
});
