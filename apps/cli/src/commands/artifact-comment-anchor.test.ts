import { expect, test } from 'bun:test';
import { artifactCommentAnchor } from './artifact-comment-anchor';

test('quote anchors use the pinned Files commit and bounded surrounding text', () => {
  expect(artifactCommentAnchor('vc_saved', { quote: 'Revenue rose.' }, `${'a'.repeat(40)}Revenue rose.${'b'.repeat(40)}`)).toEqual({
    type: 'text', version: 'vc_saved', quote: 'Revenue rose.', prefix: 'a'.repeat(32), suffix: 'b'.repeat(32),
  });
});

test('context clipping preserves Unicode code points at both boundaries', () => {
  const anchor = artifactCommentAnchor('vc_saved', { quote: 'target' }, `😀${'a'.repeat(31)}target${'b'.repeat(31)}😀`);
  expect(anchor).toMatchObject({ prefix: 'a'.repeat(31), suffix: 'b'.repeat(31) });
});

test('a missing quote fails before a thread payload can be produced', () => {
  expect(() => artifactCommentAnchor('vc_saved', { quote: 'missing' }, 'The saved doc.')).toThrow('quote not found');
});

test('selector anchors document a centered point and fixed viewport without inferred browser geometry', () => {
  expect(artifactCommentAnchor('vc_saved', { selector: '#chart' })).toEqual({
    type: 'point', version: 'vc_saved', selector: '#chart', snippet: '', offset: { x: 0.5, y: 0.5 }, viewport_width: 1280, scroll: { x: 0, y: 0 },
  });
  expect(artifactCommentAnchor('vc_saved', {})).toEqual({ type: 'none', version: 'vc_saved' });
});

test('conflicting flags, empty anchors, overlong quotes, and invalid Unicode are refused', () => {
  for (const options of [{ quote: 'x', selector: '#x' }, { quote: '' }, { quote: 'x'.repeat(33) }, { quote: '\0' }, { quote: '\ud800' }, { selector: '' }, { selector: '#\0' }]) {
    expect(() => artifactCommentAnchor('vc_saved', options, 'x')).toThrow();
  }
});
