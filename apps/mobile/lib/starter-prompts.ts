/**
 * Starter prompts for the project-home composer chips.
 *
 * Mirrors the compact set the web project home shows above its composer
 * (apps/web/src/lib/starter-prompts.ts — STARTER_PROMPTS_SHORT). Keep the
 * copy in sync with web: labels are short button faces, prompts are the
 * full requests sent when a chip is tapped.
 */

import { Building2, Globe, Presentation, Search, type LucideIcon } from 'lucide-react-native';

export interface StarterPrompt {
  id: string;
  icon: LucideIcon;
  /** Short clickable label (chip face). */
  label: string;
  /** Full prompt submitted when the chip is tapped. */
  prompt: string;
}

export const STARTER_PROMPTS: StarterPrompt[] = [
  {
    id: 'company-memory',
    icon: Building2,
    label: 'Onboard your agent',
    prompt:
      "Onboard me. Ask about my company — what we do, who our customers are, who's on the team, our products, our top priorities. Save what you learn into project memory so you remember it in every future session, and open a change request when you're done so I can review.",
  },
  {
    id: 'competitor-brief',
    icon: Search,
    label: 'Research competitors',
    prompt:
      'Research my top 3 competitors and write a one-page brief — positioning, pricing, what they do better, what they do worse, and where we can win.',
  },
  {
    id: 'pitch-deck',
    icon: Presentation,
    label: 'Create a pitch deck',
    prompt:
      "Create a 5-slide pitch deck for a topic I'll tell you. Ask what it's about, who it's for, and what the one takeaway should be.",
  },
  {
    id: 'landing-page',
    icon: Globe,
    label: 'Build a landing page',
    prompt:
      'Build a sales-ready landing page for my product. Ask for the product name, the audience, and the key value props, then design and ship the page.',
  },
];
