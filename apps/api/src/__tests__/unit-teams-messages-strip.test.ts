import { describe, expect, test } from 'bun:test';

import { simplifyTeamsMessages, stripTeamsHtml } from '../../../sandbox/slack-cli/lib/teams-messages';

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

// A file shared in a Teams channel arrives as a `reference` attachment with an
// empty body, and an inline image as a Graph hostedContents `<img>`. History
// dropped the first (no text) and kept only "[image]" for the second, so the
// agent could not tell a file was shared or download the image.
describe('simplifyTeamsMessages keeps what was shared', () => {
  const IMAGE =
    'https://graph.microsoft.com/v1.0/teams/group-1/channels/19:chan@thread.tacv2/messages/171/hostedContents/aWQ9/$value';
  const message = (id: string, content: string, attachments: unknown[] = []) => ({
    id,
    createdDateTime: `2026-10-06T10:00:0${id}Z`,
    messageType: 'message',
    from: { user: { displayName: 'Sam Rivera' } },
    body: { content },
    attachments,
  });

  test('a file-only message is kept, with the file named', () => {
    const [m] = simplifyTeamsMessages([
      message('1', '<attachment id="a1"></attachment>', [
        { id: 'a1', contentType: 'reference', name: 'budget.xlsx', contentUrl: 'https://tenant.sharepoint.com/sites/x/budget.xlsx' },
      ]),
    ]);
    expect(m).toEqual({
      id: '1',
      at: '2026-10-06T10:00:01Z',
      from: 'Sam Rivera',
      text: '',
      files: ['budget.xlsx'],
    });
  });

  test('an inline image keeps its download URL', () => {
    const [m] = simplifyTeamsMessages([message('2', `<p>see this</p><img src="${IMAGE}" alt="image">`)]);
    expect(m.text).toBe('see this\n[image]');
    expect(m.images).toEqual([IMAGE]);
  });

  test('a message with no text, file or image is still dropped', () => {
    expect(simplifyTeamsMessages([message('3', '<p></p>')])).toEqual([]);
  });
});
