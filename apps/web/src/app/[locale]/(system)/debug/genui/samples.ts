// eslint-disable-next-line no-restricted-imports -- a debug route chunk: it reads the catalog from the prompt text
import { buildGenuiPrompt } from '@kortix/sdk/genui';

/** One catalog component, read from the prompt the agent gets: name, positional signature, description. */
export interface GenuiCatalogEntry {
  name: string;
  signature: string;
  description: string;
}

/** Every catalog component in catalog order. The prompt lists them as `Name(args) — description`. */
export function genuiCatalog(): GenuiCatalogEntry[] {
  return buildGenuiPrompt()
    .split('\n')
    .flatMap((line) => {
      const match = /^([A-Z]\w*)(\(.*\)) — (.+)$/.exec(line);
      return match
        ? [{ name: match[1]!, signature: `${match[1]}${match[2]}`, description: match[3]! }]
        : [];
    });
}

/** Components that only appear inside a parent block. Each one shows in its parent's sample. */
export const CHILD_ONLY: Readonly<Record<string, string>> = {
  CompareItem: 'Compare',
  RankedItem: 'RankedList',
  Series: 'BarChart',
  Slice: 'PieChart',
  Marker: 'Map',
  Tab: 'Tabs',
  AccordionItem: 'Accordion',
};

export interface GenuiSample {
  /** The block this sample shows: a top-level catalog component. */
  component: string;
  /** Set on extra samples of the same component. */
  title?: string;
  note?: string;
  /** Invalid on purpose: the sample test allows issues and a missing root. */
  invalid?: boolean;
  source: string;
}

/** Mirrors `BROKEN_TABS` in packages/sdk/src/genui/test-fixtures.ts (not exported). The sample test asserts equality. */
export const BROKEN_TABS = `root = Stack([tabs])
tabs = Tabs([t1, t2])
t1 = Tab("${'L'.repeat(31)}", [note, a])
t2 = Tab("${'M'.repeat(31)}", [b, c])
note = Callout("info", "${'x'.repeat(401)}")
a = Table(["k"], [["1"]])
b = Table(["k"], [["2"]])
c = Table(["k"], [["3"]])`;

const tenItems = Array.from({ length: 10 }, (_, i) => `r${i + 1}`);

/** Gallery samples in catalog order. All values are placeholders. */
export const GENUI_SAMPLES: readonly GenuiSample[] = [
  {
    component: 'Badge',
    source: `root = Stack([row])
row = Stack([n, g, w, b], "row")
n = Badge("Neutral")
g = Badge("Healthy", "good")
w = Badge("Degraded", "warn")
b = Badge("Down", "bad")`,
  },
  {
    component: 'Link',
    source: `root = Stack([docs, long])
docs = Link("Kortix documentation", "https://kortix.com/docs")
long = Link("A longer link label that shows how the text wraps on narrow screens", "https://example.com/a/long/path")`,
  },
  {
    component: 'Image',
    source: `root = Stack([img])
img = Image("https://kortix.com/banner.png", "The Kortix banner", "The Kortix banner, loaded from kortix.com")`,
  },
  {
    component: 'Callout',
    source: `root = Stack([info, warn, ok])
info = Callout("info", "Book by Friday to keep the group rate.", "Tip")
warn = Callout("warn", "Two of the five sources disagree on the Q3 number. The table uses the billing export.")
ok = Callout("success", "All 12 checks passed on the last run.", "Done")`,
  },
  {
    component: 'Stat',
    note: 'Positive, negative, and flat delta.',
    source: `root = Stack([row])
row = Stack([up, down, flat], "row")
up = Stat("Revenue", "1.2M", "+12.4% vs last month", "up", "USD")
down = Stat("Churn", "3.1", "-0.8 pts", "down", "%")
flat = Stat("Active seats", "418", "0", "flat")`,
  },
  {
    component: 'StatRow',
    source: `root = Stack([stats])
stats = StatRow([a, b, c, d])
a = Stat("Options checked", "24")
b = Stat("Under budget", "9", "+2", "up")
c = Stat("Median price", "184", "-6%", "down", "EUR")
d = Stat("Response time", "1.4", null, null, "s")`,
  },
  {
    component: 'Table',
    source: `root = Stack([t])
t = Table(["Region", "Seats", "Active", "Spend", "Trend", "Owner"], [["EU West", 120, 104, "8,400 EUR", "up", "Platform"], ["EU North", 64, 51, "4,100 EUR", "flat", "Platform"], ["US East", 210, 188, "15,900 USD", "up", "Growth"], ["US West", 90, 62, "6,300 USD", "down", "Growth"], ["APAC", 45, 40, "3,200 USD", "up", "Sales"]], "Seats by region")`,
  },
  {
    component: 'Compare',
    source: `root = Stack([cmp])
cmp = Compare([a, b, c], ["Price", "Seats", "SSO", "Support"], "Team")
a = CompareItem("Starter", ["$0", "1", "No", "Community"], ["Free"], ["No SSO"])
b = CompareItem("Team", ["$20", "10", "Yes", "Email"], ["SSO included", "Shared projects"], ["Seat cap"])
c = CompareItem("Enterprise", ["Custom", "Unlimited", "Yes", "Dedicated"], ["Audit log", "SCIM"], ["Annual contract"])`,
  },
  {
    component: 'RankedList',
    source: `root = Stack([list])
list = RankedList([a, b, c])
a = RankedItem("Option A", "Closest to the venue, best reviews", "4.7 stars", "https://kortix.com/icon-192.png", "https://example.com/a")
b = RankedItem("Option B", "Quietest rooms", "4.6 stars")
c = RankedItem("Option C", "Lowest price, a longer reason that wraps onto a second line on a phone-width column", "4.4 stars", null, "https://example.com/c")`,
  },
  {
    component: 'RankedList',
    title: 'RankedList, 10 items',
    note: 'Ranks 1 to 10 stay on one line, right-aligned on the last digit.',
    source: [
      'root = Stack([list])',
      `list = RankedList([${tenItems.join(', ')}])`,
      ...tenItems.map(
        (id, i) =>
          `${id} = RankedItem("Option ${i + 1}", "Reason number ${i + 1}", "${(4.9 - i * 0.1).toFixed(1)} stars")`,
      ),
    ].join('\n'),
  },
  {
    component: 'BarChart',
    source: `root = Stack([chart])
chart = BarChart(["Q1", "Q2", "Q3", "Q4"], [rev, cost], "Placeholder billing export", "USD")
rev = Series("Revenue", [120, 150, 170, 210])
cost = Series("Cost", [80, 95, 110, 120])`,
  },
  {
    component: 'LineChart',
    source: `root = Stack([chart])
chart = LineChart(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], [a, b], "Placeholder usage export", "runs")
a = Series("This year", [40, 44, 52, 61, 58, 70, 75, 81, 79, 90, 96, 104])
b = Series("Last year", [30, 31, 35, 38, 41, 45, 44, 50, 53, 55, 60, 64])`,
  },
  {
    component: 'PieChart',
    source: `root = Stack([pie])
pie = PieChart([a, b, c, d], "Placeholder cost report", "USD")
a = Slice("Compute", 4200)
b = Slice("Storage", 1800)
c = Slice("Network", 900)
d = Slice("Other", 300)`,
  },
  {
    component: 'Map',
    note: 'Without NEXT_PUBLIC_GENUI_MAP_STYLE_URL the Map renders its place list. That is expected.',
    source: `root = Stack([map])
map = Map([a, b, c], "Public landmark coordinates", 14, [[52.5163, 13.3777], [52.5186, 13.3762], [52.5169, 13.4019]])
a = Marker(52.5163, 13.3777, "Brandenburg Gate", "Start here")
b = Marker(52.5186, 13.3762, "Reichstag")
c = Marker(52.5169, 13.4019, "Museum Island", "End of the walk")`,
  },
  {
    component: 'Card',
    source: `root = Stack([row])
row = Stack([a, b], "row")
a = Card("Option A", "Two minutes from the venue. Quiet rooms, late checkout on request.", "From 184 EUR a night", "https://kortix.com/banner.png", "https://example.com/a", [good, warn])
b = Card("Option B", "Plain card: no image, no link, no badges.")
good = Badge("Free cancellation", "good")
warn = Badge("2 rooms left", "warn")`,
  },
  {
    component: 'Tabs',
    source: `root = Stack([tabs])
tabs = Tabs([t1, t2, t3])
t1 = Tab("Summary", [stats])
t2 = Tab("Table", [table])
t3 = Tab("Notes", [note])
stats = StatRow([s1, s2])
s1 = Stat("Open issues", "12", "-3", "down")
s2 = Stat("Closed this week", "31", "+9", "up")
table = Table(["Issue", "State"], [["Login loop", "Fixed"], ["Slow export", "Open"]])
note = Callout("info", "Tabs switch on click. While a block streams, the first tab stays selected.")`,
  },
  {
    component: 'Accordion',
    source: `root = Stack([acc])
acc = Accordion([a, b, c])
a = AccordionItem("What changed", [c1])
b = AccordionItem("How it was checked", [c2])
c = AccordionItem("Open questions", [c3])
c1 = Callout("info", "The export now converts every block to markdown.")
c2 = Table(["Check", "Result"], [["Unit tests", "Pass"], ["Browser", "Pass"]])
c3 = Callout("warn", "Maps need a tile style URL to draw tiles.")`,
  },
  {
    component: 'Stack',
    note: 'A row Stack of two column Stacks.',
    source: `root = Stack([row])
row = Stack([left, right], "row")
left = Stack([s1, c1])
right = Stack([s2, c2])
s1 = Stat("Left column", "1")
c1 = Callout("info", "Column one.")
s2 = Stat("Right column", "2")
c2 = Callout("success", "Column two.")`,
  },
  {
    component: 'Tabs',
    title: 'Invalid block (BROKEN_TABS)',
    note: 'The SDK fixture: tab labels over 30 characters and a Callout over 400. Issues are expected.',
    invalid: true,
    source: BROKEN_TABS,
  },
];

/** The playground's starting source: several blocks in one Stack. */
export const PLAYGROUND_SOURCE = `root = Stack([stats, chart, list, tip])
stats = StatRow([a, b, c])
a = Stat("Options checked", "24")
b = Stat("Under budget", "9", "+2", "up")
c = Stat("Median price", "184", "-6%", "down", "EUR")
chart = BarChart(["Mon", "Tue", "Wed", "Thu", "Fri"], [s], "Placeholder availability feed", "rooms")
s = Series("Free rooms", [12, 9, 14, 7, 4])
list = RankedList([h1, h2, h3])
h1 = RankedItem("Option A", "Closest to the venue", "4.7 stars", null, "https://example.com/a")
h2 = RankedItem("Option B", "Quietest rooms", "4.6 stars")
h3 = RankedItem("Option C", "Lowest price", "4.4 stars")
tip = Callout("info", "Book by Friday to keep the group rate.", "Tip")`;
