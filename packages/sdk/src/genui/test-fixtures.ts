/** A valid block that uses StatRow, RankedList, and Callout. All values are placeholders. */
export const HOTEL = `root = Stack([stats, list, tip])
stats = StatRow([a, b])
a = Stat("Options checked", "24")
b = Stat("Under budget", "9", "+2", "up")
list = RankedList([h1, h2])
h1 = RankedItem("Option A", "Closest to the venue", "4.7 stars", null, "https://example.com/a")
h2 = RankedItem("Option B", "Quietest rooms")
tip = Callout("info", "Book by Friday", "Tip")`;

/** Tabs whose labels are too long, a Callout over 400 characters, and 3 valid Tables. Placeholders. */
export const BROKEN_TABS = `root = Stack([tabs])
tabs = Tabs([t1, t2])
t1 = Tab("${'L'.repeat(31)}", [note, a])
t2 = Tab("${'M'.repeat(31)}", [b, c])
note = Callout("info", "${'x'.repeat(401)}")
a = Table(["k"], [["1"]])
b = Table(["k"], [["2"]])
c = Table(["k"], [["3"]])`;
