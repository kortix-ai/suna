import { describe, expect, test } from 'bun:test';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { XAxis, YAxis } from 'recharts';
// eslint-disable-next-line no-restricted-imports -- the test parses real OpenUI source into chart nodes
import { parseGenui } from '@kortix/sdk/genui';

import { ChartContainer } from '@/components/ui/chart';

import type { GenuiNode } from '../sdk';
import { ChartDataTable, ChartView } from './charts';
import { CHART_FIGURE_HEIGHT, GenuiPending } from './pending';

/** The first block inside `root = Stack([...])`. */
const node = (code: string) => (parseGenui(code).root!.props.children as GenuiNode[])[0]!;
const render = (chart: GenuiNode) =>
  renderToStaticMarkup(<ChartView node={chart} props={chart.props} renderChild={() => null} streaming={false} />);
/** The Show data table. It opens in a dialog (a portal, absent from static markup), so it renders on its own here. */
const table = (chart: GenuiNode) => renderToStaticMarkup(<ChartDataTable node={chart} />);
/** Every header cell stays a table cell, and each body row has as many cells as the header. */
const expectAlignedTable = (html: string) => {
  expect(html).not.toMatch(/<th[^>]*class="[^"]*\bsr-only\b/);
  const headers = html.match(/<thead[\s\S]*?<\/thead>/)![0].match(/<th\b/g)!.length;
  const rows = html.match(/<tbody[\s\S]*?<\/tbody>/)![0].match(/<tr\b[\s\S]*?<\/tr>/g)!;
  for (const row of rows) expect(row.match(/<td\b/g)!.length).toBe(headers);
};
const legend = (html: string) => html.match(/<ul[^>]*>[\s\S]*?<\/ul>/)?.[0] ?? null;

describe('ChartView', () => {
  test('bar chart: accessible label, source with unit, and a Show data table in a dialog', () => {
    const chart = node('root = Stack([c])\nc = BarChart(["Q1", "Q2"], [s], "billing export", "USD")\ns = Series("Revenue", [120, 1500])');
    const html = render(chart);
    expect(html).toContain('aria-label="Bar chart: Revenue. Source: billing export"');
    // One header row above the plot: the source as the title on the left, Show data on the right.
    expect(html).toMatch(/<figure[^>]*><div[^>]*><span[^>]*title="billing export · USD"[^>]*>billing export · USD<\/span><button[^>]*>Show data<\/button><\/div><div class="flex h-\[244px\]/);
    expect(html).toMatch(/<button type="button"[^>]*aria-haspopup="dialog"[^>]*>[\s\S]*Show data<\/button>/);
    const data = table(chart);
    expect(data).toMatch(/<th[^>]*><span class="sr-only">Label<\/span><\/th><th[^>]*>Revenue \(USD\)<\/th>/);
    expectAlignedTable(data);
    expect(data).toMatch(/<td[^>]*>Q1<\/td><td[^>]*>120<\/td>/);
    expect(data).toMatch(/<td[^>]*>1,500<\/td>/);
  });

  test('the legend names every series, one included (the catalog has no chart title); the figure keeps its reserved height', () => {
    const single = render(node('root = Stack([c])\nc = BarChart(["A", "B"], [s], "survey")\ns = Series("Votes", [1, 2])'));
    expect(legend(single)).toMatch(/<li[^>]*>[\s\S]*?Votes<\/li>/);
    expect(single).toMatch(/<span[^>]*>survey<\/span>/);
    // The plot block is fixed: the legend takes its row from the chart, never from the figure.
    expect(single).toContain(CHART_FIGURE_HEIGHT);
    expect(single).toContain('h-[244px]');

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
    const html = table(node('root = Stack([c])\nc = BarChart(["A", "B", "C"], [s], "log")\ns = Series("Hits", [4, 5])'));
    expect(html).toMatch(/<td[^>]*>C<\/td><td[^>]*>—<\/td>/);
  });

  test('pie chart: six slices get six distinct colors; the table has a Value column and each share', () => {
    const chart = node(
      'root = Stack([c])\nc = PieChart([a, b, d, e, f, g], "survey")\n' +
        ['a', 'b', 'd', 'e', 'f', 'g'].map((id, i) => `${id} = Slice("North ${id}", ${i === 0 ? 50 : 10})`).join('\n'),
    );
    const html = render(chart);
    const data = table(chart);
    expect(html).toContain('aria-label="Pie chart: North a 50, North b 10, North d 10, North e 10, North f 10, North g 10. Source: survey"');
    const colors = new Map([...html.matchAll(/--color-(p\d): ([^;]+);/g)].map((match) => [match[1], match[2]]));
    expect(colors.size).toBe(6);
    expect(new Set(colors.values()).size).toBe(6);
    expect(data).toMatch(/<th[^>]*><span class="sr-only">Label<\/span><\/th><th[^>]*>Value<\/th><th[^>]*>%<\/th>/);
    expectAlignedTable(data);
    expect(data).toMatch(/<td[^>]*>North a<\/td><td[^>]*>50<\/td><td[^>]*>50%<\/td>/);
  });

  test('pie variant: the model picks the layout; two slices default to the gauge, more to the donut', () => {
    const pie = (args: string, count = 3) =>
      render(
        node(
          `root = Stack([c])\nc = PieChart([${['a', 'b', 'd'].slice(0, count).join(', ')}]${args})\n` +
            ['a', 'b', 'd'].slice(0, count).map((id, i) => `${id} = Slice("S${id}", ${3 - i})`).join('\n'),
        ),
      );
    // gauge: a half ring (180 to 0 degrees); donut: the total in the center; treemap and stack draw no recharts pie.
    expect(pie(', "src"', 2)).toContain('class="relative h-[120px] w-[240px] overflow-hidden"');
    expect(pie(', "src"')).not.toContain('h-[120px] w-[240px]');
    expect(pie(', "src", null, "treemap"')).not.toContain('recharts');
    expect(pie(', "src", null, "focus"')).toContain('Sa is 50% of the total');
    expect(pie(', "src", null, "focus"')).toContain('--color-p0: var(--kortix-base)');
  });

  test('legend items: hover previews a series, a click selects it until clicked again; the rest dim', async () => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
    const chart = node('root = Stack([c])\nc = LineChart(["Mon", "Tue"], [a, b], "status page")\na = Series("NVIDIA", [1, 2])\nb = Series("AMD", [3, 4])');
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<ChartView node={chart} props={chart.props} renderChild={() => null} streaming={false} />);
    });
    const items = tree.root.findAll((n) => n.type === 'li' && n.props.role === 'button');
    expect(items).toHaveLength(2);
    expect(items[0]!.props.className).toContain('hover:bg-hover');
    expect(items[0]!.props.className).toContain('rounded-sm');
    // The figure clips: a legend pulled past its edge (a negative margin) cut the first pill off on hover.
    const list = tree.root.find((n) => n.type === 'ul' && n.findAll((c) => c.type === 'li').length === 2);
    expect(String(list.props.className)).not.toMatch(/(^|\s)-m[lx]-/);
    const opacity = () =>
      (tree.root.findByType(ChartContainer).props.children as ReactElement<{ children: ReactNode }>).props.children;
    const lines = () =>
      Children.toArray(opacity()).filter((child): child is ReactElement<{ name: string; strokeOpacity: number }> => isValidElement(child) && 'strokeOpacity' in (child.props as object));
    expect(lines().map((l) => l.props.strokeOpacity)).toEqual([1, 1]);
    await act(async () => items[0]!.props.onMouseEnter());
    expect(lines().map((l) => [l.props.name, l.props.strokeOpacity])).toEqual([['NVIDIA', 1], ['AMD', 0.15]]);
    const item = (i: number) => tree.root.findAll((n) => n.type === 'li' && n.props.role === 'button')[i]!;
    await act(async () => item(0).props.onMouseLeave());
    expect(lines().map((l) => l.props.strokeOpacity)).toEqual([1, 1]);

    // A click selects: the focus stays after the pointer leaves, and the item keeps its pill.
    await act(async () => item(0).props.onClick());
    await act(async () => item(0).props.onMouseLeave());
    expect(lines().map((l) => l.props.strokeOpacity)).toEqual([1, 0.15]);
    expect(item(0).props['aria-pressed']).toBe(true);
    expect(item(0).props.className).toContain('bg-hover text-foreground');
    // Hovering another item previews it; leaving returns to the selection.
    await act(async () => item(1).props.onMouseEnter());
    expect(lines().map((l) => l.props.strokeOpacity)).toEqual([0.15, 1]);
    await act(async () => item(1).props.onMouseLeave());
    expect(lines().map((l) => l.props.strokeOpacity)).toEqual([1, 0.15]);
    // A second click releases it.
    await act(async () => item(0).props.onClick());
    expect(lines().map((l) => l.props.strokeOpacity)).toEqual([1, 1]);
    expect(item(0).props['aria-pressed']).toBe(false);
    await act(async () => tree.unmount());
  });

  test('axis ticks use the muted foreground token, so they follow the theme', async () => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
    for (const code of [
      'root = Stack([c])\nc = BarChart(["A", "B"], [s], "survey")\ns = Series("Votes", [1, 2])',
      'root = Stack([c])\nc = LineChart(["Mon", "Tue"], [s], "status page")\ns = Series("p50", [1, 2])',
    ]) {
      const chart = node(code);
      let tree!: ReactTestRenderer;
      await act(async () => {
        tree = create(<ChartView node={chart} props={chart.props} renderChild={() => null} streaming={false} />);
      });
      // ResponsiveContainer renders nothing without a measured size: read the chart element it was given.
      const figure = tree.root.findByType(ChartContainer).props.children as ReactElement<{ children: ReactNode }>;
      const axes = Children.toArray(figure.props.children).filter(
        (child): child is ReactElement<{ tick: unknown }> => isValidElement(child) && (child.type === XAxis || child.type === YAxis),
      );
      expect(axes).toHaveLength(2);
      for (const axis of axes) expect(axis.props.tick).toEqual({ fill: 'var(--muted-foreground)' });
      await act(async () => tree.unmount());
    }
  });

  test('the pending block reserves the settled figure height, with no border, for every chart type', () => {
    const settled = render(node('root = Stack([c])\nc = BarChart(["A"], [s], "x")\ns = Series("S", [1])'));
    const figureHeight = settled.match(/<figure[^>]*class="[^"]*(min-h-\[\d+px\])/)?.[1];
    expect(figureHeight).toBe('min-h-[275px]');
    for (const type of ['BarChart', 'LineChart', 'PieChart']) {
      const pending = renderToStaticMarkup(<>{GenuiPending({ id: 'c', type, props: {}, partial: true })}</>);
      expect(pending).toContain(figureHeight!);
      expect(pending).not.toMatch(/\bborder\b/);
    }
  });

  test('a streamed pie with no resolved slices yet shows the pending block in every variant, never throws', () => {
    for (const variant of ['donut', 'ring', 'treemap', 'focus', 'gauge', 'stack']) {
      const pie: GenuiNode = { id: 'p', type: 'PieChart', props: { slices: [], variant, source: 'survey' }, partial: false };
      expect(render(pie)).toBe(renderToStaticMarkup(<>{GenuiPending(pie)}</>));
    }
  });
});
