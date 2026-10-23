import { describe, expect, test } from 'bun:test';
import { likePattern, snippetOf } from './search';

describe('memory search', () => {
  test('the title pattern matches q literally: %, _ and \\ are escaped', () => {
    expect(likePattern('50%')).toBe('%50\\%%');
    expect(likePattern('q4_launch')).toBe('%q4\\_launch%');
    expect(likePattern('a\\b')).toBe('%a\\\\b%');
    expect(likePattern('plain words')).toBe('%plain words%');
  });

  test('the snippet sits around the first match, without source tokens, with … where it is cut', () => {
    const body = `## Status\n${'Intro text. '.repeat(30)}Pricing stays at $49 per seat ⟦2⟧ until March. ${'More text. '.repeat(30)}`;
    const snippet = snippetOf(body, 'per seat');
    expect(snippet).toContain('per seat until March');
    expect(snippet).not.toContain('⟦');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(162);
  });

  test('no whole-query match: the first matching word; no match at all: the start of the body', () => {
    expect(snippetOf('Priya approves launch copy.', '"launch" OR -budget')).toBe('Priya approves launch copy.');
    expect(snippetOf('Short body.', 'nothing here')).toBe('Short body.');
    expect(snippetOf('', 'q4')).toBe('');
  });
});
