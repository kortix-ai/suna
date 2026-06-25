import { describe, expect, test } from 'bun:test';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { visit } from 'unist-util-visit';
import { escapeCurrencyDollars, prepareMarkdownForKatex } from './katex-markdown';

/** Agent-style prose that previously rendered as one giant KaTeX span. */
const AGENT_PROSE = String.raw`**Kortix** (open-source OS for AGI, ~19.8k★, raised $4M). Earlier: BluePage. Built **SoftGen** at 19 ($50K MRR, acquired for 7 figures). Stats cards ($4M raised, 7-figure exit).`;

const LATEX_REFERENCE_SNIPPET = String.raw`### Inline math: $E = mc^2$

| Type | Syntax |
|------|--------|
| **Inline** | \`$E = mc^2$\` → $E = mc^2$ |
| **Fractions** | \`\frac{a}{b}\` → $\frac{a}{b}$ |

$$
\int_{a}^{b} f(x) \, dx = F(b) - F(a)
$$`;

function countMathNodes(markdown: string, singleDollarTextMath: boolean) {
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath, { singleDollarTextMath })
    .parse(markdown);

  let inline = 0;
  let block = 0;
  visit(tree, (node) => {
    if (node.type === 'inlineMath') inline += 1;
    if (node.type === 'math') block += 1;
  });
  return { inline, block };
}

describe('katex-markdown integration', () => {
  test('escapeCurrencyDollars leaves real inline LaTeX intact', () => {
    expect(escapeCurrencyDollars('$E = mc^2$')).toBe('$E = mc^2$');
    expect(escapeCurrencyDollars('$\\frac{a}{b}$')).toBe('$\\frac{a}{b}$');
    expect(escapeCurrencyDollars('raised $4M and $50K')).toBe('raised \\$4M and \\$50K');
    expect(escapeCurrencyDollars('| Apple | $1.99 |')).toBe('| Apple | \\$1.99 |');
  });

  test('agent prose: currency stays plain, no bogus math span', () => {
    const { inline, block } = countMathNodes(prepareMarkdownForKatex(AGENT_PROSE), true);
    expect(inline).toBe(0);
    expect(block).toBe(0);
  });

  test('LaTeX reference snippet: inline and block math parse', () => {
    const { inline, block } = countMathNodes(prepareMarkdownForKatex(LATEX_REFERENCE_SNIPPET), true);
    expect(inline).toBeGreaterThanOrEqual(2);
    expect(block).toBe(1);
  });

  test('block math parses with $$ on own lines', () => {
    const { inline, block } = countMathNodes(
      prepareMarkdownForKatex('Formula:\n\n$$\nE = mc^2\n$$'),
      true,
    );
    expect(inline).toBe(0);
    expect(block).toBe(1);
  });

  test('table currency cells stay plain text', () => {
    const { inline, block } = countMathNodes(
      prepareMarkdownForKatex('| Item | Price |\n|------|------:|\n| Apple | $1.99 |'),
      true,
    );
    expect(inline).toBe(0);
    expect(block).toBe(0);
  });
});
