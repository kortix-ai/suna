import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Streamdown } from 'streamdown';
import {
  buildKatexRehypePlugins,
  escapeCurrencyDollars,
  katexRemarkPlugins,
  normalizeLatexDelimiters,
  prepareMarkdownForKatex,
} from './katex-markdown';

describe('normalizeLatexDelimiters', () => {
  test('normalizes parenthesized inline LaTeX', () => {
    expect(normalizeLatexDelimiters('Euler wrote \\(e^{i\\pi} + 1 = 0\\).')).toBe(
      'Euler wrote $e^{i\\pi} + 1 = 0$.',
    );
  });

  test('normalizes bracketed display LaTeX', () => {
    expect(normalizeLatexDelimiters('Before\n\\[\n\\frac{a}{b}\n\\]\nAfter')).toBe(
      'Before\n$$\n\\frac{a}{b}\n$$\nAfter',
    );
  });

  test('normalizes multiple LaTeX expressions', () => {
    expect(normalizeLatexDelimiters('\\(x\\) plus \\(y\\)')).toBe('$x$ plus $y$');
  });

  test('leaves unmatched delimiters unchanged', () => {
    expect(normalizeLatexDelimiters('unfinished \\(x + y')).toBe('unfinished \\(x + y');
    expect(normalizeLatexDelimiters('unfinished \\[x + y')).toBe('unfinished \\[x + y');
  });

  test('leaves escaped delimiters unchanged', () => {
    expect(normalizeLatexDelimiters('literal \\\\(x\\\\)')).toBe('literal \\\\(x\\\\)');
  });

  test('leaves delimiters inside inline code unchanged', () => {
    expect(normalizeLatexDelimiters('Use `\\(x\\)` in Markdown.')).toBe(
      'Use `\\(x\\)` in Markdown.',
    );
  });

  test('leaves delimiters inside fenced code unchanged', () => {
    const markdown = '```tex\n\\(x\\)\n\\[y\\]\n```\n\nThen \\(z\\).';
    expect(normalizeLatexDelimiters(markdown)).toBe(
      '```tex\n\\(x\\)\n\\[y\\]\n```\n\nThen $z$.',
    );
  });

  test('leaves delimiters inside CRLF fenced code unchanged', () => {
    const markdown = '```tex\r\n\\(x\\)\r\n```\r\n\r\nThen \\(z\\).';
    expect(normalizeLatexDelimiters(markdown)).toBe(
      '```tex\r\n\\(x\\)\r\n```\r\n\r\nThen $z$.',
    );
  });

  test('keeps existing dollar delimiters unchanged', () => {
    expect(normalizeLatexDelimiters('Inline $x$ and display $$y$$.')).toBe(
      'Inline $x$ and display $$y$$.',
    );
  });
});

describe('prepareMarkdownForKatex', () => {
  test('normalizes LaTeX delimiters and escapes currency', () => {
    expect(prepareMarkdownForKatex('Formula \\(x + 1\\) costs $5.')).toBe(
      'Formula $x + 1$ costs \\$5.',
    );
  });

  test('keeps normalized inline math that starts with a digit', () => {
    expect(prepareMarkdownForKatex('Scale by \\(5x\\).')).toBe('Scale by $5x$.');
  });
});

describe('KaTeX markdown pipeline', () => {
  function renderMarkdown(content: string): string {
    return renderToStaticMarkup(
      React.createElement(
        Streamdown,
        {
          mode: 'static',
          remarkPlugins: katexRemarkPlugins,
          rehypePlugins: buildKatexRehypePlugins(false),
        },
        prepareMarkdownForKatex(content),
      ),
    );
  }

  test('renders parenthesized inline LaTeX as KaTeX', () => {
    const html = renderMarkdown('Euler wrote \\(e^{i\\pi} + 1 = 0\\).');
    expect(html).toContain('class="katex"');
    expect(html).toContain('application/x-tex');
  });

  test('renders bracketed display LaTeX as display KaTeX', () => {
    const html = renderMarkdown('\\[\n\\frac{a}{b}\n\\]');
    expect(html).toContain('class="katex-display"');
    expect(html).toContain('<mfrac>');
  });

  test('does not render code delimiters as KaTeX', () => {
    const html = renderMarkdown('Use `\\(x\\)` literally.');
    expect(html).not.toContain('class="katex"');
    expect(html).toContain('>\\(x\\)</code>');
  });
});

describe('escapeCurrencyDollars', () => {
  test('escapes a currency dollar before a digit', () => {
    expect(escapeCurrencyDollars('raised $4M this year')).toBe('raised \\$4M this year');
  });

  test('escapes mid-word currency after a letter', () => {
    expect(escapeCurrencyDollars('price:$1.99')).toBe('price:\\$1.99');
  });

  test('leaves already-escaped dollars unchanged', () => {
    expect(escapeCurrencyDollars('costs \\$5 today')).toBe('costs \\$5 today');
  });

  test('leaves double-dollar block math delimiters unchanged', () => {
    expect(escapeCurrencyDollars('$$5x$$')).toBe('$$5x$$');
  });

  test('leaves inline math without leading digit unchanged', () => {
    expect(escapeCurrencyDollars('formula $E = mc^2$ holds')).toBe('formula $E = mc^2$ holds');
  });

  test('escapes each independent currency amount', () => {
    expect(escapeCurrencyDollars('$5 and $10')).toBe('\\$5 and \\$10');
  });

  test('returns non-string input unchanged', () => {
    expect(escapeCurrencyDollars('')).toBe('');
    expect(escapeCurrencyDollars(null as unknown as string)).toBeNull();
  });
});
