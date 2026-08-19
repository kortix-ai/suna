import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { docsMdxComponents } from './docs-mdx-components';

const Pre = docsMdxComponents.pre;

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
