import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
// eslint-disable-next-line no-restricted-imports -- the test parses real OpenUI source into chart nodes
import { parseGenui } from '@kortix/sdk/genui';

import type { GenuiNode } from '../sdk';
import { ChartView } from './charts';

/** The first block inside `root = Stack([...])`. */
const node = (code: string) => (parseGenui(code).root!.props.children as GenuiNode[])[0]!;
const render = (chart: GenuiNode) =>
  renderToStaticMarkup(<ChartView node={chart} props={chart.props} renderChild={() => null} streaming={false} />);

describe('ChartView', () => {
  test('bar chart: accessible label, reserved height, source, and a Show data table', () => {
    const html = render(
      node('root = Stack([c])\nc = BarChart(["Q1", "Q2"], [s], "billing export", "USD")\ns = Series("Revenue", [120, 1500])'),
    );
    expect(html).toContain('aria-label="Bar chart: Revenue. Source: billing export"');
    expect(html).toContain('h-[220px]');
    expect(html).toContain('Source: billing export');
    expect(html).toMatch(/<details[^>]*><summary[^>]*>[\s\S]*Show data<\/summary>/);
    expect(html).toMatch(/<th[^>]*>Revenue \(USD\)<\/th>/);
    expect(html).toMatch(/<td[^>]*>Q1<\/td><td[^>]*>120<\/td>/);
    expect(html).toMatch(/<td[^>]*>1,500<\/td>/);
  });

  test('line chart: one legend entry per series, each with its own palette slot', () => {
    const html = render(
      node(
        'root = Stack([c])\nc = LineChart(["Mon", "Tue"], [a, b], "status page")\na = Series("p50", [1, 2])\nb = Series("p95", [3, 4])',
      ),
    );
    expect(html).toContain('aria-label="Line chart: p50, p95. Source: status page"');
    expect(html).toContain('--color-s0: var(--chart-3)');
    expect(html).toContain('--color-s1: var(--chart-5)');
    expect(html).toMatch(/<li[^>]*>[\s\S]*?p50<\/li><li[^>]*>[\s\S]*?p95<\/li>/);
  });

  test('pie chart: six slices get six distinct colors and the table shows each share', () => {
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
    expect(html).toMatch(/<td[^>]*>North a<\/td><td[^>]*>50<\/td><td[^>]*>50%<\/td>/);
  });
});
