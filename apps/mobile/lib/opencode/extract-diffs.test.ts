import { describe, expect, test } from 'bun:test';
import { extractDiffsFromMessages } from './extract-diffs';

function toolPart(tool: string, input: Record<string, unknown>, status: 'completed' | 'running' = 'completed') {
  return { type: 'tool', tool, state: { status, input } };
}

describe('extractDiffsFromMessages', () => {
  test('accumulates edits to the same file into one diff entry', () => {
    const messages = [
      {
        info: { role: 'assistant' },
        parts: [toolPart('edit', { filePath: 'a.ts', oldString: 'foo', newString: 'bar' })],
      },
      {
        info: { role: 'assistant' },
        parts: [toolPart('edit', { filePath: 'a.ts', oldString: 'bar', newString: 'baz' })],
      },
    ];
    const diffs = extractDiffsFromMessages(messages as any);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].file).toBe('a.ts');
    expect(diffs[0].before).toBe('foo');
    expect(diffs[0].after).toBe('baz');
  });

  // extractDiffsFromMessages runs getDiffStats() per changed file (see diff-utils.ts).
  // A large edit (old x new past the LCS cell cap) must not block the JS
  // thread on an uncapped O(n*m) LCS table — getDiffStats' internal size cap
  // must apply here too, not just to its direct callers.
  test('a large single-file edit stays fast (getDiffStats size cap applies per file)', () => {
    const oldLines = Array.from({ length: 5000 }, (_, i) => `line-${i}`);
    const newLines = Array.from({ length: 5000 }, (_, i) => `line-${i}`);
    for (let i = 2500; i < 5000; i++) newLines[i] = `changed-${i}`;
    expect(oldLines.length * newLines.length).toBeGreaterThan(250_000);

    const messages = [
      {
        info: { role: 'assistant' },
        parts: [
          toolPart('edit', {
            filePath: 'big.ts',
            oldString: oldLines.join('\n'),
            newString: newLines.join('\n'),
          }),
        ],
      },
    ];

    const start = performance.now();
    const diffs = extractDiffsFromMessages(messages as any);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(200);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].status).toBe('modified');
    expect(diffs[0].additions).toBe(2500);
    expect(diffs[0].deletions).toBe(2500);
  });

  test('undefined messages → empty result', () => {
    expect(extractDiffsFromMessages(undefined)).toEqual([]);
  });
});
