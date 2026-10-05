import { describe, expect, test } from 'bun:test';
import { parseMemoryEntryOutput } from './projects-memory-entry-output';

// Port of apps/web `lib/utils/memory-entry-output.test.ts`.

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

describe('parseMemoryEntryOutput observation format', () => {
  test('a fact list after Created: does not leak into the date', () => {
    const parsed = parseMemoryEntryOutput(
      [
        '=== Observation #42 [insight] ===',
        'Title: Refactored auth flow',
        'Narrative:',
        'Simplified the login flow by removing redundant redirects.',
        'Session: sess-99',
        'Created: 2026-07-01',
        'Facts:',
        '- Removed duplicate middleware',
        'Concepts: auth, refactor',
      ].join('\n'),
    );

    expect(parsed?.kind).toBe('observation');
    if (parsed?.kind !== 'observation') throw new Error('expected an observation');
    expect(parsed.created).toBe('2026-07-01');
    expect(parsed.facts).toEqual(['Removed duplicate middleware']);
    expect(parsed.session).toBe('sess-99');
  });
});
