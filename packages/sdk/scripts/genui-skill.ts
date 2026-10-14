/**
 * Writes the `kortix-genui` managed system skill from the GenUI prompt.
 * Run after any prompt or catalog change: bun packages/sdk/scripts/genui-skill.ts,
 * then bun packages/starter/scripts/generate-embedded.ts.
 * `src/genui/skill.test.ts` and the starter's `embedded.test.ts` fail while either file is stale.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildGenuiPrompt } from '../src/genui/prompt';

export const GENUI_SKILL_PATH = new URL(
  '../../starter/templates/managed/skills/kortix-genui/SKILL.md',
  import.meta.url,
);

export const GENUI_SKILL_DESCRIPTION =
  'The Kortix web and mobile chat renders interactive UI blocks: cards, comparisons, stat rows, tables, ranked lists, bar, line and pie charts, maps, image galleries, tabs. Load this skill before you write a reply that would hold a markdown table, a top-N or ranked list, 3 or more options to choose from, 2 or more numbers (metrics, prices, scores, percentages, survey counts, shares, a trend), a comparison or pros and cons, a plan or itinerary with sections, or named places. Load it when the user asks to see something as cards, a chart, a graph, a table or a map: answer with a block in the reply, not with an image, a file or the show tool. Not for Slack, Teams, email or files.';

export function genuiSkillMarkdown(): string {
  return `---\nname: kortix-genui\ndescription: "${GENUI_SKILL_DESCRIPTION}"\n---\n\n${buildGenuiPrompt().trim()}\n`;
}

if (import.meta.main) {
  writeFileSync(fileURLToPath(GENUI_SKILL_PATH), genuiSkillMarkdown());
}
