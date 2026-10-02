import { describe, expect, test } from 'bun:test';
import { markdownToMrkdwn, mrkdwnToRichTextElements, slackMentionsAsText } from './mrkdwn';

describe('markdownToMrkdwn', () => {
  test('converts double-asterisk bold to single', () => {
    expect(markdownToMrkdwn('this is **important** stuff')).toBe('this is *important* stuff');
  });

  test('converts double-underscore bold to single asterisk', () => {
    expect(markdownToMrkdwn('this is __important__ stuff')).toBe('this is *important* stuff');
  });

  test('converts markdown links to mrkdwn links', () => {
    expect(markdownToMrkdwn('see [the docs](https://example.com/docs) here')).toBe(
      'see <https://example.com/docs|the docs> here',
    );
  });

  test('converts image links to mrkdwn links', () => {
    expect(markdownToMrkdwn('![chart](https://example.com/c.png)')).toBe('<https://example.com/c.png|chart>');
  });

  test('drops link titles', () => {
    expect(markdownToMrkdwn('[docs](https://example.com "Docs")')).toBe('<https://example.com|docs>');
  });

  test('converts headings to bold lines', () => {
    expect(markdownToMrkdwn('# Summary\n\n## Details')).toBe('*Summary*\n\n*Details*');
  });

  test('converts strikethrough', () => {
    expect(markdownToMrkdwn('~~gone~~')).toBe('~gone~');
  });

  test('converts list markers to bullets', () => {
    expect(markdownToMrkdwn('- one\n* two\n  - nested')).toBe('• one\n• two\n  • nested');
  });

  test('does not treat a bold line start as a list marker', () => {
    expect(markdownToMrkdwn('**bold** lead')).toBe('*bold* lead');
  });

  test('leaves fenced code blocks untouched', () => {
    const input = 'run:\n```\n**not bold** [not](https://a.link)\n```';
    expect(markdownToMrkdwn(input)).toBe(input);
  });

  test('leaves inline code untouched', () => {
    expect(markdownToMrkdwn('use `**argv**` here')).toBe('use `**argv**` here');
  });

  test('passes valid mrkdwn through unchanged', () => {
    const input = 'a *bold* _italic_ <https://example.com|link> `code`';
    expect(markdownToMrkdwn(input)).toBe(input);
  });

  test('converts bold inside link labels', () => {
    expect(markdownToMrkdwn('[**PR #4321**](https://github.com/pr/4321)')).toBe(
      '<https://github.com/pr/4321|*PR #4321*>',
    );
  });

  test('handles empty input', () => {
    expect(markdownToMrkdwn('')).toBe('');
  });

  test('mixed real-world answer', () => {
    const input = '## Root cause\n\nThe **auth middleware** drops headers. See [the fix](https://github.com/acme/pr/1).\n\n- reverted\n- redeployed';
    expect(markdownToMrkdwn(input)).toBe(
      '*Root cause*\n\nThe *auth middleware* drops headers. See <https://github.com/acme/pr/1|the fix>.\n\n• reverted\n• redeployed',
    );
  });
});

describe('mrkdwnToRichTextElements', () => {
  test('plain text becomes a single text element', () => {
    expect(mrkdwnToRichTextElements('just words')).toEqual([{ type: 'text', text: 'just words' }]);
  });

  test('labeled link becomes a link element', () => {
    expect(mrkdwnToRichTextElements('see <https://example.com|the docs> now')).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'link', url: 'https://example.com', text: 'the docs' },
      { type: 'text', text: ' now' },
    ]);
  });

  test('bare link becomes a link element without label', () => {
    expect(mrkdwnToRichTextElements('<https://example.com>')).toEqual([
      { type: 'link', url: 'https://example.com' },
    ]);
  });

  test('bold becomes a styled text element', () => {
    expect(mrkdwnToRichTextElements('47 *ERROR* lines')).toEqual([
      { type: 'text', text: '47 ' },
      { type: 'text', text: 'ERROR', style: { bold: true } },
      { type: 'text', text: ' lines' },
    ]);
  });

  test('inline code becomes a code-styled element', () => {
    expect(mrkdwnToRichTextElements('run `pnpm test` first')).toEqual([
      { type: 'text', text: 'run ' },
      { type: 'text', text: 'pnpm test', style: { code: true } },
      { type: 'text', text: ' first' },
    ]);
  });

  test('empty string yields one empty text element', () => {
    expect(mrkdwnToRichTextElements('')).toEqual([{ type: 'text', text: '' }]);
  });
});

// A `<@U…>` in a plan step printed as raw markup (2026-10-02), and as a live
// mention it would notify that person on every repaint. Steps carry names as
// text; a channel reference renders natively and notifies no one.
describe('slackMentionsAsText', () => {
  const names = new Map([['U0TEST2', 'Alex Kim']]);

  test('a mention becomes @Name: its own label, else the looked-up name, else the id', () => {
    expect(slackMentionsAsText('ask <@U0TEST1|Sam> and <@U0TEST2>, cc <@U0TEST3>', names)).toBe(
      'ask @Sam and @Alex Kim, cc @U0TEST3',
    );
  });

  test('broadcasts, user groups and dates become text that pings no one', () => {
    expect(
      slackMentionsAsText('<!here> <!channel> <!everyone> <!subteam^S0TEAM|@oncall> <!subteam^S0TEAM> <!date^1700000000^{date}|Nov 14>', names),
    ).toBe('@here @channel @everyone @oncall @group Nov 14');
  });

  test('channel references, links and other markup stay as written', () => {
    const text = 'see <#C0OPS|ops>, <#C0DEV> and <https://example.test|docs>; a <b> & *bold*';
    expect(slackMentionsAsText(text, names)).toBe(text);
  });

  test("a name's markup characters are escaped", () => {
    expect(slackMentionsAsText('ask <@U0TEST2>', new Map([['U0TEST2', 'A <b> & c']]))).toBe('ask @A &lt;b&gt; &amp; c');
  });

  const within = (label: string, run: () => unknown) =>
    test(label, () => {
      const started = performance.now();
      run();
      expect(performance.now() - started).toBeLessThan(100);
    });
  within('120k > and no <', () => slackMentionsAsText('>'.repeat(120_000), names));
  within('80k <@ openers and no >', () => slackMentionsAsText('<@U0'.repeat(80_000), names));
  within('60k nested < openers before one >', () => slackMentionsAsText(`${'<'.repeat(60_000)}@U0X>`, names));
});

describe('mrkdwnToRichTextElements: channel references', () => {
  test('a channel reference becomes a channel element, labelled or not', () => {
    expect(mrkdwnToRichTextElements('see <#C0OPS|ops> and <#C0DEV> now')).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'channel', channel_id: 'C0OPS' },
      { type: 'text', text: ' and ' },
      { type: 'channel', channel_id: 'C0DEV' },
      { type: 'text', text: ' now' },
    ]);
  });
});
