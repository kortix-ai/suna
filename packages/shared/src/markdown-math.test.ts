import { describe, expect, test } from 'bun:test';
import {
  KATEX_FENCE_LANGUAGES,
  escapeCurrencyDollars,
  isMathFenceLanguage,
  isMermaidCode,
  normalizeLatexDelimiters,
  prepareMarkdownForKatex,
  prepareMarkdownForMath,
} from './markdown-math';

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

  test('puts single-line bracketed display LaTeX on its own lines', () => {
    expect(normalizeLatexDelimiters('Area \\[\\pi r^2\\] here')).toBe('Area \n$$\n\\pi r^2\n$$\n here');
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
    expect(normalizeLatexDelimiters('Use `\\(x\\)` in Markdown.')).toBe('Use `\\(x\\)` in Markdown.');
  });

  test('leaves delimiters inside fenced code unchanged', () => {
    const markdown = '```tex\n\\(x\\)\n\\[y\\]\n```\n\nThen \\(z\\).';
    expect(normalizeLatexDelimiters(markdown)).toBe('```tex\n\\(x\\)\n\\[y\\]\n```\n\nThen $z$.');
  });

  test('leaves delimiters inside CRLF fenced code unchanged', () => {
    const markdown = '```tex\r\n\\(x\\)\r\n```\r\n\r\nThen \\(z\\).';
    expect(normalizeLatexDelimiters(markdown)).toBe('```tex\r\n\\(x\\)\r\n```\r\n\r\nThen $z$.');
  });

  test('leaves delimiters inside an unclosed fence unchanged', () => {
    expect(normalizeLatexDelimiters('```\n\\(x\\)')).toBe('```\n\\(x\\)');
  });

  test('keeps existing dollar delimiters unchanged', () => {
    expect(normalizeLatexDelimiters('Inline $x$ and display $$y$$.')).toBe('Inline $x$ and display $$y$$.');
  });

  test('returns empty and non-string input unchanged', () => {
    expect(normalizeLatexDelimiters('')).toBe('');
    expect(normalizeLatexDelimiters(undefined as unknown as string)).toBeUndefined();
  });
});

describe('prepareMarkdownForKatex', () => {
  test('normalizes LaTeX delimiters and escapes currency', () => {
    expect(prepareMarkdownForKatex('Formula \\(x + 1\\) costs $5.')).toBe('Formula $x + 1$ costs \\$5.');
  });

  test('keeps normalized inline math that starts with a digit', () => {
    expect(prepareMarkdownForKatex('Scale by \\(5x\\).')).toBe('Scale by $5x$.');
  });
});

describe('prepareMarkdownForMath', () => {
  test('equals prepareMarkdownForKatex on text without code', () => {
    for (const text of [
      'Formula \\(x + 1\\) costs $5.',
      'Scale by \\(5x\\).',
      'raised $4M, then $E = mc^2$ and\n\\[\n\\frac{a}{b}\n\\]\nafter',
      '$$5x$$ and \\$5',
    ]) {
      expect(prepareMarkdownForMath(text)).toBe(prepareMarkdownForKatex(text));
    }
  });

  test('leaves dollars in inline code and fences as written', () => {
    const text = '```bash\necho $1 costs $5\n```\n\nInline `$HOME/$2` and $3';
    expect(prepareMarkdownForMath(text)).toBe('```bash\necho $1 costs $5\n```\n\nInline `$HOME/$2` and \\$3');
    // Web escapes inside code too, and shows `echo \$1`.
    expect(prepareMarkdownForKatex(text)).toContain('echo \\$1');
  });

  test('keeps an unclosed streaming fence untouched', () => {
    expect(prepareMarkdownForMath('Cost $5\n\n```sh\nexport A=$1')).toBe('Cost \\$5\n\n```sh\nexport A=$1');
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

describe('KATEX_FENCE_LANGUAGES', () => {
  test('lists the fence languages web renders as display math', () => {
    expect([...KATEX_FENCE_LANGUAGES].sort()).toEqual(['katex', 'latex', 'math', 'tex']);
  });

  test('isMathFenceLanguage matches case-insensitively', () => {
    expect(isMathFenceLanguage('LaTeX')).toBe(true);
    expect(isMathFenceLanguage('math')).toBe(true);
    expect(isMathFenceLanguage('KATEX')).toBe(true);
    expect(isMathFenceLanguage('python')).toBe(false);
    expect(isMathFenceLanguage('')).toBe(false);
  });
});

describe('isMermaidCode', () => {
  test('an explicit mermaid language is mermaid', () => {
    expect(isMermaidCode('mermaid', 'anything')).toBe(true);
  });

  test('empty code is never mermaid', () => {
    expect(isMermaidCode('mermaid', '  \n ')).toBe(false);
    expect(isMermaidCode('', '')).toBe(false);
  });

  test('an unlabelled fence is mermaid when its first line declares a diagram', () => {
    expect(isMermaidCode('', 'graph TD\n  A --> B')).toBe(true);
    expect(isMermaidCode('text', '\n  sequenceDiagram\n  A->>B: hi')).toBe(true);
    expect(isMermaidCode('plain', 'gitGraph\n  commit')).toBe(true);
    expect(isMermaidCode('', 'FlowChart LR')).toBe(true);
  });

  test('an unlabelled fence that only mentions a keyword later is not mermaid', () => {
    expect(isMermaidCode('', 'hello\ngraph TD')).toBe(false);
  });

  test('a fence with another language is not mermaid', () => {
    expect(isMermaidCode('ts', 'graph TD')).toBe(false);
    expect(isMermaidCode('Mermaid', 'graph TD')).toBe(false);
  });
});
