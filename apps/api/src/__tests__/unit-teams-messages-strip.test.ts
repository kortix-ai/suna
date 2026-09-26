import { describe, expect, test } from 'bun:test';

import { stripTeamsHtml } from '../../../sandbox/slack-cli/lib/teams-messages';

// `teams history` / `teams thread` turn a Graph message body (HTML) into the
// words an agent reads. A tag regex applied once leaves a malformed tag — an
// unclosed `<script` — in the text (CodeQL
// js/incomplete-multi-character-sanitization, PR #7545). No markup may reach
// the agent; text the user typed must.
describe('stripTeamsHtml', () => {
  test('an unclosed tag leaves no markup behind', () => {
    expect(stripTeamsHtml('<p>see <script alert(1)</p>')).not.toContain('<');
    expect(stripTeamsHtml('<p>see <script alert(1)</p>')).toContain('see');
  });

  test('a tag assembled from the pieces one pass leaves behind is removed too', () => {
    expect(stripTeamsHtml('a<<b>i>b')).not.toMatch(/<[^>]+>/);
    expect(stripTeamsHtml('<<script>script>alert(1)<</script>/script>')).not.toContain('<script');
  });

  test('ordinary markup becomes the words, with line breaks and mentions kept', () => {
    expect(stripTeamsHtml('<p>Deploy is <b>green</b>.</p><p>Ask <at>Alice</at>.</p>')).toBe('Deploy is green.\nAsk @Alice.');
  });

  test('text the user typed with angle brackets survives as text', () => {
    // Graph escapes it; decoding is the last step, so it is never taken for a tag.
    expect(stripTeamsHtml('<p>if a &lt; b &amp;&amp; c &gt; d</p>')).toBe('if a < b && c > d');
  });

  test('an image becomes a marker, not nothing', () => {
    expect(stripTeamsHtml('<p>see <img src="https://x/y.png"></p>')).toBe('see [image]');
  });
});
