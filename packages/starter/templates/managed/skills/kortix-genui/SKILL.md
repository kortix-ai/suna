---
name: kortix-genui
description: "Renders rich UI in the Kortix web and mobile chat: step rows with photos, option cards, checklists, maps, image galleries, tables, charts, stat rows, comparisons. Load it FIRST, before you answer, when the user asks for: a guide, how-to or first-time process done in the real world (a trip, a flight, a visa, a recipe, a repair, a move); a plan, route or itinerary; places, hotels or products to pick from; a ranking, comparison, or pros and cons; things to bring or prepare; a schedule; 2 or more numbers (key numbers, metrics, survey answers, shares, a trend); or to see something as cards, a chart, a graph, a table or a map (answer in the reply, not with an image, a file or the show tool). Not for chat, short facts, explaining a concept, code or terminal steps, translating, plain text, or Slack, Teams, email and files."
---

# Generative UI

The Kortix chat renders `openui` code blocks inside your markdown reply as rich UI: step rows with photos,
option cards, checklists, image galleries, maps, tables, comparisons, stat rows, and charts.

## The shape of a visual answer

1. Open with 1 or 2 sentences that answer the question or give your recommendation.
2. Then one section per part of the answer: a `##` heading (numbered when there are 3 or more), 1 to 3 short
   sentences, then the one block that shows the section. A short numbered list of exact actions may follow it.
3. End with one closing sentence or a short "## My recommendation".
   After it, ask one short question only when one missing detail would change your recommendation, about that one detail.
   Ask nothing when the answer is complete or the user asked for plain text.

One block per section, one job per block. A guide, a trip, or a how-to has 4 to 10 blocks. A short data answer
is one sentence and one block. Never put the whole answer in one block, and never put explanations inside a block.

Answer in this reply; never ask first. When a missing detail (dates, budget) changes the answer, assume the common case,
say so in one sentence, and give the whole answer. Never assume what the request already says (a weekend is both days).
Never reply with only questions, and never put questions in a Checklist.

Before you write: list the sections and pick each block. First run ONE web_search batch for the routes, times,
prices, and rules you will show; then ONE image_search for the photos, and the coordinates with bash (see Rules).

## Pick the block from the content

- a journey or route, leg by leg (home → station → airport) → Steps, one Step per leg, each with a photo
- a process the user does in the real world (check in, apply for a visa, fix a tire, cook a dish) → Steps, one Step per action
- things to bring, buy, prepare, or confirm → Checklist
- 2 to 4 options to choose between (routes, flights, transport, products) → a Stack of Cards (layout: see Rules).
  Choosing how to do something (taxi or train, which flight) is always Cards, never Compare
- the user asks for a spec-by-spec table or pros and cons of 2 to 4 named options → Compare, with the winner set when you recommend one
- a ranked "best of" list without photos → RankedList
- 2 or more named places the user goes to or picks from (stations, hotels, sights) → Map; add Cards or Steps for them only when they carry photos or facts the pins do not
- what a place or a stage looks like → a gallery: a Stack of 3 Images
- a schedule or timeline, or other rows and columns → Table
- 2 to 4 headline numbers → StatRow. One number across items → BarChart. A value over time → LineChart. Shares of a whole or survey answers → PieChart
- one warning the user must not miss → Callout
- optional detail a reader may skip → Accordion. Views the user asked to switch between → Tabs

Never put the main steps or options in an Accordion or Tabs. Never write them as "### Step 1" headings or a long
numbered list: use Steps. 4 or more real-world actions in order are Steps, not prose or a numbered list. Never write a markdown table for data.

## Stay in prose

Write no block for chat, a fact under about 3 sentences, an explanation of how something works, a one-line opinion with no options to compare,
translating or rewriting text, and code. Code and terminal commands stay in ordinary code fences, so a software
install or setup guide is prose with code fences, at any length. When the user asks for plain text, markdown, JSON, or no UI, write exactly that format and no block.

## Syntax

1. One statement per line: `name = Component(arg1, arg2, ...)`. Strings use double quotes.
2. Write `root` first. root is the one component the block shows. Use a Stack only for 2 or more components in one block.
3. Arguments are positional only: Stat("Users", "900"), never Stat(label: "Users", value: "900") and never Stat("Users", "900", unit="k"). To set a later argument, write null for each one you skip.
4. Every name except root is used by another statement. An unused name does not render.
5. Put the closing ``` on its own line, never right after the last statement.

```openui
root = Steps([a, b, c])
a = Step("Title", "What to do.")
b = Step("Title", "What to do.")
c = Step("Title", "What to do.")
```

## Components

Arguments marked with ? are optional.

Badge(label: string, tone?: "neutral" | "good" | "warn" | "bad") — Short status tag. tone: neutral, good, warn, bad
Link(label: string, href: string) — A link to a source, booking page, or document
Image(src: string, alt: string, caption?: string) — A picture. Use only URLs from tool results or files
Callout(tone: "info" | "warn" | "success", body: string, title?: string) — A key takeaway or warning. tone: info, warn, success
Stat(label: string, value: string, delta?: string, trend?: "up" | "down" | "flat", unit?: string) — One key number. trend: up, down, flat
StatRow(stats: Stat[]) — 2 to 4 Stats in a row, for the key numbers of an answer
Table(columns: string[], rows: (string | number)[][], caption?: string) — Rows a user scans or sorts. Up to 8 columns and 50 rows
CompareItem(name: string, values: string[], pros?: string[], cons?: string[]) — One option inside Compare. values line up with Compare specs
Compare(items: CompareItem[], specs?: string[], winner?: string) — Side-by-side comparison of 2 to 4 options. specs are the row labels; winner names the pick
RankedItem(title: string, reason: string, meta?: string, image?: string, href?: string) — One entry inside RankedList. Leave image empty: options with photos are Cards
RankedList(items: RankedItem[]) — A ranked recommendation, best first. Up to 10 items
Series(name: string, values: number[]) — One named series of numbers inside a chart
BarChart(categories: string[], series: Series[], source: string, unit?: string) — Amounts across up to 24 categories, up to 4 series. source names where the data came from
LineChart(x: string[], series: Series[], source: string, unit?: string) — A trend over time: x labels, up to 4 series. source names where the data came from
Slice(label: string, value: number) — One part of a PieChart
PieChart(slices: Slice[], source: string, unit?: string, variant?: "donut" | "focus" | "ring" | "treemap" | "gauge" | "stack") — Shares of a whole, 2 to 6 slices. source names where the data came from. variant picks the layout: donut: the total and every share (default). focus: the answer is about the first slice. ring: one share dominates and is the headline. treemap: 4 to 6 slices, sizes matter more than the total. gauge: 2 or 3 slices, like used against left. stack: a receipt, exact values to read
Marker(lat: number, lng: number, label: string, description?: string, value?: string, href?: string, image?: string, phone?: string, kind?: string) — One place on a Map. Coordinates only from tool results or files. description is its address or a short note. value is the short figure in its map pin: a rating, a price, a population. href is its own page, image its photo, phone its phone number, kind what it is (Hotel, Cafe, Museum)
Map(markers: Marker[], source: string, zoom?: number, route?: number[][]) — Up to 25 places, zoom 1-18, then an optional route as [lat, lng] pairs. source names where the coordinates came from
Card(title: string, body?: string, subtitle?: string, image?: string, href?: string, badges?: Badge[], rating?: number, reviews?: number, price?: string) — One item: a hotel, product, place, or person. body is plain text. subtitle is a short location or kind line. rating is 0 to 5, reviews is how many, price is a short text. 2 or more Cards in a Stack show as a grid or a list (see Stack)
Step(title: string, text?: string, image?: string, meta?: string) — One row inside Steps. title names the leg or action; text says what to do, one sentence per line; image is a photo of that place or action; meta is a time or cost
Steps(steps: Step[]) — A journey or a process in order: up to 12 rows, each with its photo, joined by a line
Checklist(title: string, items: string[]) — Things to bring, buy, prepare, or confirm: a title and up to 20 items, each under 120 characters, the reader ticks off
Tab(label: string, children: any[]) — One tab inside Tabs: a label and its blocks
Tabs(tabs: Tab[]) — 2 to 5 tabs. Use when content splits into views the user switches between
AccordionItem(title: string, children: any[]) — One collapsible section inside Accordion
Accordion(items: AccordionItem[]) — Up to 10 collapsible sections, for details a reader may skip
Stack(children: any[], direction?: "col" | "row", layout?: "list" | "grid") — Layout: 2 or more blocks in one block. children: 2 to 12 blocks. direction: col (default) or row. layout, for 2 or more Cards: grid (big images) or list (small thumbnails); empty lets the app choose from the images

## Rules

- Children of Stack, Tab, and AccordionItem are component references, never plain strings. Prose goes between blocks, never inside a Callout or a Card.
- Respect argument order and limits: Map(markers, source, zoom?, route?). Step(title, text?, image?, meta?). Checklist(title, items). Stat delta and Badge label are at most 24 characters. Checklist items and Table caption are at most 120 characters. Table takes exactly columns, rows, caption?.
- Write at least one sentence of prose before the first block and between two blocks, except when the second block continues the first. The prose never repeats the block.
- Show the same data once: never a chart and a table, or two charts, of the same numbers.
- Images, links, numbers, prices, times, and coordinates come only from tool results, files, or the user. Never invent them. Charts and maps always fill source with the origin in 2 to 5 words (web_search, the billing export), never "provided" or "supplied". Mention a fact the tool results lack only when the user must act on it, once, as an instruction. A schedule you make up as an illustration says so in its caption.
- Get every photo for the reply in ONE image_search call before you write: one query per Step, Card, and gallery Image, joined with |||, and num_results 3. For each item, use the first fitting result of its own query. A Step photo may show the kind of place or action (a check-in hall). Without image_search, use a web_search result image whose description matches. Never fetch pages for images. Never use one photo for two items: leave the image empty rather than use a wrong one.
- Every Step and every Card in a list carries its photo, in the item's own image argument, never in a separate gallery under the items.
- In an option Card, subtitle is the route, kind, or travel time line (City A → Hub City → City B, 60 to 90 min), price the cost, body 1 or 2 sentences, href its official or booking page, and Badge("My first choice", "good") marks your pick among 2 or more options: a single item, a day plan, or a schedule has no pick badge. A hotel, product, or place Card also carries its rating and reviews from a tool result. Leave price empty when no tool result gives it. A score out of 10 goes in subtitle with its review count (Old Town · Booking 9.3/10, 2,345 reviews), never halved and never a Badge; then leave rating and reviews empty.
- Set a Stack of Cards to list when the text matters more than the picture (routes, flights, a shortlist, logos), and to grid when the picture is the choice (hotels, places, food): Stack([a, b], "col", "list").
- A Step title is under 60 characters: the leg (Home → Central Station) or the action (Check in your bag). Its text is 1 to 3 short sentences, each on its own line with \n. meta is a short time or cost (about 35 min, 5 USD), never an instruction. A fare or timetable time needs a tool result; a cooking or task time may come from know-how.
- Steps holds 3 to 8 Steps, one leg or action each. Never pack several legs or actions into one Step. A single action is a sentence of prose, not Steps. A trip guide opens with a Steps of every leg, door to arrival, one short line per leg; the actions inside a leg go only in that leg's own section. A trip guide also maps the airports and stations it names.
- Checklist items are short things the reader ticks off (Valid passport), each under 80 characters, 3 to 15 of them. Next steps, recommendations, swaps, tips, and questions stay prose or a short numbered list of at most 5 items, one sentence each, never a Checklist, RankedList, Callout, or Cards.
- A gallery is a Stack of Images and nothing else; 3 read best, as one row. Put the name and a one-line note in each caption. Never put images in a RankedList or in Cards only to show them.
- A Marker's value is the number the user asked about (a rating, a price, a population), never a word (no 'Luxury'): otherwise leave it empty. Give each Marker its page, photo, phone, and kind when a tool result has them.
- To map places you know only by name or address, look them all up in ONE bash call, one request per second: printf "%s\n" "Place One, City" "Place Two, City" | tr "\n" "\0" | xargs -0 -I{} sh -c 'curl -sG -A "Kortix agent (https://kortix.com)" https://nominatim.openstreetmap.org/search -d format=jsonv2 -d limit=1 --data-urlencode "q={}"; echo; sleep 1'. Keep a place only when its display_name names it; otherwise look it up once more, in a second bash call, with its street address from your web_search results, and keep that result when its display_name has the same street and house number. Write the Map with source "OpenStreetMap Nominatim". If fewer than 2 places are found, give links instead of a Map.
- When the user asks to see an answer as cards, a list, a chart, a table, or a map, write the block in this reply. Do not call the show tool, build a page, or write a file unless they ask you to build or save one.
- Write openui blocks only in your chat reply. Never put them in messages you send to Slack, Teams, email, or files.

## Examples

Example: a first-time travel guide. Every name, number, and URL is a placeholder: real ones come from your tool results.

After one web_search batch for the facts and one bash call for the coordinates, one call for every photo:
image_search(query: "Airport One Terminal 2 ||| plane takeoff runway ||| Hub Airport transfer area ||| Airport Two arrivals ||| City A taxi rank ||| City A train platform ||| Carrier One aircraft ||| Carrier Two aircraft ||| airport check-in ||| airport security ||| airport gate ||| Airport Two passport control ||| Airport Two baggage claim ||| Airport Two taxi stand", num_results: 3)

Then the reply:

Since this is your first flight, here is the whole trip from your door in City A to City B, with one connection at Hub City.

## 1. Your journey at a glance

Here is every leg, door to arrival.

```openui
root = Steps([s1, s2, s3, s4])
s1 = Step("Home → Airport One", "Take a taxi to Terminal 2.", "https://example.com/photos/terminal-two.jpg", "60 to 90 min")
s2 = Step("Airport One → Hub Airport", "Your first flight, on Carrier One.", "https://example.com/photos/takeoff.jpg")
s3 = Step("Hub Airport", "Change planes inside the international transfer area.", "https://example.com/photos/hub-transfer.jpg")
s4 = Step("Airport Two", "Land in City B.", "https://example.com/photos/arrivals.jpg")
```

## 2. How to reach Airport One

Airport One is 25 km east of Central Station.

```openui
root = Map([m1, m2], "OpenStreetMap Nominatim", 11)
m1 = Marker(10.01, 20.01, "Central Station", "Main entrance")
m2 = Marker(10.05, 20.24, "Airport One", "Terminal 2")
```

You have two good choices. With two suitcases, take the taxi.

```openui
root = Stack([taxi, train], "col", "list")
taxi = Card("Option A: taxi", "No changes and easiest with big bags. Book it the evening before.", "Home → Terminal 2, 60 to 90 min", "https://example.com/photos/taxi.jpg", null, [pick], null, null, "about 40 USD")
pick = Badge("Best for a first flight", "good")
train = Card("Option B: train", "Cheaper, but you carry your bags through Central Station.", "Central Station → Terminal 2, 70 to 100 min", "https://example.com/photos/train-platform.jpg", null, null, null, null, "about 5 USD")
```

## 3. Which flight to book

Book both flights on one ticket, with a 2 to 4 hour connection, so your bag goes straight through.

```openui
root = Stack([one, two], "col", "list")
one = Card("Carrier One", "One ticket and one short connection.", "City A → Hub City → City B", "https://example.com/photos/carrier-one.jpg", "https://example.com/carrier-one", [first])
first = Badge("My first choice", "good")
two = Card("Carrier Two", "A good alternative through Other Hub.", "City A → Other Hub → City B", "https://example.com/photos/carrier-two.jpg", "https://example.com/carrier-two")
```

## 4. Inside Airport One

Arrive 3 hours before departure. This is the order you go through.

```openui
root = Steps([c1, c2, c3])
c1 = Step("Check in your bag", "Find your airline's counter on the screens.\nShow your passport and booking.", "https://example.com/photos/check-in.jpg")
c2 = Step("Immigration and security", "Show your passport and visa.\nPut your laptop and liquids in the trays.", "https://example.com/photos/security.jpg", "about 30 min")
c3 = Step("Find your gate", "Your boarding pass shows the gate.\nCheck the screens: gates can change.", "https://example.com/photos/gate.jpg")
```

## 5. After you land in City B

Arrivals has three stops before the exit.

```openui
root = Stack([p1, p2, p3])
p1 = Image("https://example.com/photos/passport-control.jpg", "Passport control hall", "Passport control: have your visa ready")
p2 = Image("https://example.com/photos/baggage-claim.jpg", "Baggage claim belts", "Baggage claim: find your flight on the screen")
p3 = Image("https://example.com/photos/taxi-stand.jpg", "Official taxi stand", "Official taxis wait outside Arrivals")
```

1. Follow the signs to passport control.
2. Collect your bag and walk through customs.
3. Take an official taxi or the airport bus to the centre.

## 6. What to pack

Keep these in your cabin bag.

```openui
root = Checklist("Your travel checklist", ["Valid passport", "Visa or entry permit", "Flight booking and boarding passes", "Hotel address in City B", "Bank card and some cash", "Phone, charger, and power bank in your cabin bag"])
```

## 7. Departure day

For a 07:00 flight, plan the morning like this:

```openui
root = Table(["Time", "What to do"], [["03:00", "Leave home by taxi"], ["04:00", "Reach Airport One, Terminal 2"], ["04:00 to 06:00", "Check in, immigration, and security"], ["07:00", "Departure"]], "Example times, not your booking")
```

My pick for a first trip: the taxi to Airport One, and Carrier One on one ticket through Hub City.

Example: a short data answer (placeholders).

Revenue grew every quarter, by 50 USD in total.

```openui
root = BarChart(["Q1", "Q2", "Q3"], [revenue], "billing export from the tool result", "USD")
revenue = Series("Revenue", [120, 150, 170])
```
