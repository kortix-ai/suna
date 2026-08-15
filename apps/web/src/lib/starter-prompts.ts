/**
 * Starter prompts surfaced in the onboarding wizard's "Try your first
 * request" step and on the project home composer suggestions.
 *
 * Each entry maps to a real starter skill that ships with every new Kortix
 * project (`packages/starter/templates/general-knowledge-worker/.kortix/
 * opencode/skills/`). Keep these worded as actual user requests, not
 * feature descriptions — they're meant to be clickable and immediately
 * useful for a non-technical founder.
 *
 * The first item is the meta-onboarding prompt: it kicks off a back-and-forth
 * where the agent asks about the user's company and writes the answers into
 * `.kortix/memory/` (eventually as a change request for review).
 */

import {
  ChartBarIcon as BarChart3,
  BuildingsIcon as Building2,
  GlobeIcon as Globe,
  PresentationIcon as Presentation,
  ScalesIcon as Scale,
  MagnifyingGlassIcon as Search,
  type Icon as LucideIcon,
} from '@phosphor-icons/react';
import {
  STARTER_PROMPT_FALLBACKS,
  type StarterPromptText,
} from '@kortix/shared';

export interface StarterPrompt extends StarterPromptText {
  icon: LucideIcon;
}

/** Icon map keyed by starter prompt id. */
const ICON_MAP: Record<string, LucideIcon> = {
  'company-memory': Building2,
  'landing-page': Globe,
  'competitor-brief': Search,
  'pitch-deck': Presentation,
  'contract-draft': Scale,
  'data-analysis': BarChart3,
};

export const STARTER_PROMPTS: StarterPrompt[] = STARTER_PROMPT_FALLBACKS.map(
  (fallback) => ({
    ...fallback,
    icon: ICON_MAP[fallback.id] || Building2, // default to Building2 if not found
  })
);

/** Subset for compact surfaces (project home composer chips). */
export const STARTER_PROMPTS_SHORT: StarterPrompt[] = [
  STARTER_PROMPTS[0],
  STARTER_PROMPTS[2],
  STARTER_PROMPTS[3],
  STARTER_PROMPTS[1],
];
