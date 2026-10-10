import { expect, mock, test } from 'bun:test';
import * as langCore from '@openuidev/lang-core';

// lang-core's recursive-descent parser can throw (a stack overflow on input the pre-scan misses).
// Force one throw and check that the parser reports it, then recovers on the next call.
const real = { ...langCore };
let throwNext = false;
mock.module('@openuidev/lang-core', () => ({
  ...real,
  createStreamingParser: (...args: Parameters<typeof real.createStreamingParser>) => {
    const parser = real.createStreamingParser(...args);
    return {
      ...parser,
      set: (text: string) => {
        if (throwNext) {
          throwNext = false;
          throw new RangeError('Maximum call stack size exceeded.');
        }
        return parser.set(text);
      },
    };
  },
}));

const { createGenuiParser } = await import('./parse');
const { genuiBlockToMarkdown } = await import('./markdown');

test('a lang-core throw becomes a parse-failed issue, and the next call parses again', () => {
  const parser = createGenuiParser();
  throwNext = true;
  const failed = parser.update('root = Stack([b])\nb = Badge("x")', true);
  expect(failed.root).toBeNull();
  expect(failed.issues.map((issue) => issue.code)).toEqual(['parse-failed']);
  const next = parser.update('root = Stack([b])\nb = Badge("x")', false);
  expect(next.root?.type).toBe('Stack');
  expect(next.issues).toEqual([]);
});

test('genuiBlockToMarkdown never throws', () => {
  throwNext = true;
  expect(genuiBlockToMarkdown('root = Stack([b])\nb = Badge("x")')).toBe('');
});
