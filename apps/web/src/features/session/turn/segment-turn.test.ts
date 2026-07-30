import type { Part, ToolPart } from '@/ui';
import { describe, expect, test } from 'bun:test';
import { segmentTurn } from './segment-turn';

function tool(id: string, name: string): ToolPart {
  return {
    id,
    type: 'tool',
    tool: name,
    callID: `call_${id}`,
    state: { status: 'completed' },
  } as unknown as ToolPart;
}

function text(id: string, body: string): Part {
  return { id, type: 'text', text: body } as unknown as Part;
}

function reasoning(id: string, body: string): Part {
  return { id, type: 'reasoning', text: body } as unknown as Part;
}

describe('segmentTurn', () => {
  test('folds interleaved tools into ONE burst', () => {
    const segments = segmentTurn([tool('1', 'read'), tool('2', 'web_search'), tool('3', 'read')]);

    expect(segments).toHaveLength(1);
    expect(segments[0].kind).toBe('burst');
    expect((segments[0] as { parts: Part[] }).parts).toHaveLength(3);
  });

  test('a text part closes a burst and opens a new one', () => {
    const segments = segmentTurn([
      tool('1', 'read'),
      text('2', 'Here is what I found.'),
      tool('3', 'bash'),
    ]);

    expect(segments.map((s) => s.kind)).toEqual(['burst', 'text', 'burst']);
  });

  test('reasoning folds into the burst rather than splitting it', () => {
    const segments = segmentTurn([
      tool('1', 'read'),
      reasoning('2', 'Checking the registration path'),
      tool('3', 'bash'),
    ]);

    expect(segments).toHaveLength(1);
    expect((segments[0] as { parts: Part[] }).parts).toHaveLength(3);
  });

  test('blank text does not split a burst', () => {
    const segments = segmentTurn([tool('1', 'bash'), text('2', '   '), tool('3', 'bash')]);

    expect(segments).toHaveLength(1);
    expect((segments[0] as { parts: Part[] }).parts).toHaveLength(2);
  });

  test('snapshot and patch parts are dropped without splitting', () => {
    const snapshot = { id: '2', type: 'snapshot' } as unknown as Part;
    const patch = { id: '4', type: 'patch' } as unknown as Part;
    const segments = segmentTurn([
      tool('1', 'bash'),
      snapshot,
      tool('3', 'bash'),
      patch,
      tool('5', 'bash'),
    ]);

    expect(segments).toHaveLength(1);
    expect((segments[0] as { parts: Part[] }).parts).toHaveLength(3);
  });

  test('step-start and step-finish parts are dropped without splitting', () => {
    const stepStart = { id: '2', type: 'step-start' } as unknown as Part;
    const stepFinish = { id: '4', type: 'step-finish' } as unknown as Part;
    const segments = segmentTurn([
      tool('1', 'bash'),
      stepStart,
      tool('3', 'bash'),
      stepFinish,
      tool('5', 'bash'),
    ]);

    expect(segments).toHaveLength(1);
    expect((segments[0] as { parts: Part[] }).parts).toHaveLength(3);
  });

  test('show breaks out as standalone and splits the burst', () => {
    const segments = segmentTurn([tool('1', 'read'), tool('2', 'show'), tool('3', 'read')]);

    expect(segments.map((s) => s.kind)).toEqual(['burst', 'standalone', 'burst']);
  });

  test('agent_spawn breaks out as standalone', () => {
    const segments = segmentTurn([tool('1', 'read'), tool('2', 'agent_spawn')]);

    expect(segments.map((s) => s.kind)).toEqual(['burst', 'standalone']);
  });

  test('oc- prefix and hyphens normalize before the standalone check', () => {
    const segments = segmentTurn([tool('1', 'oc-show-user')]);

    expect(segments.map((s) => s.kind)).toEqual(['standalone']);
  });

  test('a part with a pending permission breaks out as standalone', () => {
    const segments = segmentTurn([tool('1', 'read'), tool('2', 'bash')], {
      standaloneCallIds: new Set(['call_2']),
    });

    expect(segments.map((s) => s.kind)).toEqual(['burst', 'standalone']);
  });

  test('returns an empty array for no parts', () => {
    expect(segmentTurn([])).toEqual([]);
  });
});
