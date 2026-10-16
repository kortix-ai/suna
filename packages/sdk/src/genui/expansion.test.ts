import { describe, expect, test } from 'bun:test';

import { expansionIssue } from './expansion';
import { splitGenui } from './fence';
import { parseGenui } from './parse';
import { buildGenuiPrompt } from './prompt';

const range = (n: number, map: (i: number) => string) => Array.from({ length: n }, (_, i) => map(i)).join(', ');

/** One block per UI shape of the evaluation set (.agents/skills/genui/scripts/eval-prompts.json). Placeholder values. */
const EVAL_SHAPES: Record<string, string> = {
  'compare three options': `root = Stack([cmp])
cmp = Compare([a, b, c], ["Price", "Camera", "Battery"], "Option B")
a = CompareItem("Option A", ["799", "92", "4500 mAh"], ["Sharp"], ["Pricey"])
b = CompareItem("Option B", ["699", "88", "5000 mAh"])
c = CompareItem("Option C", ["999", "95", "4300 mAh"])`,
  'ranked recommendation': `root = Stack([list, tip])
list = RankedList([a, b, c])
a = RankedItem("Place A", "On the beach, kids club", "4.8 stars")
b = RankedItem("Place B", "Pool, short walk", "4.6 stars")
c = RankedItem("Place C", "Lowest price", "4.2 stars")
tip = Callout("info", "Book early for school holidays.", "Tip")`,
  'bar chart by quarter': `root = Stack([chart])
chart = BarChart(["Q1", "Q2", "Q3", "Q4"], [rev], "billing export", "USD")
rev = Series("Revenue", [120000, 150000, 170000, 210000])`,
  'line chart trend': `root = Stack([chart])
chart = LineChart(["Jan", "Feb", "Mar", "Apr", "May", "Jun"], [s], "signups table")
s = Series("Signups", [320, 410, 390, 520, 610, 700])`,
  'pie breakdown': `root = Stack([pie])
pie = PieChart([x, y, z, o], "survey of 1000 users")
x = Slice("X", 420)
y = Slice("Y", 310)
z = Slice("Z", 180)
o = Slice("Other", 90)`,
  'places map with route': `root = Stack([m])
m = Map([p1, p2, p3], "places tool", 6, [[52.52, 13.405], [48.1351, 11.582], [50.1109, 8.6821]])
p1 = Marker(52.52, 13.405, "Office One", "Main office")
p2 = Marker(48.1351, 11.582, "Office Two")
p3 = Marker(50.1109, 8.6821, "Office Three")`,
  'kpi row and tip': `root = Stack([row, tip])
row = StatRow([u, r, c])
u = Stat("Active users", "12,400", "+6%", "up")
r = Stat("Revenue", "48k", "-2%", "down", "USD")
c = Stat("Churn", "1.9%", "0%", "flat")
tip = Callout("success", "All targets met this week.")`,
  'table with caption': `root = Stack([t])
t = Table(["Country", "Capital", "Population"], [["A", "Alpha", 1200000], ["B", "Beta", 830000], ["C", "Gamma", 410000]], "Placeholder data")`,
  'service status cards': `root = Stack([api, web], "row")
api = Card("API", "All systems normal", "Region one", null, null, [ok])
web = Card("Web", "Degraded", null, null, "https://example.com/status", [warn])
ok = Badge("Operational", "good")
warn = Badge("Degraded", "warn")`,
  'itinerary tabs': `root = Stack([tabs])
tabs = Tabs([d1, d2, d3])
d1 = Tab("Day 1", [m1])
d2 = Tab("Day 2", [m2])
d3 = Tab("Day 3", [m3])
m1 = Callout("info", "Museum in the morning, harbor walk.")
m2 = Callout("info", "Day trip to the coast.")
m3 = Callout("info", "Market and departure.")`,
  'faq accordion': `root = Stack([faq])
faq = Accordion([q1, q2])
q1 = AccordionItem("How do I reset it?", [a1])
q2 = AccordionItem("Where is the invoice?", [a2])
a1 = Callout("info", "Hold the button for 10 seconds.")
a2 = Callout("info", "Settings, then Billing.")`,
  'image and link': `root = Stack([img, more])
img = Image("https://example.com/a.png", "A placeholder chart", "Figure 1")
more = Link("Read the report", "https://example.com/report")`,
};

describe('valid blocks pass the expansion pre-scan', () => {
  test('every example in the system prompt', () => {
    const blocks = splitGenui(buildGenuiPrompt()).filter((segment) => segment.kind === 'genui');
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      if (block.kind !== 'genui' || !block.code.includes('root =')) continue;
      expect(expansionIssue(block.code)).toBeNull();
    }
  });

  for (const [shape, code] of Object.entries(EVAL_SHAPES)) {
    test(`eval shape: ${shape}`, () => {
      expect(expansionIssue(code)).toBeNull();
      const { root, issues } = parseGenui(code);
      expect(issues).toEqual([]);
      expect(root?.type).toBe('Stack');
    });
  }

  test('catalog-limit payloads: 365-point chart x 4 series, 500-point route, 50 x 8 table, in tabs', () => {
    const points = range(365, (i) => String(i));
    const code = [
      'root = Stack([tabs])',
      'tabs = Tabs([t1, t2, t3])',
      't1 = Tab("Chart", [line])',
      't2 = Tab("Map", [map])',
      't3 = Tab("Table", [table])',
      `line = LineChart([${range(365, (i) => `"d${i}"`)}], [s0, s1, s2, s3], "metrics export")`,
      ...[0, 1, 2, 3].map((i) => `s${i} = Series("Series ${i}", [${points}])`),
      `map = Map([${range(25, (i) => `m${i}`)}], "places tool", 4, [${range(500, (i) => `[${(i % 90) - 45}, ${(i % 180) - 90}]`)}])`,
      ...Array.from({ length: 25 }, (_, i) => `m${i} = Marker(${i}, ${i}, "Place ${i}")`),
      `table = Table([${range(8, (i) => `"C${i}"`)}], [${range(50, (r) => `[${range(8, (c) => String(r * 8 + c))}]`)}])`,
    ].join('\n');
    expect(code.length).toBeLessThan(64 * 1024);
    expect(expansionIssue(code)).toBeNull();
    const { root, issues } = parseGenui(code);
    expect(issues).toEqual([]);
    expect(root?.type).toBe('Stack');
  });
});
