import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../projects/session-lifecycle/actions.ts', import.meta.url),
  'utf8',
);

describe('session restart URL contract', () => {
  test('clears sandboxUrl only when a replacement runtime is required', () => {
    const replacementStart = source.indexOf('const provisionReplacementRuntime');
    const inPlaceStart = source.indexOf('if (\n    existingSandbox?.externalId');

    expect(replacementStart).toBeGreaterThan(-1);
    expect(inPlaceStart).toBeGreaterThan(replacementStart);
    expect(source.slice(replacementStart, inPlaceStart)).toContain('sandboxUrl: null');
    expect(source.slice(inPlaceStart)).not.toContain('sandboxUrl: null');
  });
});
