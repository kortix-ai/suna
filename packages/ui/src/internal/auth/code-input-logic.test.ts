import { describe, expect, test } from 'bun:test';

import { applyBackspace, applyBoxInput, insertDigits } from './code-input-logic';

describe('applyBoxInput', () => {
  test('typing a digit into an empty box writes it and advances focus', () => {
    expect(applyBoxInput('', 0, '1')).toEqual({ next: '1', focus: 1 });
    expect(applyBoxInput('12', 2, '3')).toEqual({ next: '123', focus: 3 });
  });

  test('non-digit input is ignored', () => {
    expect(applyBoxInput('12', 2, 'a')).toBeNull();
    expect(applyBoxInput('12', 2, '.')).toBeNull();
    expect(applyBoxInput('12', 2, '')).toBeNull();
  });

  test('typing over an occupied box keeps only the new digit', () => {
    expect(applyBoxInput('123456', 0, '19')).toEqual({ next: '923456', focus: 1 });
    expect(applyBoxInput('123456', 0, '91')).toEqual({ next: '923456', focus: 1 });
  });

  test('typing the same digit over itself keeps a single digit', () => {
    expect(applyBoxInput('123456', 2, '33')).toEqual({ next: '123456', focus: 3 });
  });

  test('one-time-code autofill into the first box fills the whole code', () => {
    expect(applyBoxInput('', 0, '123456')).toEqual({ next: '123456', focus: 5 });
  });

  test('autofill into a partially filled code overwrites from the start', () => {
    expect(applyBoxInput('99', 0, '123456')).toEqual({ next: '123456', focus: 5 });
  });

  test('autofill longer than six digits is truncated to the code length', () => {
    expect(applyBoxInput('', 0, '12345678')).toEqual({ next: '123456', focus: 5 });
  });

  test('multi-digit input starting mid-code writes the sequence from that box', () => {
    expect(applyBoxInput('12', 2, '3456')).toEqual({ next: '123456', focus: 5 });
  });

  test('autofill with separators keeps only the digits', () => {
    expect(applyBoxInput('', 0, '123-456')).toEqual({ next: '123456', focus: 5 });
  });
});

describe('insertDigits', () => {
  test('never exceeds the code length', () => {
    expect(insertDigits('123456', 5, '789').next).toBe('123457');
  });

  test('focus lands after the last written digit but stays in range', () => {
    expect(insertDigits('', 0, '12').focus).toBe(2);
    expect(insertDigits('', 0, '123456').focus).toBe(5);
  });
});

describe('applyBackspace', () => {
  test('clears the current box when it holds a digit and keeps focus there', () => {
    expect(applyBackspace('123', 2)).toEqual({ next: '12', focus: 2 });
    expect(applyBackspace('123456', 0)).toEqual({ next: '23456', focus: 0 });
  });

  test('moves back and shifts the code when the current box is empty', () => {
    expect(applyBackspace('123', 3)).toEqual({ next: '12', focus: 2 });
  });

  test('backspace on the first empty box is a no-op that keeps focus at the start', () => {
    expect(applyBackspace('', 0)).toEqual({ next: '', focus: 0 });
  });
});
