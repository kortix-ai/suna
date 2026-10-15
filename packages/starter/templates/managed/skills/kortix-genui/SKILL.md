---
name: kortix-genui
description: "The Kortix web and mobile chat renders interactive UI blocks: cards, comparisons, stat rows, tables, ranked lists, bar, line and pie charts, maps, image galleries, tabs. Load this skill before you write a reply that would hold a markdown table, a top-N or ranked list, 3 or more options to choose from, 2 or more numbers (metrics, prices, scores, percentages, survey counts, shares, a trend), a comparison or pros and cons, a plan or itinerary with sections, or named places. Load it when the user asks to see something as cards, a chart, a graph, a table or a map: answer with a block in the reply, not with an image, a file or the show tool. Not for Slack, Teams, email or files."
---

# Generative UI

Your replies are markdown. You MAY add generative UI blocks: fenced code blocks tagged `openui` that the
user's app renders as cards, comparisons, charts, maps, and tabs.

Use a UI block whenever the content has structure. Pick the block from the content:
- 2 to 4 headline numbers → a StatRow of Stats (lead with it when the answer is about numbers)
- a ranked or "best of" list → RankedList
- 2 to 4 options to choose between → Compare, with the winner set when you recommend one
- one number across several items → BarChart
- a value over time → LineChart, with a StatRow of the latest value and the change above it
- shares of a whole → PieChart (a budget, a market split)
- a plan, an itinerary, or steps with sections → Accordion or Tabs
- named places → Map
- a status summary or one key takeaway → Callout
- other rows and columns of data → Table

Never write a markdown table for data: use one of the blocks above.

Stay in prose for conversation, short answers (under about 3 sentences), explanations, opinions,
step-by-step instructions, and code. Code stays in ordinary code fences.

Format of a block:

```openui
root = Stack([summary, list])
...
```

## Syntax Rules

1. Each statement is on its own line: `identifier = Expression`
2. `root` is the entry point — every program must define `root = Stack(...)`
3. Expressions are: strings ("..."), numbers, booleans (true/false), null, arrays ([...]), objects ({...}), or component calls TypeName(arg1, arg2, ...)
4. Use references for readability: define `name = ...` on one line, then use `name` later
5. EVERY variable (except root) MUST be referenced by at least one other variable. Unreferenced variables are silently dropped and will NOT render. Always include defined variables in their parent's children/items array.
6. Arguments are POSITIONAL (order matters, not names). Write `SomeComp([children], "row", "l")` NOT `SomeComp([children], direction: "row", gap: "l")` — colon syntax is NOT supported and silently breaks
7. Optional arguments can be omitted from the end
- Strings use double quotes with backslash escaping

## Component Signatures

Arguments marked with ? are optional. Sub-components can be inline or referenced; prefer references for better streaming.

Badge(label: string, tone?: "neutral" | "good" | "warn" | "bad") — Short status tag. tone: neutral, good, warn, bad
Link(label: string, href: string) — A link to a source, booking page, or document
Image(src: string, alt: string, caption?: string) — A picture. Use only URLs from tool results or files
Callout(tone: "info" | "warn" | "success", body: string, title?: string) — A key takeaway or warning. tone: info, warn, success
Stat(label: string, value: string, delta?: string, trend?: "up" | "down" | "flat", unit?: string) — One key number. trend: up, down, flat
StatRow(stats: Stat[]) — 2 to 4 Stats in a row, for the key numbers of an answer
Table(columns: string[], rows: (string | number)[][], caption?: string) — Rows a user scans or sorts. Up to 8 columns and 50 rows
CompareItem(name: string, values: string[], pros?: string[], cons?: string[]) — One option inside Compare. values line up with Compare specs
Compare(items: CompareItem[], specs?: string[], winner?: string) — Side-by-side comparison of 2 to 4 options. specs are the row labels; winner names the pick
RankedItem(title: string, reason: string, meta?: string, image?: string, href?: string) — One entry inside RankedList
RankedList(items: RankedItem[]) — A ranked recommendation, best first. Up to 10 items
Series(name: string, values: number[]) — One named series of numbers inside a chart
BarChart(categories: string[], series: Series[], source: string, unit?: string) — Amounts across up to 24 categories, up to 4 series. source names where the data came from
LineChart(x: string[], series: Series[], source: string, unit?: string) — A trend over time: x labels, up to 4 series. source names where the data came from
Slice(label: string, value: number) — One part of a PieChart
PieChart(slices: Slice[], source: string, unit?: string, variant?: "donut" | "focus" | "ring" | "treemap" | "gauge" | "stack") — Shares of a whole, 2 to 6 slices. source names where the data came from. variant picks the layout: donut: the total and every share (default). focus: the answer is about the first slice. ring: one share dominates and is the headline. treemap: 4 to 6 slices, sizes matter more than the total. gauge: 2 or 3 slices, like used against left. stack: a receipt, exact values to read
Marker(lat: number, lng: number, label: string, description?: string, value?: string, href?: string, image?: string, phone?: string, kind?: string) — One place on a Map. Coordinates only from tool results or files. description is its address or a short note. value is the short figure in its map pin: a rating, a price, a population. href is its own page, image its photo, phone its phone number, kind what it is (Hotel, Cafe, Museum)
Map(markers: Marker[], source: string, zoom?: number, route?: number[][]) — Up to 25 places, zoom 1-18, then an optional route as [lat, lng] pairs. source names where the coordinates came from
Card(title: string, body?: string, subtitle?: string, image?: string, href?: string, badges?: Badge[], rating?: number, reviews?: number, price?: string) — One item: a hotel, product, place, or person. body is plain text. subtitle is a short location or kind line. rating is 0 to 5, reviews is how many, price is a short text. 2 or more Cards in a Stack show as a grid or a list (see Stack)
Tab(label: string, children: any[]) — One tab inside Tabs: a label and its blocks
Tabs(tabs: Tab[]) — 2 to 5 tabs. Use when content splits into views the user switches between
AccordionItem(title: string, children: any[]) — One collapsible section inside Accordion
Accordion(items: AccordionItem[]) — Up to 10 collapsible sections, for details a reader may skip
Stack(children: any[], direction?: "col" | "row", layout?: "list" | "grid") — Layout. root is always a Stack. children: 1 to 12 blocks. direction: col (default) or row. layout, for 2 or more Cards: grid (big images) or list (small thumbnails); empty lets the app choose from the images

## Hoisting & Streaming (CRITICAL)

openui-lang supports hoisting: a reference can be used BEFORE it is defined. The parser resolves all references after the full input is parsed.

During streaming, the output is re-parsed on every chunk. Undefined references are temporarily unresolved and appear once their definitions stream in. This creates a progressive top-down reveal — structure first, then data fills in.

**Recommended statement order for optimal streaming:**
1. `root = Stack(...)` — UI shell appears immediately
2. Component definitions — fill in as they stream
3. Data values — leaf content last

Always write the root = Stack(...) statement first so the UI shell appears immediately, even before child data has streamed in.

## Examples

Example: a ranked recommendation (all values are placeholders).

Here are the three best options under your budget.

```openui
root = Stack([stats, list])
stats = StatRow([checked, under])
checked = Stat("Options checked", "24")
under = Stat("Under budget", "9")
list = RankedList([a, b, c])
a = RankedItem("Option A", "Closest to the venue, best reviews", "4.7 stars")
b = RankedItem("Option B", "Quietest rooms", "4.6 stars")
c = RankedItem("Option C", "Lowest price", "4.4 stars")
```

Example: a chart from a tool result (all values are placeholders).

```openui
root = Stack([chart])
chart = BarChart(["Q1", "Q2", "Q3"], [revenue], "billing export from the tool result", "USD")
revenue = Series("Revenue", [120, 150, 170])
```

## Important Rules
- Choose components that best represent the content (tables for comparisons, charts for trends, forms for input, etc.)

## Final Verification
Before finishing, walk your output and verify:
1. root = Stack(...) is the FIRST line (for optimal streaming).
2. Every referenced name is defined. Every defined name (other than root) is reachable from root.

- Arguments are positional only. Write Stat("Users", "900"), never Stat(label: "Users", value: "900") and never Stat("Users", "900", unit="k"). To set a later optional argument, fill every earlier one.
- Children of Stack, Tab, and AccordionItem are component references, never plain strings. Put text in a Callout or a Card body.
- Respect argument order and limits: Map(markers, source, zoom?, route?). Stat delta is at most 24 characters. Table takes exactly columns, rows, caption?.
- Put the closing ``` on its own line, never right after the last statement.
- Write at least one sentence of prose before the first block.
- At most 3 blocks per reply.
- Charts and maps use only data from tool results, files, or the user. Never invent numbers or coordinates. Always fill source.
- A Marker's value is a number the user asked about: the rating when they want the best places, the price when they care about cost, the population for cities. Never a category or a word (no 'Luxury'): leave it empty instead. Give each Marker its page, photo, phone, and kind when a tool result has them.
- To map a place you know only by name or address, look up its coordinates first: run curl -s -A "Kortix agent (https://kortix.com)" "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=<URL-encoded name and city>" (OpenStreetMap Nominatim, at most one request per second). Use lat and lon only when the result display_name names that place. If the name finds nothing, look up its street address the same way and say in the Marker description that the pin is at street level. Write the Map with source "OpenStreetMap Nominatim". If the lookup finds nothing, give a link instead of a Map.
- Images and links use only URLs from tool results, files, or the user.
- A Card for a hotel, product, or place carries its photo, rating, and price when a tool result gives them. For the photo, use the og:image of its own page: fetch the page and read <meta property="og:image">.
- Put an item's photo in its own Card's image argument, never in a separate Image gallery under the cards.
- Every Card in a list of 2 or more Cards carries an image, whatever the topic (a language, a tool, a book, a person), so fetch one before you write the block. Use the og:image of its own page, or the thumbnail.source of https://en.wikipedia.org/api/rest_v1/page/summary/<Title>. Leave a Card without an image only when neither has one.
- A Stack of 2 or more Cards shows as a grid of big images when the images are photos, and as a list with small thumbnails when they are logos or icons. Set its layout to choose: list when the text matters more than the picture (a ranked shortlist, logos), grid when the picture helps the choice (hotels, places, food). Example: Stack([a, b, c], "col", "list").
- To show 2 or more images, write a Stack of Image blocks and nothing else: the app shows them as one gallery. Put the name and the one-line note in each caption. Never put images in a RankedList or in Cards only to show them.
- When the user asks for a chart, table, or comparison, use a block. When the user asks for plain text or no UI, write no block.
- When the user asks to see an answer as cards, a list, a chart, a table, or a map, write an openui block in this reply. Do not call the show tool for it, and do not build a page or write a file, unless they ask you to build or save one.
- Write openui blocks only in your chat reply. Never put them in messages you send to Slack, Teams, email, or files.
