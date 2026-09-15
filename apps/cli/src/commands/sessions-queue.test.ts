import { expect, test } from 'bun:test';
import { wireMessageId } from './sessions-queue.ts';

test.each([
  [1755500000000, 1, '8bbf43300001'],
  [1788957140799, 2, '08627a73f002'],
  [68719476735, 4095, 'ffffffffffff'],
  [68719476736, 0, '000000000000'],
])('keeps the low 48 clock bits at %s with counter %s', (now, counter, expected) => {
  expect(wireMessageId(Number(now), Number(counter))).toMatch(
    new RegExp(`^msg_${expected}[A-Za-z0-9]{14}$`),
  );
});
