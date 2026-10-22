import type { Part, ToolPart } from '../../runtime/client';
import { describe, expect, test } from 'bun:test';
import { segmentTurn } from './segment-turn';
import { groupShowSegments } from './show-group';
import { splitTurnWork, workedForLabel } from './work-split';

function tool(id: string, name: string, input: Record<string, unknown> = {}): ToolPart {
  return {
    id,
    type: 'tool',
    tool: name,
    callID: `call_${id}`,
    state: { status: 'completed', input },
  } as unknown as ToolPart;
}

function shown(id: string, name = 'show'): ToolPart {
  return tool(id, name, { type: 'image', title: `Shot ${id}`, path: `/workspace/${id}.png` });
}

function text(id: string, body: string): Part {
  return { id, type: 'text', text: body } as unknown as Part;
}

const segments = (parts: Part[]) => groupShowSegments(segmentTurn(parts));

describe('splitTurnWork', () => {
  test('a working turn is never split', () => {
    const s = segments([tool('1', 'bash'), text('2', 'Done.')]);
    expect(splitTurnWork(s, { working: true })).toBeNull();
  });

  test('a text-only turn has no work, so no split', () => {
    expect(splitTurnWork(segments([text('1', 'Hello.')]), { working: false })).toBeNull();
  });

  test('only deliverables plus text has no work, so no split', () => {
    const s = segments([shown('1'), text('2', 'Here it is.')]);
    expect(splitTurnWork(s, { working: false })).toBeNull();
  });

  test('burst then text: the burst is work, the text is final', () => {
    const s = segments([
      text('1', 'Let me check.'),
      tool('2', 'bash'),
      tool('3', 'read'),
      text('4', 'The answer.'),
    ]);
    const split = splitTurnWork(s, { working: false });

    expect(split).not.toBeNull();
    expect(split!.work.map((seg) => seg.kind)).toEqual(['text', 'burst']);
    expect(split!.hoisted).toEqual([]);
    expect(split!.final.map((seg) => seg.kind)).toEqual(['text']);
    expect((split!.final[0] as { part: { id: string } }).part.id).toBe('4');
  });

  test('no trailing text: everything is work and final is empty', () => {
    const s = segments([text('1', 'Trying.'), tool('2', 'bash')]);
    const split = splitTurnWork(s, { working: false });

    expect(split!.work.map((seg) => seg.kind)).toEqual(['text', 'burst']);
    expect(split!.final).toEqual([]);
  });

  test('deliverables mid-turn and after the final text are hoisted in order', () => {
    const s = segments([
      tool('1', 'bash'),
      shown('2'),
      tool('3', 'read'),
      shown('4'),
      shown('5', 'show-user'),
      text('6', 'Done.'),
      shown('7', 'oc-show'),
    ]);
    const split = splitTurnWork(s, { working: false });

    expect(split!.work.map((seg) => seg.kind)).toEqual(['burst', 'burst']);
    expect(split!.hoisted.map((seg) => seg.kind)).toEqual(['standalone', 'show-group', 'standalone']);
    expect((split!.hoisted[0] as { part: ToolPart }).part.id).toBe('2');
    expect((split!.hoisted[2] as { part: ToolPart }).part.id).toBe('7');
    expect((split!.final[0] as { part: { id: string } }).part.id).toBe('6');
  });

  test('a sub-agent standalone stays in work', () => {
    const s = segments([tool('1', 'agent_spawn'), text('2', 'Done.')]);
    const split = splitTurnWork(s, { working: false });

    expect(split!.work.map((seg) => seg.kind)).toEqual(['standalone']);
    expect(split!.hoisted).toEqual([]);
  });

  test('whitespace-only text is not final', () => {
    // segmentTurn drops blank text, so build the segments by hand.
    const s = [
      { kind: 'burst' as const, parts: [tool('1', 'bash')] },
      { kind: 'text' as const, part: text('2', 'The answer.') as never },
      { kind: 'text' as const, part: text('3', '   \n') as never },
    ];
    const split = splitTurnWork(s, { working: false });

    expect(split!.final.map((seg) => (seg as { part: { id: string } }).part.id)).toEqual(['2']);
    expect(split!.work.map((seg) => seg.kind)).toEqual(['burst', 'text']);
  });

  test('accepts plain Segment[] without groupShowSegments', () => {
    const split = splitTurnWork(segmentTurn([tool('1', 'bash'), shown('2'), text('3', 'Ok.')]), {
      working: false,
    });

    expect(split!.work.map((seg) => seg.kind)).toEqual(['burst']);
    expect(split!.hoisted.map((seg) => seg.kind)).toEqual(['standalone']);
    expect(split!.final.map((seg) => seg.kind)).toEqual(['text']);
  });
});

describe('workedForLabel', () => {
  test('unknown duration', () => expect(workedForLabel(null)).toBe('Worked'));
  test('sub-second duration', () => expect(workedForLabel(500)).toBe('Worked'));
  test('seconds', () => expect(workedForLabel(14_000)).toBe('Worked for 14s'));
  test('minutes and seconds', () => expect(workedForLabel(134_000)).toBe('Worked for 2m 14s'));
});
