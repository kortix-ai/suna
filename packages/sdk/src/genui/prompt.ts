import { GENUI_LIBRARY } from './catalog';

const PREAMBLE = `# Generative UI

Your replies are markdown. You MAY add generative UI blocks: fenced code blocks tagged \`openui\` that the
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

\`\`\`openui
root = Stack([summary, list])
...
\`\`\``;

const RULES = [
  'Arguments are positional only. Write Stat("Users", "900"), never Stat(label: "Users", value: "900") and never Stat("Users", "900", unit="k"). To set a later optional argument, fill every earlier one.',
  'Children of Stack, Tab, and AccordionItem are component references, never plain strings. Put text in a Callout or a Card body.',
  'Respect argument order and limits: Map(markers, source, zoom?, route?). Stat delta is at most 24 characters. Table takes exactly columns, rows, caption?.',
  'Put the closing ``` on its own line, never right after the last statement.',
  'Write at least one sentence of prose before the first block.',
  'At most 3 blocks per reply.',
  'Charts and maps use only data from tool results, files, or the user. Never invent numbers or coordinates. Always fill source.',
  "A Marker's value is a number the user asked about: the rating when they want the best places, the price when they care about cost, the population for cities. Never a category or a word (no 'Luxury'): leave it empty instead. Give each Marker its page, photo, phone, and kind when a tool result has them.",
  'To map a place you know only by name or address, look up its coordinates first: run curl -s -A "Kortix agent (https://kortix.com)" "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=<URL-encoded name and city>" (OpenStreetMap Nominatim, at most one request per second). Use lat and lon only when the result display_name names that place. If the name finds nothing, look up its street address the same way and say in the Marker description that the pin is at street level. Write the Map with source "OpenStreetMap Nominatim". If the lookup finds nothing, give a link instead of a Map.',
  'Images and links use only URLs from tool results, files, or the user.',
  'A Card for a hotel, product, or place carries its photo, rating, and price when a tool result gives them. For the photo, use the og:image of its own page: fetch the page and read <meta property="og:image">.',
  "Put an item's photo in its own Card's image argument, never in a separate Image gallery under the cards.",
  'Every Card in a list of 2 or more Cards carries an image, whatever the topic (a language, a tool, a book, a person), so fetch one before you write the block. Use the og:image of its own page, or the thumbnail.source of https://en.wikipedia.org/api/rest_v1/page/summary/<Title>. Leave a Card without an image only when neither has one.',
  'A Stack of 2 or more Cards shows as a grid of big images when the images are photos, and as a list with small thumbnails when they are logos or icons. Set its layout to choose: list when the text matters more than the picture (a ranked shortlist, logos), grid when the picture helps the choice (hotels, places, food). Example: Stack([a, b, c], "col", "list").',
  'To show 2 or more images, write a Stack of Image blocks and nothing else: the app shows them as one gallery. Put the name and the one-line note in each caption. Never put images in a RankedList or in Cards only to show them.',
  'When the user asks for a chart, table, or comparison, use a block. When the user asks for plain text or no UI, write no block.',
  'When the user asks to see an answer as cards, a list, a chart, a table, or a map, write an openui block in this reply. Do not call the show tool for it, and do not build a page or write a file, unless they ask you to build or save one.',
  'Write openui blocks only in your chat reply. Never put them in messages you send to Slack, Teams, email, or files.',
];

const EXAMPLES = [
  `Example: a ranked recommendation (all values are placeholders).

Here are the three best options under your budget.

\`\`\`openui
root = Stack([stats, list])
stats = StatRow([checked, under])
checked = Stat("Options checked", "24")
under = Stat("Under budget", "9")
list = RankedList([a, b, c])
a = RankedItem("Option A", "Closest to the venue, best reviews", "4.7 stars")
b = RankedItem("Option B", "Quietest rooms", "4.6 stars")
c = RankedItem("Option C", "Lowest price", "4.4 stars")
\`\`\``,
  `Example: a chart from a tool result (all values are placeholders).

\`\`\`openui
root = Stack([chart])
chart = BarChart(["Q1", "Q2", "Q3"], [revenue], "billing export from the tool result", "USD")
revenue = Series("Revenue", [120, 150, 170])
\`\`\``,
];

/** The system-prompt section that teaches the model the Kortix generative UI catalog. */
export function buildGenuiPrompt(): string {
  return GENUI_LIBRARY.prompt({
    preamble: PREAMBLE,
    additionalRules: RULES,
    examples: EXAMPLES,
    toolCalls: false,
    bindings: false,
  });
}

/** FNV-1a of the prompt text. Evaluation results carry it, so a prompt change is visible. The `genui_block` telemetry event does not. */
export const GENUI_PROMPT_VERSION: string = (() => {
  let hash = 0x811c9dc5;
  for (const char of buildGenuiPrompt()) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
})();
