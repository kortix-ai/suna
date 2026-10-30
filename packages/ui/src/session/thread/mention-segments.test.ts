import { describe, expect, test } from 'bun:test';

import { buildMentionSegments, classifyMentionToken } from './mention-segments';

describe('buildMentionSegments — plain text', () => {
  test('empty text produces no segments at all, so no bubble renders one', () => {
    expect(buildMentionSegments({ text: '' })).toEqual([]);
  });

  test('text with no mention is one untyped run', () => {
    expect(buildMentionSegments({ text: 'ship the thing' })).toEqual([{ text: 'ship the thing' }]);
  });
});

describe('buildMentionSegments — regex detection', () => {
  test('splits a leading mention off the rest of the sentence', () => {
    expect(buildMentionSegments({ text: '@README.md needs a rewrite' })).toEqual([
      { text: '@README.md', type: 'file' },
      { text: ' needs a rewrite' },
    ]);
  });

  test('a known agent name chips as an agent, an unknown one as a file', () => {
    const segments = buildMentionSegments({
      text: 'ask @build then @src/index.ts',
      agentNames: ['build'],
    });
    expect(segments).toEqual([
      { text: 'ask ' },
      { text: '@build', type: 'agent' },
      { text: ' then ' },
      { text: '@src/index.ts', type: 'file' },
    ]);
  });

  test('a bare ses_ token is a session mention even with no session ref', () => {
    expect(buildMentionSegments({ text: 'see @ses_abc123' })).toEqual([
      { text: 'see ' },
      { text: '@ses_abc123', type: 'session' },
    ]);
  });

  test('two identical mentions both chip — neither collapses into the other', () => {
    const segments = buildMentionSegments({ text: '@a.ts and @a.ts' });
    expect(segments.filter((s) => s.type === 'file')).toHaveLength(2);
  });

  test('an email address is not a mention', () => {
    // A bare /@(\S+)/ matched mid-token, so `jay@kortix.com` rendered
    // `@kortix.com` as a file chip pointing at a path that does not exist.
    expect(buildMentionSegments({ text: 'mail me at jay@kortix.com' })).toEqual([
      { text: 'mail me at jay@kortix.com' },
    ]);
  });

  test('trailing sentence punctuation stays prose, not part of the name', () => {
    expect(buildMentionSegments({ text: 'read @README.md, then stop' })).toEqual([
      { text: 'read ' },
      { text: '@README.md', type: 'file' },
      { text: ', then stop' },
    ]);
  });
});

describe('buildMentionSegments — session titles', () => {
  test('a multi-word session title is claimed whole', () => {
    expect(
      buildMentionSegments({
        text: 'continue @Fix the parser please',
        sessionTitles: ['Fix the parser'],
      }),
    ).toEqual([
      { text: 'continue ' },
      { text: '@Fix the parser', type: 'session' },
      { text: ' please' },
    ]);
  });

  test('a session title beats the narrower server ref for its first word', () => {
    // The server cannot see spaces in a title, so it reports `@Fix` as a file
    // mention. The wider session range has to win or the chip says the wrong
    // thing AND opens the wrong target.
    const segments = buildMentionSegments({
      text: '@Fix the parser',
      sessionTitles: ['Fix the parser'],
      sourceRefs: [{ start: 0, end: 4, type: 'file' }],
    });
    expect(segments).toEqual([{ text: '@Fix the parser', type: 'session' }]);
  });
});

describe('buildMentionSegments — server-provided source refs', () => {
  test('a source ref claims its exact span', () => {
    expect(
      buildMentionSegments({
        text: 'open @a.ts now',
        sourceRefs: [{ start: 5, end: 10, type: 'file' }],
      }),
    ).toEqual([{ text: 'open ' }, { text: '@a.ts', type: 'file' }, { text: ' now' }]);
  });

  test('out-of-bounds refs are ignored rather than slicing garbage', () => {
    expect(
      buildMentionSegments({
        text: 'short',
        sourceRefs: [{ start: 2, end: 99, type: 'file' }],
      }),
    ).toEqual([{ text: 'short' }]);
  });

  test('the regex still runs when a structured ref exists', () => {
    // The regression this function exists to fix: `turn/user-message.tsx`
    // returned early the moment it had ANY ref, so every other mention in a
    // message that carried one rendered as plain text.
    const segments = buildMentionSegments({
      text: '@a.ts and @b.ts',
      sourceRefs: [{ start: 0, end: 5, type: 'file' }],
    });
    expect(segments).toEqual([
      { text: '@a.ts', type: 'file' },
      { text: ' and ' },
      { text: '@b.ts', type: 'file' },
    ]);
  });
});

describe('classifyMentionToken', () => {
  // Written out rather than via `test.each`: `@types/bun` has no `each` on
  // `test`, and CLAUDE.md tracks the three files that already trip that
  // `tsc --noEmit` error. This is not becoming the fourth.
  const agents = new Set(['build']);

  test('a ses_ prefix is a session', () => {
    expect(classifyMentionToken('ses_abc', agents)).toBe('session');
  });

  test('a known name is an agent', () => {
    expect(classifyMentionToken('build', agents)).toBe('agent');
  });

  test('everything else is addressed as a file path', () => {
    expect(classifyMentionToken('src/a.ts', agents)).toBe('file');
  });
});
