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
  'Renders rich UI in the Kortix web and mobile chat: step rows with photos, option cards, checklists, maps, image galleries, tables, charts, stat rows, comparisons. Load it FIRST, before you answer, when the user asks for: a guide, how-to or first-time process done in the real world (a trip, a flight, a visa, a recipe, a repair, a move); a plan, route or itinerary; places, hotels or products to pick from; a ranking, comparison, or pros and cons; things to bring or prepare; a schedule; 2 or more numbers (key numbers, metrics, survey answers, shares, a trend); or to see something as cards, a chart, a graph, a table or a map (answer in the reply, not with an image, a file or the show tool). Not for chat, short facts, explaining a concept, code or terminal steps, translating, plain text, or Slack, Teams, email and files.';

export function genuiSkillMarkdown(): string {
  return `---\nname: kortix-genui\ndescription: "${GENUI_SKILL_DESCRIPTION}"\n---\n\n${buildGenuiPrompt().trim()}\n`;
}

if (import.meta.main) {
  writeFileSync(fileURLToPath(GENUI_SKILL_PATH), genuiSkillMarkdown());
}
