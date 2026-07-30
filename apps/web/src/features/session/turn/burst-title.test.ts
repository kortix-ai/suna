import type { Part, ToolPart } from '@/ui';
import { describe, expect, test } from 'bun:test';
import { burstTitle } from './burst-title';

function tool(id: string, name: string, input: Record<string, unknown> = {}): ToolPart {
  return {
    id,
    type: 'tool',
    tool: name,
    callID: `call_${id}`,
    state: { status: 'completed', input },
  } as unknown as ToolPart;
}

function reasoning(id: string, body: string): Part {
  return { id, type: 'reasoning', text: body } as unknown as Part;
}

describe('burstTitle', () => {
  test('a bold heading in reasoning wins outright', () => {
    const title = burstTitle(
      [
        reasoning('r', '**Architected ten production hardening fixes**\n\nDetail follows.'),
        tool('1', 'read'),
      ],
      false,
    );
    expect(title).toBe('Architected ten production hardening fixes');
  });

  test('without a bold heading the first reasoning line is used', () => {
    const title = burstTitle([reasoning('r', 'Auditing worker registration\nmore text')], false);
    expect(title).toBe('Auditing worker registration');
  });

  test('a leading markdown hash is stripped from the first line', () => {
    expect(burstTitle([reasoning('r', '## Checking quota limits')], false)).toBe(
      'Checking quota limits',
    );
  });

  test('with no reasoning it composes from verbs and counts', () => {
    const title = burstTitle([tool('1', 'read'), tool('2', 'read'), tool('3', 'bash')], false);
    expect(title).toBe('Read 2 files, ran 1 command');
  });

  test('running state uses the present participle', () => {
    expect(burstTitle([tool('1', 'read'), tool('2', 'read')], true)).toBe('Reading 2 files');
  });

  test('only the first clause is capitalised', () => {
    const title = burstTitle([tool('1', 'bash'), tool('2', 'read')], false);
    expect(title).toBe('Ran 1 command, read 1 file');
  });

  test('clauses cap at three and the rest roll into +N more', () => {
    const title = burstTitle(
      [
        tool('1', 'read'),
        tool('2', 'bash'),
        tool('3', 'web_search'),
        tool('4', 'write'),
        tool('5', 'list'),
      ],
      false,
    );
    expect(title).toBe('Read 1 file, ran 1 command, searched 1 time, +2 more');
  });

  test('plumbing parts are never counted', () => {
    const title = burstTitle(
      [tool('1', 'read'), tool('2', 'dcp_compress'), tool('3', 'memory')],
      false,
    );
    expect(title).toBe('Read 1 file');
  });

  test('a burst of only plumbing falls back to a neutral title', () => {
    expect(burstTitle([tool('1', 'dcp_prune')], false)).toBe('Housekeeping');
  });

  test('an empty burst returns a neutral title rather than an empty string', () => {
    expect(burstTitle([], false)).toBe('Worked');
  });
});
