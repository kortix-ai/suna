import { describe, expect, test } from 'bun:test';
import { parseFilterFlags, parseRunCapFlags } from './triggers-manifest.ts';

// KRTX-1721: the run caps a trigger flag sets, on `add` and on `set`.
describe('parseRunCapFlags', () => {
  test('a whole number of at least 1 becomes the manifest field', () => {
    expect(parseRunCapFlags({ maxRunsPerHour: '5', maxRunsPerDay: '40' }, false)).toEqual({
      caps: { max_runs_per_hour: 5, max_runs_per_day: 40 },
    });
    expect(parseRunCapFlags({}, false)).toEqual({ caps: {} });
  });

  test('`none` removes a cap on set, and is refused on add', () => {
    expect(parseRunCapFlags({ maxRunsPerDay: 'none' }, true)).toEqual({ caps: { max_runs_per_day: null } });
    expect(parseRunCapFlags({ maxRunsPerDay: 'none' }, false)).toEqual({
      error: '--max-runs-per-day must be a whole number of at least 1 (got "none").',
    });
  });

  test('zero, a negative, a fraction or text is refused, naming the flag', () => {
    for (const raw of ['0', '-3', '1.5', 'ten', '']) {
      expect(parseRunCapFlags({ maxRunsPerHour: raw }, true)).toEqual({
        error: `--max-runs-per-hour must be a whole number of at least 1, or none to remove it (got "${raw}").`,
      });
    }
  });
});

describe('parseFilterFlags', () => {
  test('path=value is equality; path:op=value picks an operator; list operators split on commas', () => {
    expect(
      parseFilterFlags([
        'body.type=push',
        'body.ref:not_prefix=refs/heads/kortix/, refs/heads/bot/',
        'body.sender.login:not=kortix-bot',
        'body.action:in=opened,reopened',
        'body.pull_request:exists=true',
        'body.base:prefix=release/',
      ]),
    ).toEqual({
      filter: {
        'body.type': 'push',
        'body.ref': { not_prefix: ['refs/heads/kortix/', 'refs/heads/bot/'] },
        'body.sender.login': { not: ['kortix-bot'] },
        'body.action': { in: ['opened', 'reopened'] },
        'body.pull_request': { exists: true },
        'body.base': { prefix: ['release/'] },
      },
    });
  });

  test('a repeated list operator on one path adds to the list', () => {
    expect(parseFilterFlags(['body.sender.login:not=kortix-bot', 'body.sender.login:not=other-bot'])).toEqual({
      filter: { 'body.sender.login': { not: ['kortix-bot', 'other-bot'] } },
    });
  });

  test('a colon that does not name an operator stays part of the path, and equality keeps commas', () => {
    expect(parseFilterFlags(['headers.x:y=a,b'])).toEqual({ filter: { 'headers.x:y': 'a,b' } });
  });

  test('no flags is no filter', () => {
    expect(parseFilterFlags([])).toEqual({ filter: null });
  });

  test.each([
    ['body.type', '--filter must look like path=value or path:operator=value (got "body.type")'],
    ['=push', '--filter must look like path=value or path:operator=value (got "=push")'],
    ['body.pr:exists=maybe', '--filter body.pr:exists takes true or false (got "maybe")'],
  ])('rejects %s', (flag, error) => {
    expect(parseFilterFlags([flag])).toEqual({ error });
  });

  test('two conditions on one path are rejected', () => {
    expect(parseFilterFlags(['body.ref=main', 'body.ref:not=dev'])).toEqual({
      error: '--filter body.ref takes one condition; repeat only a list operator (not, in, prefix, not_prefix)',
    });
  });
});
