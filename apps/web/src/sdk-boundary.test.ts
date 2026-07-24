import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scanSdkBoundary, violationKey } from '../scripts/sdk-boundary.mjs';

describe('apps/web SDK boundary', () => {
  test('production code adds no forbidden Kortix or runtime imports', () => {
    const baseline = JSON.parse(
      readFileSync(resolve(import.meta.dir, 'sdk-boundary-baseline.json'), 'utf8'),
    ) as string[];
    const actual = scanSdkBoundary(resolve(import.meta.dir)).map(violationKey);
    expect(actual).toEqual(baseline);
  });
});
