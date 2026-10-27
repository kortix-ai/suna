import { describe, expect, test } from 'bun:test';
import { sweepBusy } from '../lib';

const WT = '/Users/u/Projects/kortix/suna';

describe('sweepBusy', () => {
  test('a process cwd inside the checkout makes it busy', () => {
    expect(sweepBusy(WT, [`${WT}/apps/web`], [])).toBe(true);
    expect(sweepBusy(WT, [WT], [])).toBe(true);
  });
  test('a sibling checkout with the same prefix does not', () => {
    expect(sweepBusy(WT, [`${WT}-rooms/apps/web`], [`bun ${WT}-rooms/apps/api/src/index.ts`])).toBe(false);
  });
  test('a command line naming the checkout makes it busy', () => {
    expect(sweepBusy(WT, [], [`bun ${WT}/apps/api/src/index.ts`])).toBe(true);
    expect(sweepBusy(WT, [], [`next dev --dir ${WT}`])).toBe(true);
    expect(sweepBusy(WT, [], [`sh -c 'cd ${WT}' `])).toBe(true);
  });
  test('regex characters in the path are literal', () => {
    expect(sweepBusy('/tmp/a.b', [], ['bun /tmp/aXb/x.ts'])).toBe(false);
  });
});
