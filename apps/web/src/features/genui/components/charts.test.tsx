import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
// eslint-disable-next-line no-restricted-imports -- the test parses real OpenUI source into chart nodes
import { parseGenui } from '@kortix/sdk/genui';

import type { GenuiNode } from '../sdk';
import { ChartView } from './charts';
import { GenuiPending } from './pending';

/** The first block inside `root = Stack([...])`. */
const node = (code: string) => (parseGenui(code).root!.props.children as GenuiNode[])[0]!;
const render = (chart: GenuiNode) =>
  renderToStaticMarkup(<ChartView node={chart} props={chart.props} renderChild={() => null} streaming={false} />);
/** Every header cell stays a table cell, and each body row has as many cells as the header. */
const expectAlignedTable = (html: string) => {
  expect(html).not.toMatch(/<th[^>]*class="[^"]*\bsr-only\b/);
  const headers = html.match(/<thead[\s\S]*?<\/thead>/)![0].match(/<th\b/g)!.length;
  const rows = html.match(/<tbody[\s\S]*?<\/tbody>/)![0].match(/<tr\b[\s\S]*?<\/tr>/g)!;
  for (const row of rows) expect(row.match(/<td\b/g)!.length).toBe(headers);
};
const legend = (html: string) => html.match(/<ul[^>]*>[\s\S]*?<\/ul>/)?.[0] ?? null;

describe('ChartView', () => {
  test('bar chart: accessible label, source with unit, and a Show data table', () => {
    const html = render(
      node('root = Stack([c])\nc = BarChart(["Q1", "Q2"], [s], "billing export", "USD")\ns = Series("Revenue", [120, 1500])'),
    );
    expect(html).toContain('aria-label="Bar chart: Revenue. Source: billing export"');
    expect(html).toMatch(/<figcaption[^>]*>Source: billing export · USD<\/figcaption>/);
    expect(html).toMatch(/<details[^>]*><summary[^>]*>[\s\S]*Show data<\/summary>/);
    expect(html).toMatch(/<th[^>]*><span class="sr-only">Label<\/span><\/th><th[^>]*>Revenue \(USD\)<\/th>/);
    expectAlignedTable(html);
    expect(html).toMatch(/<td[^>]*>Q1<\/td><td[^>]*>120<\/td>/);
    expect(html).toMatch(/<td[^>]*>1,500<\/td>/);
  });

  test('one series draws no legend; two series draw one entry each in palette order', () => {
    const single = render(node('root = Stack([c])\nc = BarChart(["A", "B"], [s], "survey")\ns = Series("Votes", [1, 2])'));
    expect(legend(single)).toBeNull();
    expect(single).toMatch(/<figcaption[^>]*>Source: survey<\/figcaption>/);

    const html = render(
      node(
        'root = Stack([c])\nc = LineChart(["Mon", "Tue"], [a, b, d], "status page")\na = Series("p50", [1, 2])\nb = Series("p95", [3, 4])\nd = Series("p99", [5, 6])',
      ),
    );
    expect(html).toContain('aria-label="Line chart: p50, p95, p99. Source: status page"');
    expect(legend(html)).toMatch(/<li[^>]*>[\s\S]*?p50<\/li><li[^>]*>[\s\S]*?p95<\/li><li[^>]*>[\s\S]*?p99<\/li>/);
    expect(html).toContain('--color-s0: var(--chart-3)');
    expect(html).toContain('--color-s1: var(--chart-5)');
    expect(html).toContain('--color-s2: var(--foreground)');
  });

  test('a series shorter than its categories shows a dash, never an invented zero', () => {
    const html = render(node('root = Stack([c])\nc = BarChart(["A", "B", "C"], [s], "log")\ns = Series("Hits", [4, 5])'));
    expect(html).toMatch(/<td[^>]*>C<\/td><td[^>]*>—<\/td>/);
  });

  test('pie chart: six slices get six distinct colors; the table has a Value column and each share', () => {
    const html = render(
      node(
        'root = Stack([c])\nc = PieChart([a, b, d, e, f, g], "survey")\n' +
          ['a', 'b', 'd', 'e', 'f', 'g'].map((id, i) => `${id} = Slice("North ${id}", ${i === 0 ? 50 : 10})`).join('\n'),
      ),
    );
    expect(html).toContain('aria-label="Pie chart: North a 50, North b 10, North d 10, North e 10, North f 10, North g 10. Source: survey"');
    const colors = new Map([...html.matchAll(/--color-(p\d): ([^;]+);/g)].map((match) => [match[1], match[2]]));
    expect(colors.size).toBe(6);
    expect(new Set(colors.values()).size).toBe(6);
    expect(html).toMatch(/<th[^>]*><span class="sr-only">Label<\/span><\/th><th[^>]*>Value<\/th><th[^>]*>%<\/th>/);
    expectAlignedTable(html);
    expect(html).toMatch(/<td[^>]*>North a<\/td><td[^>]*>50<\/td><td[^>]*>50%<\/td>/);
  });

  test('the pending block reserves the settled figure height, with no border, for every chart type', () => {
    const settled = render(node('root = Stack([c])\nc = BarChart(["A"], [s], "x")\ns = Series("S", [1])'));
    const figureHeight = settled.match(/<figure[^>]*class="[^"]*(min-h-\[\d+px\])/)?.[1];
    expect(figureHeight).toBe('min-h-[299px]');
    for (const type of ['BarChart', 'LineChart', 'PieChart']) {
      const pending = renderToStaticMarkup(<>{GenuiPending({ id: 'c', type, props: {}, partial: true })}</>);
      expect(pending).toContain(figureHeight!);
      expect(pending).not.toMatch(/\bborder\b/);
    }
  });
});
