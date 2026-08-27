import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

import { INLINE_CODE } from './code/inline-chip';
import { docsMdxComponents } from './docs-mdx-components';

const Pre = docsMdxComponents.pre;
const InlineCode = docsMdxComponents.code;

/**
 * Same throw-on-miss selector discipline as markdown-code.test.tsx: the card
 * renders the code itself, so a whole-markup match on the language name would
 * pass with the header blank. A selector that stops matching must fail the
 * test, not quietly assert about ''.
 */
const LANGUAGE_CHIP = /<span\b[^>]*\bdata-testid="code-block-language"[^>]*>([^<]*)<\/span>/;
const labelOf = (html: string) => {
  const found = html.match(LANGUAGE_CHIP);
  if (!found) throw new Error('no [data-testid="code-block-language"] span in the rendered card');
  return found[1] ?? '';
};

const CODE_TAG = /<code\b[^>]*\bclass="([^"]*)"/;
const codeClassOf = (html: string) => {
  const found = html.match(CODE_TAG);
  if (!found) throw new Error('no classed <code> in the rendered card');
  return found[1] ?? '';
};

/** `not-prose` sits on the card root and nowhere else in this subtree. */
const CARD = 'not-prose';
const COPY = 'aria-label="Copy code"';

// Shape of rehype-code's build-time output as the `pre` override receives it:
// a <pre class="shiki …"> whose child is <code class="language-…"> holding
// `.line` spans of token spans, separated by '\n' text nodes.
const shikiFence = (lang?: string) => (
  <Pre className="shiki shiki-themes min-light min-dark">
    <code className={lang ? `language-${lang}` : undefined}>
      <span className="line">
        <span style={{ '--shiki-light': '#1c6b48' } as React.CSSProperties}>const</span>
        <span> x = 1;</span>
      </span>
      {'\n'}
      <span className="line">
        <span>const y = 2;</span>
      </span>
    </code>
  </Pre>
);

describe('docsMdxComponents.pre — app CodeBlock shell around rehype-code output', () => {
  test('renders the app code card with the fence language in the header', () => {
    const markup = renderToStaticMarkup(shikiFence('ts'));

    expect(markup).toContain(CARD);
    // languageLabel normalises the hint; 'ts' resolves through the same alias
    // table every other code surface uses.
    expect(labelOf(markup)).toBe('typescript');
  });

  test('rehype-code defaultLanguage "plaintext" labels as text, like app fences', () => {
    const markup = renderToStaticMarkup(shikiFence('plaintext'));

    expect(labelOf(markup)).toBe('text');
  });

  test('copy button appears only because token spans flatten back to raw code', () => {
    // CodeBlock renders CopyButton only for a non-empty `code` string, so the
    // button's presence is the observable proof that flattenToText recovered
    // the source text from the highlighted span tree.
    const markup = renderToStaticMarkup(shikiFence('ts'));

    expect(markup).toContain(COPY);
  });

  test('an empty fence renders the card without a copy button', () => {
    const markup = renderToStaticMarkup(
      <Pre className="shiki">
        <code className="language-text" />
      </Pre>,
    );

    expect(markup).toContain(CARD);
    expect(markup).not.toContain(COPY);
  });

  test('the shiki marker class moves from the pre onto the code element', () => {
    // fumadocs' shiki.css keys token colors and .line padding off `.shiki`;
    // the override discards the original <pre>, so the class must survive on
    // the <code> for the dual-theme CSS vars to apply.
    const markup = renderToStaticMarkup(shikiFence('ts'));
    const codeClass = codeClassOf(markup);

    expect(codeClass).toContain('language-ts');
    expect(codeClass).toContain('shiki');
  });
});

describe('docsMdxComponents.code — one inline chip across docs and chat', () => {
  const render = (children: string) => renderToStaticMarkup(<InlineCode>{children}</InlineCode>);

  test('inline code takes the SHARED chip, not a docs-local near-miss', () => {
    // This file used to carry its own copy of the class string — `rounded-sm`,
    // `bg-muted`, `px-1.5` against the shared chip's `rounded-[5px]`,
    // `bg-inherit`, `px-1` — so the same backticks drew two different chips
    // and every tune to one skipped the other.
    expect(codeClassOf(render('kortix cr open'))).toBe(INLINE_CODE);
  });

  test('a hex colour gets the same swatch the transcript draws', () => {
    const markup = render('#0ea5e9');

    // The value stays literal: it is what gets copied into a stylesheet.
    expect(markup).toContain('#0ea5e9');
    expect(markup).toContain('background-color:#0ea5e9');
    // The square carries no information the hex does not.
    expect(markup).toContain('aria-hidden="true"');
  });

  test('a fenced block is passed through untouched for fumadocs', () => {
    // Multiline content is rehype-code's output on its way to the `pre`
    // override — chipping it would wrap a whole highlighted block in a border.
    const markup = renderToStaticMarkup(
      <InlineCode className="language-ts">{'const x = 1;\nconst y = 2;'}</InlineCode>,
    );

    expect(markup).not.toContain(INLINE_CODE);
    expect(markup).toContain('language-ts');
  });
});

describe('the chip module stays server-safe', () => {
  test('inline-chip.tsx declares no "use client"', () => {
    // This file is a SERVER module. Everything a `'use client'` module exports
    // is a client reference, so importing the hex predicate from the client
    // `inline-code.tsx` and calling it crashed the docs page outright:
    // "Attempted to call isHexColor() from the server but isHexColor is on the
    // client". The chip and the swatch therefore live in a module with no
    // directive; adding one here breaks every docs page, silently at build
    // time and loudly at request time.
    //
    // The check is the DIRECTIVE, not the words: the module's own comment
    // explains why it has none, so a plain substring match would fail on its
    // own documentation.
    const source = readFileSync(
      new URL('./code/inline-chip.tsx', import.meta.url).pathname,
      'utf8',
    );
    const firstStatement = source
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('*') && !line.startsWith('/*'));

    expect(firstStatement).toBeDefined();
    expect(firstStatement).not.toBe("'use client';");
    expect(firstStatement).not.toBe('"use client";');
  });
});
