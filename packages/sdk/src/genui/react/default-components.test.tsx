import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { defaultGenuiComponents } from './default-components';
import { GenuiBlock } from './genui-block';

const md = (markdown: string) => <pre>{markdown}</pre>;
const render = (code: string) =>
  renderToStaticMarkup(<GenuiBlock code={code} streaming={false} components={defaultGenuiComponents} renderMarkdown={md} />);

// The root holds two Stacks because one Stack takes at most 12 children.
const ALL = `root = Stack([top, bottom])
top = Stack([stats, card, table, cmp, list, bar, line])
bottom = Stack([pie, map, tabs, acc, note, img, link])
stats = StatRow([s1, s2])
s1 = Stat("Revenue", "12k", "+4%", "up", "USD")
s2 = Stat("Users", "900")
card = Card("Option A", "Close to the venue", "4.7 stars", null, "https://example.com/a", [tag])
tag = Badge("Top pick", "good")
table = Table(["Name", "Value"], [["a", 1], ["b", 2]], "Sample")
cmp = Compare([x, y], ["Price", "Rating"], "X")
x = CompareItem("X", ["$10", "4.5"], ["Cheap"], ["Small"])
y = CompareItem("Y", ["$20", "4.8"])
list = RankedList([r1])
r1 = RankedItem("First", "Best overall", "4.7 stars")
bar = BarChart(["Q1", "Q2"], [rev], "billing export", "USD")
rev = Series("Revenue", [1, 2])
line = LineChart(["Jan", "Feb"], [rev], "billing export")
pie = PieChart([p1, p2], "survey tool")
p1 = Slice("Yes", 3)
p2 = Slice("No", 1)
map = Map([m1], "places tool")
m1 = Marker(48.85, 2.35, "Center", "Main square")
tabs = Tabs([t1, t2])
t1 = Tab("One", [b1])
t2 = Tab("Two", [b2])
b1 = Badge("first")
b2 = Badge("second")
acc = Accordion([a1])
a1 = AccordionItem("Details", [b1])
note = Callout("warn", "Check the dates", "Note")
img = Image("https://example.com/i.png", "A picture", "Caption")
link = Link("Book", "https://example.com/book")`;

describe('defaultGenuiComponents', () => {
  test('renders every v1 component from one block', () => {
    const html = render(ALL);
    for (const expected of [
      'Revenue', '12k', 'Option A', 'Top pick', '<table', 'Sample', 'Cheap', 'Best overall',
      'Source: billing export', 'Source: survey tool', 'openstreetmap.org', 'role="tablist"', '<details',
      'Check the dates', 'alt="A picture"', 'href="https://example.com/book"',
    ]) {
      expect(html).toContain(expected);
    }
    expect(html).not.toContain('<pre>');
  });

  test('every block component has a default', () => {
    const names = ['Stack', 'Card', 'Stat', 'StatRow', 'Table', 'Compare', 'RankedList', 'BarChart', 'LineChart', 'PieChart', 'Map', 'Tabs', 'Accordion', 'Badge', 'Callout', 'Image', 'Link'];
    expect(Object.keys(defaultGenuiComponents).sort()).toEqual([...names].sort());
  });

  test('external links open safely', () => {
    expect(render('root = Stack([l])\nl = Link("x", "https://example.com")')).toContain('rel="noopener noreferrer"');
  });

  test('charts carry an accessible label', () => {
    expect(render('root = Stack([c])\nc = BarChart(["a"], [s], "src")\ns = Series("S", [1])')).toContain('aria-label="Bar chart: S. Source: src"');
  });
});
