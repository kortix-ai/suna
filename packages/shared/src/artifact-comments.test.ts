import { describe, expect, test } from 'bun:test';
import { artifactCommentAnchorSchema, reanchorArtifactText, type ArtifactCommentAnchor, type ArtifactTextAnchor } from './artifact-comments';

const anchor = (quote: string, prefix = '', suffix = ''): ArtifactTextAnchor => ({ type: 'text', version: 'v1', quote, prefix, suffix });

describe('artifact comment anchors', () => {
  test('validates text, whole-artifact, point and region selectors', () => {
    const page = { version: 'v1', selector: '#summary', snippet: 'Summary', viewport_width: 1200, scroll: { x: 0, y: 300 } };
    const values: ArtifactCommentAnchor[] = [anchor('A selected sentence'), { type: 'none', version: 'v1' },
      { type: 'point', ...page, offset: { x: 0.5, y: 1 } },
      { type: 'region', ...page, offset: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 } }];
    for (const value of values) {
      expect(artifactCommentAnchorSchema.parse(value)).toEqual(value);
    }
  });

  test('rejects invalid versions, selectors, lengths and geometry', () => {
    const page = { type: 'region', version: 'v1', selector: 'main', snippet: '', viewport_width: 1200, scroll: { x: 0, y: 0 }, offset: { x: 0, y: 0, width: 0.5, height: 0.5 } };
    for (const value of [anchor(''), anchor('x'.repeat(33)), anchor('quote', 'x'.repeat(33)), anchor('quote', '', 'x'.repeat(33)),
      { type: 'none', version: '' }, { ...page, selector: '' }, { ...page, snippet: 'x'.repeat(121) },
      { ...page, viewport_width: Infinity }, { ...page, scroll: { x: 0, y: -1 } },
      { ...page, offset: { x: 0.9, y: 0, width: 0.2, height: 0.5 } },
      { ...page, offset: { x: 0, y: 0, width: 0, height: 0.5 } }, { type: 'none', version: 'v1', comment: 'hidden' }]) {
      expect(artifactCommentAnchorSchema.safeParse(value).success).toBe(false);
    }
  });

  test('rejects NUL and malformed Unicode in every stored anchor string', () => {
    const page = { type: 'point', version: 'v1', selector: 'main', snippet: '', viewport_width: 1200, scroll: { x: 0, y: 0 }, offset: { x: 0, y: 0 } };
    for (const invalid of ['\0', '\uD800', '\uDC00']) {
      for (const value of [
        { type: 'none', version: `v${invalid}` },
        { ...anchor('quote'), quote: `q${invalid}` },
        { ...anchor('quote'), prefix: invalid },
        { ...anchor('quote'), suffix: invalid },
        { ...page, selector: `main${invalid}` },
        { ...page, snippet: invalid },
      ]) {
        expect(artifactCommentAnchorSchema.safeParse(value).success).toBe(false);
      }
    }
    expect(artifactCommentAnchorSchema.safeParse(anchor('A valid 😀 quote')).success).toBe(true);
  });
});

describe('artifact text re-anchoring', () => {
  test('follows a unique quote after text moves without changing the anchor', () => {
    const value = anchor('Selected sentence', 'Old prefix ', '.');
    expect(reanchorArtifactText('New paragraph. Selected sentence.', value)).toEqual({ start: 15, end: 32, outdated: false });
    expect(value.version).toBe('v1');
  });

  test('uses prefix and suffix to disambiguate repeated quotes', () => {
    expect(reanchorArtifactText('first quote. second quote!', anchor('quote', 'second ', '!'))).toEqual({ start: 20, end: 25, outdated: false });
    expect(reanchorArtifactText('quote and quote', anchor('quote')).outdated).toBe(true);
  });

  test('accepts substitution, insertion and deletion within ten percent', () => {
    for (const text of ['xxabcdefghXjyy', 'xxabcdeXfghijyy', 'xxabcdefgijyy', 'xxabcdefghiyy', 'xxbcdefghijyy', 'xxXbcdefghijyy']) {
      const result = reanchorArtifactText(text, anchor('abcdefghij', 'xx', 'yy'));
      expect(result).toEqual({ start: 2, end: text.length - 2, outdated: false });
    }
  });

  test('marks removed, ambiguous or excessively changed quotes outdated', () => {
    for (const text of ['The sentence was removed.', 'abcXefgYij', 'abcdefghXj and abcdefghYj']) {
      expect(reanchorArtifactText(text, anchor('abcdefghij'))).toEqual({ start: null, end: null, outdated: true });
    }
    expect(reanchorArtifactText('shXrt', anchor('short')).outdated).toBe(true);
  });

  test('does not let a later worse match overwrite a better one', () => {
    expect(reanchorArtifactText('xxabcdefghijklmnopqrsXyy abcXefghijklmnopqrXtyy', anchor('abcdefghijklmnopqrst'))).toEqual({ start: 2, end: 22, outdated: false });
  });

  test('disambiguates repeated exact quotes with bounded context', () => {
    const repeated = 'a'.repeat(1_048_576);
    expect(reanchorArtifactText(`${repeated}L a R`, anchor('a', 'L ', ' R')))
      .toEqual({ start: repeated.length + 2, end: repeated.length + 3, outdated: false });
  });

  test('keeps leading deletions when context selects one of repeated fuzzy quotes', () => {
    const quote = 'abcdefghijklmnopqrstuvwxyz123456';
    const shortened = quote.slice(3);
    expect(reanchorArtifactText(`L${shortened}R -- ${shortened}R`, anchor(quote, 'L', 'R')))
      .toEqual({ start: 1, end: 1 + shortened.length, outdated: false });
  });

  test('finds a contextual fuzzy quote at the end of a 16 MiB document with dense false context candidates', () => {
    const repeated = 'ab'.repeat((16 * 1024 * 1024 - 34) / 2);
    const text = `${repeated}a${'ab'.repeat(16)}a`;
    expect(text.length).toBe(16 * 1024 * 1024);
    expect(reanchorArtifactText(text, anchor(`${'ab'.repeat(15)}Xb`, 'a', 'a')))
      .toEqual({ start: repeated.length + 1, end: repeated.length + 33, outdated: false });
  });
});
