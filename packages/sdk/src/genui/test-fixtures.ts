/** A valid block that uses StatRow, RankedList, and Callout. All values are placeholders. */
export const HOTEL = `root = Stack([stats, list, tip])
stats = StatRow([a, b])
a = Stat("Options checked", "24")
b = Stat("Under budget", "9", "+2", "up")
list = RankedList([h1, h2])
h1 = RankedItem("Option A", "Closest to the venue", "4.7 stars", null, "https://example.com/a")
h2 = RankedItem("Option B", "Quietest rooms")
tip = Callout("info", "Book by Friday", "Tip")`;
