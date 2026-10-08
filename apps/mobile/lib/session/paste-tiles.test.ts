import { describe, expect, test } from 'bun:test';
import { extractPastedInsertion } from './paste-tiles';

const long = 'x'.repeat(1000);
const manyLines = Array.from({ length: 11 }, (_, i) => `line ${i}`).join('\n');

describe('extractPastedInsertion', () => {
  test('a long paste into an empty field leaves the field empty', () => {
    expect(extractPastedInsertion('', long)).toEqual({ text: '', paste: long });
  });

  test('a paste at the cursor keeps the text on both sides', () => {
    expect(extractPastedInsertion('before after', `before ${manyLines}after`)).toEqual({
      text: 'before after',
      paste: manyLines,
    });
  });

  test('a paste over a selection drops the selected text', () => {
    expect(extractPastedInsertion('keep REPLACED end', `keep ${long} end`)).toEqual({
      text: 'keep  end',
      paste: long,
    });
  });

  test('a paste over a longer selection is still a paste', () => {
    const selected = 'y'.repeat(2000);
    expect(extractPastedInsertion(`a${selected}b`, `a${long}b`)).toEqual({ text: 'ab', paste: long });
  });

  test('select-all, then a paste that starts like the old text: the paste is whole and the old text goes', () => {
    const paste = `Fix this: ${'B'.repeat(1000)}`;
    expect(extractPastedInsertion('Fix this:', paste, { start: 0, end: 9 })).toEqual({ text: '', paste });
  });

  test('a paste that starts like the text after the cursor is exact', () => {
    const paste = `The ${'B'.repeat(1000)}`;
    expect(extractPastedInsertion('Start. The end', `Start. ${paste}The end`, { start: 7, end: 7 })).toEqual({
      text: 'Start. The end',
      paste,
    });
  });

  test('a paste with the cursor at the end', () => {
    expect(extractPastedInsertion('abc', `abc${long}`, { start: 3, end: 3 })).toEqual({ text: 'abc', paste: long });
  });

  test('a selection that does not fit the change falls back to the diff', () => {
    // Out of range, and a caret already past the paste (the new caret reported first).
    expect(extractPastedInsertion('ab', `a${long}b`, { start: 5, end: 9 })).toEqual({ text: 'ab', paste: long });
    expect(extractPastedInsertion('ab', `a${long}b`, { start: 1 + long.length, end: 1 + long.length })).toEqual({ text: 'ab', paste: long });
  });

  test('a short insertion at the selection is not a tile', () => {
    expect(extractPastedInsertion('ab', 'aXb', { start: 1, end: 1 })).toBeNull();
  });

  test('typing, short pastes, dictation chunks and deletes are not tiles', () => {
    expect(extractPastedInsertion('hell', 'hello')).toBeNull();
    expect(extractPastedInsertion('', 'x'.repeat(999))).toBeNull();
    expect(extractPastedInsertion('', Array.from({ length: 10 }, () => 'l').join('\n'))).toBeNull();
    expect(extractPastedInsertion('I said', 'I said hello there')).toBeNull();
    expect(extractPastedInsertion(long, '')).toBeNull();
    expect(extractPastedInsertion('same', 'same')).toBeNull();
  });
});
