/**
 * Generative UI debug samples, shared by the web page `/debug/genui` and the mobile debug screen
 * (`apps/mobile/app/(debug)/genui.tsx`), so both render the same blocks. All values are placeholders.
 */

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
    component: 'Image',
    title: 'Image gallery, 3 images',
    note: 'Two or more Images and nothing else in one Stack render as one gallery: a lead tile and two stacked.',
    source: `root = Stack([i1, i2, i3])
i1 = Image("https://kortix.com/banner.png", "Placeholder image 1", "Placeholder caption 1")
i2 = Image("https://kortix.com/banner.png", "Placeholder image 2", "Placeholder caption 2")
i3 = Image("https://kortix.com/banner.png", "Placeholder image 3", "Placeholder caption 3")`,
  },
  {
    component: 'Image',
    title: 'Image gallery, 6 images',
    note: 'Five or more: 2 over 3, the fifth cell shows +N and opens the rest.',
    source: `root = Stack([i1, i2, i3, i4, i5, i6])
i1 = Image("https://kortix.com/banner.png", "Placeholder image 1", "Placeholder caption 1")
i2 = Image("https://kortix.com/banner.png", "Placeholder image 2", "Placeholder caption 2")
i3 = Image("https://kortix.com/banner.png", "Placeholder image 3", "Placeholder caption 3")
i4 = Image("https://kortix.com/banner.png", "Placeholder image 4", "Placeholder caption 4")
i5 = Image("https://kortix.com/banner.png", "Placeholder image 5", "Placeholder caption 5")
i6 = Image("https://kortix.com/banner.png", "Placeholder image 6", "Placeholder caption 6")`,
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
    note: 'Positive, negative, and flat delta. A Stat outside a StatRow is the answer: set large.',
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
    component: 'PieChart',
    title: 'PieChart, focus',
    note: 'The answer is about the first slice: it takes the accent.',
    source: `root = Stack([pie])
pie = PieChart([a, b, c, d], "Placeholder cost report", "USD", "focus")
a = Slice("Compute", 4200)
b = Slice("Storage", 1800)
c = Slice("Network", 900)
d = Slice("Other", 300)`,
  },
  {
    component: 'PieChart',
    title: 'PieChart, ring',
    note: 'One share dominates and is the headline.',
    source: `root = Stack([pie])
pie = PieChart([a, b, c, d], "Placeholder cost report", "USD", "ring")
a = Slice("Compute", 4200)
b = Slice("Storage", 1800)
c = Slice("Network", 900)
d = Slice("Other", 300)`,
  },
  {
    component: 'PieChart',
    title: 'PieChart, treemap',
    note: 'Sizes matter more than the total.',
    source: `root = Stack([pie])
pie = PieChart([a, b, c, d], "Placeholder cost report", "USD", "treemap")
a = Slice("Compute", 4200)
b = Slice("Storage", 1800)
c = Slice("Network", 900)
d = Slice("Other", 300)`,
  },
  {
    component: 'PieChart',
    title: 'PieChart, stack',
    note: 'A receipt: exact values to read.',
    source: `root = Stack([pie])
pie = PieChart([a, b, c, d], "Placeholder cost report", "USD", "stack")
a = Slice("Compute", 4200)
b = Slice("Storage", 1800)
c = Slice("Network", 900)
d = Slice("Other", 300)`,
  },
  {
    component: 'PieChart',
    title: 'PieChart, 2 slices (gauge by default)',
    source: `root = Stack([pie])
pie = PieChart([used, left], "Placeholder quota export", "GB")
used = Slice("Used", 68)
left = Slice("Left", 32)`,
  },
  {
    component: 'Map',
    note: 'The mapcn map draws on OpenFreeMap by default. NEXT_PUBLIC_GENUI_MAP_STYLE_URL overrides the style; off renders only the place rows.',
    source: `root = Stack([map])
map = Map([a, b, c], "Public landmark coordinates", 14, [[52.5163, 13.3777], [52.5186, 13.3762], [52.5169, 13.4019]])
a = Marker(52.5163, 13.3777, "Brandenburg Gate", "Pariser Platz, 10117 Berlin", "★ 4.7", "https://example.com/brandenburg-gate", "https://kortix.com/icon-192.png", "+49 30 1234567", "Landmark")
b = Marker(52.5186, 13.3762, "Reichstag", null, "★ 4.6")
c = Marker(52.5169, 13.4019, "Museum Island", "End of the walk", "★ 4.8")`,
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
    component: 'Card',
    title: 'Card list (2 or more Cards)',
    note: 'A Stack of Cards and nothing else is a shortlist: photo left, title link, rating, location, description, tags.',
    source: `root = Stack([list])
list = Stack([a, b, c])
a = Card("The Taj Mahal Palace", "Iconic heritage luxury hotel overlooking the Gateway of India.", "Colaba, South Mumbai", "https://kortix.com/banner.png", "https://example.com/taj", [lux, her, sea], 4.7, 33899, "From 24,000 INR")
b = Card("The Oberoi", "Elegant, modern rooms with views of Marine Drive and the Arabian Sea.", "Nariman Point, South Mumbai", "https://kortix.com/icon-192.png", "https://example.com/oberoi", [ult, mod], 4.7, 11474)
c = Card("Taj Lands End", "Coastal location with views of the Bandra-Worli Sea Link.", "Bandra West", null, null, [lux, rom], 4.6, 36614)
lux = Badge("Luxury")
her = Badge("Heritage")
sea = Badge("Sea views")
ult = Badge("Ultra-luxury")
mod = Badge("Modern")
rom = Badge("Romantic")`,
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
    note: 'A row Stack of two column Stacks, then a full-width block. The callouts are the Callout sample\'s three tones.',
    source: `root = Stack([row, warn])
row = Stack([left, right], "row")
left = Stack([s1, info])
right = Stack([s2, ok])
s1 = Stat("Left column", "1")
info = Callout("info", "Book by Friday to keep the group rate.", "Tip")
s2 = Stat("Right column", "2")
ok = Callout("success", "All 12 checks passed on the last run.", "Done")
warn = Callout("warn", "Two of the five sources disagree on the Q3 number. The table uses the billing export.")`,
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
