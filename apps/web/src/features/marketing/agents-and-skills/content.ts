import { AGENTS_LANDING_TRANSLATION_KEYS } from '@/i18n/agents-landing-translation-keys.generated';
import { localizeUiCatalog } from '@/i18n/localize-ui-catalog';
import type { UiTranslator } from '@/i18n/translator';

/**
 * The repo tree on `/product#agents`: what a new project's repo holds.
 *
 * ACCURACY: the agents listed are the ones the starter template ships
 * (`packages/starter/templates/base/agents/`). An agent is `agents/<name>.md`
 * plus its governance block in `kortix.yaml`; a skill is a directory with a
 * `SKILL.md`. Re-check the template before editing a path.
 */

export const repo = {
  tree: [
    { path: 'your-company/', note: '', depth: 0 },
    { path: 'kortix.yaml', note: 'governance: what each agent may touch', depth: 1 },
    { path: 'agents/', note: 'one OpenCode agent per file', depth: 1 },
    { path: 'kortix.md', note: 'the generalist, in every project', depth: 2 },
    { path: 'harness-reflector.md', note: 'improves the agents and memory on a cron', depth: 2 },
    { path: 'session-reviewer.md', note: 'reviews one session for the reflector', depth: 2 },
    { path: 'skills/', note: 'one directory per skill', depth: 1 },
    { path: 'agent-browser/SKILL.md', note: 'how this company drives a browser', depth: 2 },
    { path: 'harnesses/opencode/', note: 'the runtime your agents think in', depth: 1 },
  ],
} as const;

export function getLocalizedAgentsAndSkillsContent(tI18nComplete: UiTranslator) {
  return localizeUiCatalog({ repo }, tI18nComplete, AGENTS_LANDING_TRANSLATION_KEYS);
}
