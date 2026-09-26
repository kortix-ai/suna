import { describe, test, expect } from 'bun:test';
import { autoLinkUrls, openMarkdownLinkAtEnd } from './url-autolink';

describe('autoLinkUrls', () => {
  test('returns empty string unchanged', () => {
    expect(autoLinkUrls('')).toBe('');
  });

  test('returns text with no links unchanged', () => {
    expect(autoLinkUrls('just some plain text here')).toBe('just some plain text here');
  });

  test('linkifies a full https url', () => {
    expect(autoLinkUrls('see https://github.com/kubet/mk-blog now')).toBe(
      'see [https://github.com/kubet/mk-blog](https://github.com/kubet/mk-blog) now',
    );
  });

  test('linkifies a bare domain by adding https protocol', () => {
    expect(autoLinkUrls('visit example.com today')).toBe(
      'visit [example.com](https://example.com) today',
    );
  });

  test('linkifies a www-prefixed url and keeps www in the href', () => {
    expect(autoLinkUrls('go to www.example.com')).toBe(
      'go to [www.example.com](https://www.example.com)',
    );
  });

  test('converts an email into a mailto link', () => {
    expect(autoLinkUrls('mail me at user@example.com please')).toBe(
      'mail me at [user@example.com](mailto:user@example.com) please',
    );
  });

  test('does not double-wrap an existing markdown link', () => {
    const input = 'click [here](https://example.com)';
    expect(autoLinkUrls(input)).toBe(input);
  });

  test('does not linkify urls inside inline code', () => {
    const input = 'run `curl example.com`';
    expect(autoLinkUrls(input)).toBe(input);
  });

  test('does not linkify urls inside a fenced code block', () => {
    const input = '```\nfetch example.com\n```';
    expect(autoLinkUrls(input)).toBe(input);
  });

  test('linkifies domains between escaped currency amounts (post-preprocess)', () => {
    const input =
      'raised \\$4M). Earlier from example.com. Built SoftGen (\\$50K MRR).';
    expect(autoLinkUrls(input)).toBe(
      'raised \\$4M). Earlier from [example.com](https://example.com). Built SoftGen (\\$50K MRR).',
    );
  });

  test('does not linkify urls inside inline math', () => {
    const input = 'value $a.com$ end';
    expect(autoLinkUrls(input)).toBe(input);
  });

  test('still protects urls inside block math', () => {
    const input = 'equation $$x = \\text{see example.com}$$ end';
    expect(autoLinkUrls(input)).toBe(input);
  });

  test('does not linkify urls inside angle brackets', () => {
    const input = 'see <https://example.com>';
    expect(autoLinkUrls(input)).toBe(input);
  });

  test('linkifies multiple urls in the same text', () => {
    const result = autoLinkUrls('a.com and b.org');
    expect(result).toBe('[a.com](https://a.com) and [b.org](https://b.org)');
  });

  test('preserves a path on a bare domain', () => {
    expect(autoLinkUrls('open example.com/path/to/page')).toBe(
      'open [example.com/path/to/page](https://example.com/path/to/page)',
    );
  });

  test('does not treat a plain sentence word as a domain', () => {
    expect(autoLinkUrls('hello world end')).toBe('hello world end');
  });

  test('returns non-string input unchanged', () => {
    expect(autoLinkUrls(null as any)).toBeNull();
    expect(autoLinkUrls(undefined as any)).toBeUndefined();
  });

  test('skips a bare domain immediately after a slash (file path, old lookbehind semantics)', () => {
    expect(autoLinkUrls('see /etc/config.com for details')).toBe('see /etc/config.com for details');
  });

  test('still links a protocol url even when preceded by a slash', () => {
    expect(autoLinkUrls('mirror /https://example.com')).toBe(
      'mirror /[https://example.com](https://example.com)',
    );
  });

  test('protects adjacent inline math spans without consuming separators', () => {
    expect(autoLinkUrls('$a.com$$b.org$')).toBe('$a.com$$b.org$');
  });

  test('escaped dollars do not open math spans, so following urls still link', () => {
    expect(autoLinkUrls('costs \\$5 at example.com today')).toBe(
      'costs \\$5 at [example.com](https://example.com) today',
    );
  });

  test('inline math spanning a url keeps it unlinked', () => {
    expect(autoLinkUrls('math $x = example.com$ end')).toBe('math $x = example.com$ end');
  });

  // `[1]: https://…` defines the target of a reference-style link, `[text][1]`.
  // Linkifying its URL turned the definition into `[1]: [https://…](https://…)`,
  // a destination beginning `[https`: sanitize stripped it and every reference
  // rendered as `text [blocked]`.
  describe('link reference definitions', () => {
    test('leave the definition line as written', () => {
      const input = [
        'Sources: [the docs][1] and [the changelog][two].',
        '',
        '[1]: https://example.com/docs',
        '[two]: https://example.com/changelog "Changelog"',
        '   [x]: https://example.com/x',
      ].join('\n');
      expect(autoLinkUrls(input)).toBe(input);
    });

    test('bare urls elsewhere in the text still link', () => {
      expect(autoLinkUrls('See example.com.\n\n[1]: https://example.com/docs')).toBe(
        'See [example.com](https://example.com).\n\n[1]: https://example.com/docs',
      );
    });
  });

  // While a turn streams, the text can end inside a link. Linkifying the
  // half-written URL there wrapped it in a second link, so the reader saw
  // `[label]([https://…](https://…)` — a raw `[label](` followed by a link to a
  // truncated URL — until the closing paren arrived. The open link is left as
  // written; Streamdown's remend closes it for display.
  describe('a link still being written at the end of the text', () => {
    test('leaves a half-written destination alone', () => {
      const input = 'Here it is:\n\n[Connect Outlook](https://dev.example.com/connect/ksl_ab';
      expect(autoLinkUrls(input)).toBe(input);
    });

    test('leaves a half-written label alone when the label is a url', () => {
      expect(autoLinkUrls('see [https://example.com/pa')).toBe('see [https://example.com/pa');
      expect(autoLinkUrls('see [https://example.com/path](https://example.com/pa')).toBe(
        'see [https://example.com/path](https://example.com/pa',
      );
    });

    test('still linkifies text before the open link', () => {
      expect(autoLinkUrls('try example.com or [the docs](https://docs.example.com/gu')).toBe(
        'try [example.com](https://example.com) or [the docs](https://docs.example.com/gu',
      );
    });

    test('an unclosed bracket on an earlier line protects nothing after it', () => {
      expect(autoLinkUrls('arr[0\nsee example.com')).toBe(
        'arr[0\nsee [example.com](https://example.com)',
      );
    });

    test('a finished link at the end is not an open one', () => {
      expect(autoLinkUrls('[docs](https://docs.example.com) and example.com')).toBe(
        '[docs](https://docs.example.com) and [example.com](https://example.com)',
      );
    });
  });

  test('adversarial (ReDoS-shaped) input stays fast and correct', () => {
    // Before the quantifiers were bounded, these repetitive strings drove the
    // email / markdown-link / angle-link regexes into polynomial backtracking
    // (seconds+) on user-controlled chat content. Bounded quantifiers keep every
    // match attempt constant-work, so the whole scan stays linear (single-digit
    // ms per input). The time budget is deliberately GENEROUS — a regression to
    // super-linear behaviour on these 50k-char inputs costs seconds-to-minutes
    // (or hangs), which still trips this bound (or the test timeout), while the
    // slack keeps a loaded CI runner from flaking on ordinary scheduling jitter.
    const cases = [
      '%'.repeat(50_000), // email local-part run that never reaches '@'
      'a.'.repeat(30_000), // dotted run with no '@' and no TLD
      '['.repeat(50_000), // markdown-link opens that never reach ']('
      '[]('.repeat(15_000), // link prefixes that never close
      '<http://'.repeat(15_000), // angle links that never close '>'
      `${'['.repeat(50_000)}\nx`, // unclosed labels, then a later line
      `${'[a]('.repeat(12_000)}\n`, // destinations that never close, then a newline
      `[${'a '.repeat(25_000)}`, // one label left open to the very end
      `[${'a'.repeat(50_000)}\n`.repeat(2), // definition-shaped lines that never reach ']:'
    ];
    for (const input of cases) {
      const start = Date.now();
      const out = autoLinkUrls(input);
      expect(typeof out).toBe('string');
      expect(Date.now() - start).toBeLessThan(10_000);
    }
  });
});

describe('openMarkdownLinkAtEnd', () => {
  test('reports a destination that is still arriving', () => {
    expect(openMarkdownLinkAtEnd('Here:\n[Connect Outlook](https://host/connect/ks')).toEqual({
      start: 6,
      label: 'Connect Outlook',
      destination: 'https://host/connect/ks',
    });
  });

  test('reports a label that is still arriving, with no destination yet', () => {
    expect(openMarkdownLinkAtEnd('see [Connect Out')).toEqual({
      start: 4,
      label: 'Connect Out',
      destination: null,
    });
  });

  test('an empty destination is still an open one', () => {
    expect(openMarkdownLinkAtEnd('[docs](')).toEqual({ start: 0, label: 'docs', destination: '' });
  });

  test('finished links, earlier lines, and plain text are not open', () => {
    expect(openMarkdownLinkAtEnd('[docs](https://example.com)')).toBeNull();
    expect(openMarkdownLinkAtEnd('[docs](https://example.com) and more')).toBeNull();
    expect(openMarkdownLinkAtEnd('arr[0\nnext line')).toBeNull();
    expect(openMarkdownLinkAtEnd('no brackets at all')).toBeNull();
    expect(openMarkdownLinkAtEnd('')).toBeNull();
  });
});
