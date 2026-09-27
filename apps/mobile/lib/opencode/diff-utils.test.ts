import { describe, expect, test } from 'bun:test';
import { generateLineDiff, getDiffStats, MAX_LCS_CELLS } from './diff-utils';

describe('generateLineDiff', () => {
  test('small fixture — unchanged, removed, added lines', () => {
    const oldText = 'a\nb\nc';
    const newText = 'a\nx\nc';
    const diff = generateLineDiff(oldText, newText);
    expect(diff).toEqual([
      { type: 'unchanged', text: 'a' },
      { type: 'removed', text: 'b' },
      { type: 'added', text: 'x' },
      { type: 'unchanged', text: 'c' },
    ]);
  });

  test('identical texts produce only unchanged lines', () => {
    const text = 'one\ntwo\nthree';
    const diff = generateLineDiff(text, text);
    expect(diff.every((l) => l.type === 'unchanged')).toBe(true);
    expect(diff.map((l) => l.text)).toEqual(['one', 'two', 'three']);
  });

  test('huge inputs (n·m over the cap) complete fast and stay well-formed', () => {
    const oldLines = Array.from({ length: 5000 }, (_, i) => `line-${i}`);
    const newLines = Array.from({ length: 5000 }, (_, i) => `line-${i}`);
    // Shared prefix, then a fully different tail past the cap boundary.
    for (let i = 2500; i < 5000; i++) newLines[i] = `changed-${i}`;
    expect(oldLines.length * newLines.length).toBeGreaterThan(MAX_LCS_CELLS);

    const start = performance.now();
    const diff = generateLineDiff(oldLines.join('\n'), newLines.join('\n'));
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(200);
    expect(Array.isArray(diff)).toBe(true);
    // The shared prefix must still show as unchanged.
    expect(diff.slice(0, 2500).every((l) => l.type === 'unchanged')).toBe(true);
    // The changed tail must be represented (not silently dropped).
    const addedCount = diff.filter((l) => l.type === 'added').length;
    const removedCount = diff.filter((l) => l.type === 'removed').length;
    expect(addedCount).toBeGreaterThan(0);
    expect(removedCount).toBeGreaterThan(0);
  });
});

describe('getDiffStats', () => {
  test('small fixture matches LCS-derived counts', () => {
    const oldText = 'a\nb\nc';
    const newText = 'a\nx\nc';
    expect(getDiffStats(oldText, newText)).toEqual({ additions: 1, deletions: 1 });
  });

  test('identical texts → zero additions and deletions', () => {
    const text = 'one\ntwo\nthree';
    expect(getDiffStats(text, text)).toEqual({ additions: 0, deletions: 0 });
  });

  test('completely disjoint small texts → every line counted', () => {
    const oldText = 'a\nb';
    const newText = 'c\nd';
    expect(getDiffStats(oldText, newText)).toEqual({ additions: 2, deletions: 2 });
  });

  test('5,000 x 5,000 lines completes under 200ms and returns sane counts', () => {
    const oldLines = Array.from({ length: 5000 }, (_, i) => `line-${i}`);
    const newLines = Array.from({ length: 5000 }, (_, i) => `line-${i}`);
    for (let i = 2500; i < 5000; i++) newLines[i] = `changed-${i}`;
    const oldText = oldLines.join('\n');
    const newText = newLines.join('\n');
    expect(oldLines.length * newLines.length).toBeGreaterThan(MAX_LCS_CELLS);

    const start = performance.now();
    const stats = getDiffStats(oldText, newText);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(200);
    // 2,500 lines were replaced 1:1 with lines that appear nowhere else in either text.
    expect(stats.additions).toBe(2500);
    expect(stats.deletions).toBe(2500);
  });

  test('duplicated lines: multiset counting past the cap is bounded by multiplicity', () => {
    // Same multiset of lines, different order — above the cap this uses a
    // multiset line count rather than full LCS, so no line difference is
    // reported once every line finds a match in the other text.
    const base = Array.from({ length: 600 }, (_, i) => `line-${i % 50}`);
    const shuffled = [...base].reverse();
    expect(base.length * shuffled.length).toBeGreaterThan(MAX_LCS_CELLS / 400); // sanity, not the real cap check below
    const big = Array.from({ length: 20000 }, (_, i) => base[i % base.length]);
    const bigShuffled = Array.from({ length: 20000 }, (_, i) => shuffled[i % shuffled.length]);
    expect(big.length * bigShuffled.length).toBeGreaterThan(MAX_LCS_CELLS);
    const stats = getDiffStats(big.join('\n'), bigShuffled.join('\n'));
    expect(stats.additions).toBe(0);
    expect(stats.deletions).toBe(0);
  });
});
