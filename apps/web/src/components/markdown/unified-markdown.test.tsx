import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { createRequire } from 'node:module';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { UnifiedMarkdown } from './unified-markdown';
import { prepareMarkdownSource } from './unified-markdown-utils';

function withIntl(node: ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      {node}
    </NextIntlClientProvider>
  );
}

const TABLE_MD = ['| Priority | Name |', '| --- | --- |', '| High | G1 |', ''].join('\n');
const ALIGN_TABLE_MD = ['| Center | Right |', '| :---: | ---: |', '| b | c |', ''].join('\n');
const CONFLICTING_CLASS_TABLE_HTML = [
  '<table><tr><th class="whitespace-normal">Head</th></tr>',
  '<tr><td class="break-all">cell</td></tr></table>',
].join('\n');

function cellClasses(html: string, tag: 'th' | 'td'): string[] {
  const matches = [...html.matchAll(new RegExp(`<${tag} class="([^"]*)"`, 'g'))];
  return matches.map((m) => m[1]);
}

function cellTextAligns(html: string, tag: 'th' | 'td'): (string | undefined)[] {
  const matches = [...html.matchAll(new RegExp(`<${tag}\\s+([^>]*)>`, 'g'))];
  return matches.map((m) => /text-align:\s*([a-z]+)/.exec(m[1])?.[1]);
}

describe('UnifiedMarkdown table cells', () => {
  test('th carries whitespace-nowrap and break-normal', () => {
    const html = renderToStaticMarkup(
      withIntl(<UnifiedMarkdown trust="agent" content={TABLE_MD} />),
    );
    const classes = cellClasses(html, 'th');

    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(cls).toContain('whitespace-nowrap');
      expect(cls).toContain('break-normal');
    }
  });

  test('td carries break-normal', () => {
    const html = renderToStaticMarkup(
      withIntl(<UnifiedMarkdown trust="agent" content={TABLE_MD} />),
    );
    const classes = cellClasses(html, 'td');

    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(cls).toContain('break-normal');
    }
  });

  test('th forwards alignment through sanitize for :---: and ---: columns', () => {
    const html = renderToStaticMarkup(
      withIntl(<UnifiedMarkdown trust="agent" content={ALIGN_TABLE_MD} />),
    );
    const aligns = cellTextAligns(html, 'th');

    expect(aligns).toEqual(['center', 'right']);
  });

  test('td forwards alignment through sanitize for :---: and ---: columns', () => {
    const html = renderToStaticMarkup(
      withIntl(<UnifiedMarkdown trust="agent" content={ALIGN_TABLE_MD} />),
    );
    const aligns = cellTextAligns(html, 'td');

    expect(aligns).toEqual(['center', 'right']);
  });

  test('th keeps whitespace-nowrap and break-normal when a raw HTML class conflicts', () => {
    const html = renderToStaticMarkup(
      withIntl(<UnifiedMarkdown trust="agent" content={CONFLICTING_CLASS_TABLE_HTML} />),
    );
    const classes = cellClasses(html, 'th');

    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(cls).toContain('whitespace-nowrap');
      expect(cls).toContain('break-normal');
    }
  });

  test('td keeps break-normal when a raw HTML class conflicts', () => {
    const html = renderToStaticMarkup(
      withIntl(<UnifiedMarkdown trust="agent" content={CONFLICTING_CLASS_TABLE_HTML} />),
    );
    const classes = cellClasses(html, 'td');

    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(cls).toContain('break-normal');
    }
  });

  test('does not leak the react-markdown node prop onto th/td', () => {
    const html = renderToStaticMarkup(
      withIntl(<UnifiedMarkdown trust="agent" content={TABLE_MD} />),
    );

    expect(html).not.toContain('node=');
  });
});

// ─── Ordered-list marker gutter ─────────────────────────────────────────────
// Markers hang outside the `ol` padding box. A fixed `pl-6` gutter (22.08px)
// holds `9. ` (16.3px at 15px Roobert) but not `10. ` (25.7px), so the first
// digit painted past the list edge and an `overflow-hidden` ancestor cut it.
// ────────────────────────────────────────────────────────────────────────────

function orderedListTag(html: string): string {
  const match = /<ol\b[^>]*>/.exec(html);
  if (!match) throw new Error('no <ol> rendered');
  return match[0];
}

function numberedList(count: number, start = 1): string {
  return Array.from({ length: count }, (_, i) => `${start + i}. item`).join('\n') + '\n';
}

describe('UnifiedMarkdown ordered-list marker gutter', () => {
  test('a single-digit list keeps the pl-6 gutter', () => {
    const tag = orderedListTag(
      renderToStaticMarkup(withIntl(<UnifiedMarkdown trust="agent" content={numberedList(9)} />)),
    );

    expect(tag).toContain('padding-inline-start:calc(var(--spacing) * 6 + 0ch)');
  });

  test('a ten-item list widens the gutter by one digit', () => {
    const tag = orderedListTag(
      renderToStaticMarkup(withIntl(<UnifiedMarkdown trust="agent" content={numberedList(10)} />)),
    );

    expect(tag).toContain('padding-inline-start:calc(var(--spacing) * 6 + 1ch)');
  });

  test('markers render with tabular digits', () => {
    const tag = orderedListTag(
      renderToStaticMarkup(withIntl(<UnifiedMarkdown trust="agent" content={numberedList(10)} />)),
    );

    expect(tag).toContain('marker:tabular-nums');
    expect(tag).not.toMatch(/\bpl-6\b/);
  });

  test('forwards the start ordinal and sizes the gutter from it', () => {
    const tag = orderedListTag(
      renderToStaticMarkup(
        withIntl(<UnifiedMarkdown trust="agent" content={numberedList(3, 98)} />),
      ),
    );

    expect(tag).toContain('start="98"');
    expect(tag).toContain('padding-inline-start:calc(var(--spacing) * 6 + 2ch)');
  });
});

// ─── A fenced block inside a list item ──────────────────────────────────────
// `li` runs its children through `wrapChildrenWithPaths`. That walk used to
// descend into the fence and swap the snippet for a React element, so
// `MarkdownCode` stringified an object and Shiki highlighted the literal
// `[object Object]` in place of the commands. Only fences whose body holds a
// detected path (`./Setup.sh`) tripped it, which is why it read as random.
// ────────────────────────────────────────────────────────────────────────────

const FENCE_IN_LIST_MD = [
  '1. Link your GitHub account',
  '',
  '2. **Clone + build**:',
  '',
  '   ```bash',
  '   git clone --depth 1 https://github.com/EpicGames/UnrealEngine ~/UnrealEngine',
  '   cd ~/UnrealEngine',
  '   ./Setup.sh',
  '   make',
  '   ```',
  '',
].join('\n');

const PATH_IN_LIST_MD = ['- open docs/readme.md now', ''].join('\n');

/**
 * The text a reader sees, with the markup removed.
 *
 * Asserting on raw markup is only stable while the fence is UNHIGHLIGHTED:
 * where Shiki's grammar loads synchronously it emits one span per token, so
 * `cd ~/UnrealEngine` lands in two elements and a substring match on the HTML
 * misses. Splitting on the tag delimiters — rather than a `replace()` that
 * reads as an HTML sanitizer it is not — keeps this a test-only text
 * extractor.
 */
function visibleText(html: string): string {
  return html
    .split('<')
    .map((chunk, index) => (index === 0 ? chunk : chunk.slice(chunk.indexOf('>') + 1)))
    .join('');
}

describe('UnifiedMarkdown code fence inside a list', () => {
  test('renders the snippet, not a stringified React element', () => {
    const text = visibleText(
      renderToStaticMarkup(withIntl(<UnifiedMarkdown trust="agent" content={FENCE_IN_LIST_MD} />)),
    );

    expect(text).not.toContain('[object Object]');
    expect(text).toContain('./Setup.sh');
    expect(text).toContain('cd ~/UnrealEngine');
  });

  test('does not inject clickable-path chrome into the fence body', () => {
    const html = renderToStaticMarkup(
      withIntl(<UnifiedMarkdown trust="agent" content={FENCE_IN_LIST_MD} />),
    );

    expect(html).not.toContain('Click to preview');
  });

  test('still makes a path in list prose clickable', () => {
    const html = renderToStaticMarkup(
      withIntl(<UnifiedMarkdown trust="agent" content={PATH_IN_LIST_MD} />),
    );

    expect(html).toContain('docs/readme.md — Click to preview');
  });
});

// ─── A link whose URL is still streaming ────────────────────────────────────
// While a turn streams, Streamdown runs `remend` over the text and closes a
// half-written link as `[label](streamdown:incomplete-link)`. Our sanitize
// schema is GitHub's, which allows only http(s)/mailto/irc/xmpp hrefs, so it
// stripped that href and rehype-harden then rendered the link as
// `label [blocked]` until the closing paren arrived. The static render below is
// exactly what one streaming block renders: `remend` output, parsed.
// ────────────────────────────────────────────────────────────────────────────

const INCOMPLETE_LINK_MD = '[Connect Outlook](streamdown:incomplete-link)';

describe('UnifiedMarkdown — a link whose URL is still streaming', () => {
  test('shows the label, never "[blocked]"', () => {
    const html = renderToStaticMarkup(
      withIntl(<UnifiedMarkdown trust="agent" content={INCOMPLETE_LINK_MD} />),
    );

    expect(visibleText(html)).toBe('Connect Outlook');
    expect(html).not.toContain('Blocked URL');
  });

  test('is not a link yet: no anchor, no placeholder href', () => {
    const html = renderToStaticMarkup(
      withIntl(<UnifiedMarkdown trust="agent" content={INCOMPLETE_LINK_MD} />),
    );

    expect(html).not.toContain('<a');
    expect(html).not.toContain('streamdown:');
  });

  test('a disallowed protocol stays blocked', () => {
    const html = renderToStaticMarkup(
      withIntl(<UnifiedMarkdown trust="agent" content="[run](javascript:alert(1))" />),
    );

    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<a');
  });
});

// ─── A setup link while it streams ──────────────────────────────────────────
// The agent writes `[Connect Outlook](https://…/connect/ksl_…)`, and the token
// alone is several hundred characters. Before these fixes the reader watched
// `Connect Outlook [blocked]`, then a raw `[Connect Outlook](` beside a card
// built from a partial token, then the finished card. Now: the label, then
// the card it will become with nothing to click, then the live card — in the
// same place, the same size.
// ────────────────────────────────────────────────────────────────────────────

const SETUP_TOKEN = `ksl_${'A'.repeat(400)}`;
// No window here, so any http(s) origin counts as this app's own.
const SETUP_URL = `https://app.example.com/connect/${SETUP_TOKEN}`;
const SETUP_LEAD = "Here's a fresh authorization link:\n\n";
const SETUP_MESSAGE = `${SETUP_LEAD}[Connect Outlook](${SETUP_URL})\n\nIt expires in about 30 minutes.`;
const PENDING_HREF = '#kortix-setup-link-pending:connector';

function streamedPrefix(through: string): string {
  const end = SETUP_MESSAGE.indexOf(through) + through.length;
  if (end < through.length) throw new Error(`"${through}" is not in the message`);
  return SETUP_MESSAGE.slice(0, end);
}

describe('prepareMarkdownSource — a setup link while it streams', () => {
  test('the label phase is left for remend to close', () => {
    const source = prepareMarkdownSource(streamedPrefix('[Connect Out'), true);
    expect(source.endsWith('[Connect Out')).toBe(true);
  });

  test('before the route is known, the half-written URL is not linkified', () => {
    const source = prepareMarkdownSource(streamedPrefix('(https://app.example.com/co'), true);
    expect(source.endsWith('[Connect Outlook](https://app.example.com/co')).toBe(true);
    expect(source).not.toContain('([https://');
  });

  test('from the setup route until the closing paren, the link is held as pending', () => {
    for (const through of ['/connect/', '/connect/ksl_AAA', SETUP_TOKEN]) {
      const source = prepareMarkdownSource(streamedPrefix(through), true);
      expect(source.endsWith(`[Connect Outlook](${PENDING_HREF})`)).toBe(true);
      expect(source).not.toContain('ksl_');
    }
  });

  test('once the link closes, the real URL is back', () => {
    const source = prepareMarkdownSource(streamedPrefix(`${SETUP_TOKEN})`), true);
    expect(source).toContain(`[Connect Outlook](${SETUP_URL})`);
    expect(source).not.toContain(PENDING_HREF);
  });

  test('settled text is never held, even when it ends inside a link', () => {
    const source = prepareMarkdownSource(streamedPrefix('/connect/ksl_AAA'), false);
    expect(source).not.toContain(PENDING_HREF);
  });
});

/**
 * The exact `remend` Streamdown runs over streaming text. It is Streamdown's
 * dependency, not this app's, so it is resolved through Streamdown. A server
 * render cannot run streaming mode (Streamdown fills its blocks in an effect),
 * so a streaming block is rendered as what it parses: `remend(source)`.
 */
const remend: (markdown: string) => string = (() => {
  const mod = createRequire(require.resolve('streamdown'))('remend');
  return mod.default ?? mod;
})();

describe('UnifiedMarkdown — a setup link while it streams', () => {
  const render = (through: string) =>
    renderToStaticMarkup(
      withIntl(
        <UnifiedMarkdown
          trust="agent"
          content={remend(prepareMarkdownSource(streamedPrefix(through), true))}
        />,
      ),
    );

  test('before the setup route is known, the label shows as text', () => {
    for (const through of ['[Connect Out', '(https://app.example.com/co']) {
      const html = render(through);
      expect(html).not.toContain('outcome-card');
      expect(html).not.toContain('<a');
    }
    expect(visibleText(render('(https://app.example.com/co'))).toContain('Connect Outlook');
  });

  test('the pending card: the finished card, busy, with its action disabled', () => {
    const html = render('/connect/ksl_AAA');
    expect(html).toContain('data-testid="outcome-card-external"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/<button[^>]*\bdisabled=""[^>]*>Connect<\/button>/);
    expect(visibleText(html)).toContain('Connect Outlook');
    expect(visibleText(html)).toContain('Preparing link…');
  });

  test('never shows raw link syntax, a blocked marker, or token characters', () => {
    for (const through of [
      '[Connect Out',
      '(https://app.example.com/co',
      '/connect/',
      SETUP_TOKEN,
    ]) {
      const text = visibleText(render(through));
      expect(text).not.toContain('](');
      expect(text).not.toContain('[blocked]');
      expect(text).not.toContain('ksl_');
    }
  });

  test('the finished link is the live card', () => {
    const html = render(`${SETUP_TOKEN})`);
    expect(html).toContain('data-testid="outcome-card-external"');
    expect(html).not.toContain('aria-busy');
    expect(html).not.toMatch(/\bdisabled=""/);
    expect(visibleText(html)).toContain('Waiting for you');
  });
});

// ─── Reference-style links ──────────────────────────────────────────────────
// `[the docs][1]` resolves through a definition, `[1]: https://…`. autoLinkUrls
// used to wrap the definition's URL, which corrupted it, so a settled message
// rendered every reference as `the docs [blocked]`.
// ────────────────────────────────────────────────────────────────────────────

const REFERENCE_MD = [
  'Two sources: [the docs][1] and [the changelog][2].',
  '',
  'A second paragraph.',
  '',
  '[1]: https://kortix.com/docs',
  '[2]: https://kortix.com/changelog',
].join('\n');

describe('UnifiedMarkdown — reference-style links', () => {
  test('resolve to their definitions, never "[blocked]"', () => {
    const html = renderToStaticMarkup(
      withIntl(<UnifiedMarkdown trust="agent" content={REFERENCE_MD} />),
    );

    expect(html).toContain('href="https://kortix.com/docs"');
    expect(html).toContain('href="https://kortix.com/changelog"');
    expect(visibleText(html)).toContain('Two sources: the docs and the changelog.');
    expect(html).not.toContain('[blocked]');
  });

  test('the definitions themselves never render', () => {
    const text = visibleText(
      renderToStaticMarkup(withIntl(<UnifiedMarkdown trust="agent" content={REFERENCE_MD} />)),
    );

    expect(text).not.toContain('[1]');
    expect(text).not.toContain('https://kortix.com/docs');
  });
});

// ─── Raw HTML from content no Kortix user wrote ─────────────────────────────
// Scraped pages, connector tool output and public share transcripts all reach
// this renderer with raw HTML enabled. The sanitizer keeps structure and text,
// never presentation: an inline `style` or a class name from the content could
// place an element over the app (`position:fixed`, `fixed inset-0 z-50`).
// KaTeX and code highlighting still render: they run after the sanitizer.
// ────────────────────────────────────────────────────────────────────────────

const OVERLAY_HTML = [
  '<div style="position:fixed;inset:0;z-index:2147483647" class="fixed inset-0 z-50">',
  '<a href="https://example.invalid/login">Sign in</a>',
  '</div>',
  '<span style="position:fixed;top:0" class="fixed top-0">banner</span>',
  '<section style="position:fixed" class="fixed">section</section>',
].join('\n');

describe('UnifiedMarkdown — raw HTML presentation attributes', () => {
  test('drops inline style from raw HTML elements', () => {
    const html = renderToStaticMarkup(
      withIntl(<UnifiedMarkdown trust="untrusted" content={OVERLAY_HTML} />),
    );

    expect(html).toContain('Sign in');
    expect(html).toContain('banner');
    expect(html).not.toContain('position:fixed');
    expect(html).not.toContain('z-index');
  });

  test('drops class names from raw HTML elements', () => {
    const html = renderToStaticMarkup(
      withIntl(<UnifiedMarkdown trust="untrusted" content={OVERLAY_HTML} />),
    );
    const classTokens = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/));

    expect(classTokens).not.toContain('fixed');
    expect(classTokens).not.toContain('inset-0');
    expect(classTokens).not.toContain('z-50');
  });

  test('still renders inline and display math', () => {
    const html = renderToStaticMarkup(
      withIntl(
        <UnifiedMarkdown trust="agent" content={'Inline $x^2$ here.\n\n$$\n\\frac{a}{b}\n$$\n'} />,
      ),
    );

    expect(html).toContain('class="katex"');
    expect(html).toContain('class="katex-display"');
  });

  test('keeps the fence language for code highlighting', () => {
    const html = renderToStaticMarkup(
      withIntl(<UnifiedMarkdown trust="agent" content={'```ts\nconst a = 1;\n```\n'} />),
    );

    // The label is derived from the `language-ts` class the sanitizer kept.
    // The code text itself may already be split into highlight spans.
    expect(html).toContain('>typescript</span>');
  });
});

// ─── Trust levels ───────────────────────────────────────────────────────────
// Every caller names who wrote the text. `markdown-policy.test.ts` pins the
// table; these cases prove the renderer applies each rule to real markup.
// ────────────────────────────────────────────────────────────────────────────

const IMAGE_MD = '![chart](https://images.example.com/chart.png)\n';
const SETUP_LINK_MD = '[Add your key](http://localhost:3000/secret-intake/ksl_7f3a91c2b4)\n';
const SETUP_LINK_CODE_MD = '`/secret-intake/ksl_7f3a91c2b4`\n';
const RAW_HTML_MD = 'Before <kbd>Ctrl</kbd> after\n';

function renderAs(
  content: string,
  trust: 'trusted' | 'agent' | 'untrusted',
  variant?: 'message' | 'document',
): string {
  return renderToStaticMarkup(
    withIntl(<UnifiedMarkdown content={content} trust={trust} variant={variant} />),
  );
}

describe('UnifiedMarkdown — remote images by trust', () => {
  test('trusted and agent text load a remote image', () => {
    for (const trust of ['trusted', 'agent'] as const) {
      const html = renderAs(IMAGE_MD, trust);
      expect(html).toContain('<img');
      expect(html).toContain('https://images.example.com/chart.png');
    }
  });

  test('untrusted text shows a load button instead of the image', () => {
    const html = renderAs(IMAGE_MD, 'untrusted');

    expect(html).not.toContain('<img');
    expect(html).toContain('chart');
    expect(html).toContain('images.example.com');
  });

  test('untrusted raw HTML images wait for a click too', () => {
    const html = renderAs(
      '<p><img src="https://images.example.com/beacon.gif" alt="b"></p>\n',
      'untrusted',
    );

    expect(html).not.toContain('<img');
  });
});

describe('UnifiedMarkdown — setup links by trust', () => {
  test('agent text turns a setup link into the in-app card', () => {
    const html = renderAs(SETUP_LINK_MD, 'agent');

    expect(html).toContain('data-testid="outcome-card-external"');
    expect(html).not.toContain('href="http://localhost:3000/secret-intake/');
  });

  test('agent text turns a backticked setup link into the card', () => {
    expect(renderAs(SETUP_LINK_CODE_MD, 'agent')).toContain('data-testid="outcome-card-external"');
  });

  test('trusted and untrusted text keep a setup link a plain link', () => {
    for (const trust of ['trusted', 'untrusted'] as const) {
      const html = renderAs(SETUP_LINK_MD, trust);
      expect(html).not.toContain('outcome-card-external');
      expect(html).toContain('href="http://localhost:3000/secret-intake/ksl_7f3a91c2b4"');
      expect(html).toContain('Add your key');
      expect(renderAs(SETUP_LINK_CODE_MD, trust)).not.toContain('outcome-card-external');
    }
  });
});

describe('UnifiedMarkdown — document variant', () => {
  test('a message parses embedded HTML at every trust level', () => {
    for (const trust of ['trusted', 'agent', 'untrusted'] as const) {
      const html = renderAs(RAW_HTML_MD, trust);
      expect(html).toContain('<kbd>Ctrl</kbd>');
    }
  });

  test('a document does not parse embedded HTML: tags drop, text stays', () => {
    const html = renderAs(RAW_HTML_MD, 'agent', 'document');

    expect(html).not.toContain('<kbd>');
    expect(html).toContain('Before Ctrl after');
  });

  test('a document keeps tables, fences in lists and ordered-list starts', () => {
    const table = renderAs(TABLE_MD, 'agent', 'document');
    expect(table).toContain('<table');
    expect(table).not.toContain('node=');

    expect(renderAs(FENCE_IN_LIST_MD, 'agent', 'document')).not.toContain('[object Object]');

    const list = renderAs('8. a\n9. b\n10. c\n', 'agent', 'document');
    expect(/<ol\b[^>]*>/.exec(list)?.[0] ?? '').toContain('start="8"');
  });

  test('a document never turns the streaming link placeholder into an anchor', () => {
    const html = renderAs('[Connect Outlook](streamdown:incomplete-link)', 'agent', 'document');

    expect(html).toContain('Connect Outlook');
    expect(html).not.toContain('<a');
    expect(html).not.toContain('streamdown:');
  });
});

describe('UnifiedMarkdown setup links in tables', () => {
  const link = (id: string) => `https://app.example.test/connect/ksl_${id}0000000000`;

  test('an App | Link table of connect links renders as a stack of cards, not a table', () => {
    const md = [
      '| App | Link |',
      '| --- | --- |',
      `| HubSpot | [Connect HubSpot](${link('hubspot')}) |`,
      `| Canva | [Connect Canva](${link('canva')}) |`,
      '',
    ].join('\n');
    const html = renderToStaticMarkup(withIntl(<UnifiedMarkdown trust="agent" content={md} />));
    expect(html).not.toContain('<table');
    expect(html.match(/data-testid="outcome-card-external"/g)?.length).toBe(2);
    expect(html).toContain('Connect HubSpot');
  });

  test('a table with a reason column stays a table, and its link is an inline chip', () => {
    const md = [
      '| App | Why | Link |',
      '| --- | --- | --- |',
      `| HubSpot | Read last quarter's closed deals for the revenue report | [Connect](${link('hubspot')}) |`,
      '',
    ].join('\n');
    const html = renderToStaticMarkup(withIntl(<UnifiedMarkdown trust="agent" content={md} />));
    expect(html).toContain('<table');
    expect(html).toContain('data-testid="setup-link-chip-connector"');
    expect(html).not.toContain('data-testid="outcome-card-external"');
  });

  test('untrusted content keeps the table and plain links', () => {
    const md = ['| App | Link |', '| --- | --- |', `| HubSpot | ${link('hubspot')} |`, ''].join('\n');
    const html = renderToStaticMarkup(withIntl(<UnifiedMarkdown trust="untrusted" content={md} />));
    expect(html).toContain('<table');
    expect(html).not.toContain('setup-link-chip');
  });
});
