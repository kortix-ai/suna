import { describe, expect, test } from 'bun:test';
import { getBlumeDocsOutputPaths } from './blume-docs.mjs';

describe('getBlumeDocsOutputPaths', () => {
  test('names the two files that prove the docs build landed', () => {
    const paths = getBlumeDocsOutputPaths();
    expect(paths.some((p) => p.endsWith('public/docs/index.html'))).toBe(true);
    expect(paths.some((p) => p.endsWith('public/docs/quickstart/index.html'))).toBe(true);
  });
});
