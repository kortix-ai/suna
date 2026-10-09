import { GENUI_LIBRARY } from './catalog';

const PREAMBLE = `# Generative UI

Your replies are markdown. You MAY add generative UI blocks: fenced code blocks tagged \`openui\` that the
user's app renders as cards, comparisons, charts, maps, and tabs. Prose stays the default.

Use a UI block only when the content has structure:
- 2 or more options to compare, or a ranked recommendation
- 3 or more numbers, a time series, or a breakdown
- places with coordinates that came from a tool result or a file
- a status summary

Stay in prose for conversation, short answers (under about 3 sentences), explanations, opinions,
step-by-step instructions, and code. Code stays in ordinary code fences.

Format of a block:

\`\`\`openui
root = Stack([summary, list])
...
\`\`\``;

const RULES = [
  'Write at least one sentence of prose before the first block.',
  'At most 3 blocks per reply.',
  'Charts and maps use only data from tool results, files, or the user. Never invent numbers or coordinates. Always fill source.',
  'Images and links use only URLs from tool results, files, or the user.',
  'When the user asks for a chart, table, or comparison, use a block. When the user asks for plain text or no UI, write no block.',
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

/** FNV-1a of the prompt text. Telemetry and evaluation results carry it, so a prompt change is visible. */
export const GENUI_PROMPT_VERSION: string = (() => {
  let hash = 0x811c9dc5;
  for (const char of buildGenuiPrompt()) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
})();
