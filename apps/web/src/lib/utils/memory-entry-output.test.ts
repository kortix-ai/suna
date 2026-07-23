import { describe, expect, test } from 'bun:test';
import { parseMemoryEntryOutput } from './memory-entry-output';

describe('parseMemoryEntryOutput LTM format', () => {
  test('parses compact LTM fields without a backtracking expression', () => {
    expect(
      parseMemoryEntryOutput(
        '=== LTM #42 [decision] === Caption: Release path Content: Promote main to staging Session: abc Created: 2026-07-23 | Updated: 2026-07-24 Tags: release, staging',
      ),
    ).toEqual({
      kind: 'ltm',
      id: '42',
      type: 'decision',
      caption: 'Release path',
      content: 'Promote main to staging',
      session: 'abc',
      created: '2026-07-23',
      updated: '2026-07-24',
      tags: ['release', 'staging'],
    });
  });

  test('rejects an incomplete LTM header', () => {
    expect(parseMemoryEntryOutput('=== LTM #42 [decision Caption: invalid')).toBeNull();
  });
});
