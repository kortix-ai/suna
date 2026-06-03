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
  BarChart3,
  Building2,
  Globe,
  Presentation,
  Scale,
  Search,
  type LucideIcon,
} from 'lucide-react';

export interface StarterPrompt {
  id: string;
  icon: LucideIcon;
  /** Short clickable label (button face). */
  label: string;
  /** Full prompt that pre-fills the composer. */
  prompt: string;
  /** One-line value prop shown under the label in the wizard grid. */
  description: string;
}

export const STARTER_PROMPTS: StarterPrompt[] = [
  {
    id: 'company-memory',
    icon: Building2,
    label: 'Onboard your agent',
    description:
      "Ask about your company, customers, and team — saves it all to memory.",
    prompt:
      "Onboard me. Ask about my company — what we do, who our customers are, who's on the team, our products, our top priorities. Save what you learn into project memory so you remember it in every future session, and open a change request when you're done so I can review.",
  },
  {
    id: 'landing-page',
    icon: Globe,
    label: 'Build a landing page',
    description: 'A clean, sales-ready page for a product or campaign.',
    prompt:
      "Build a sales-ready landing page for my product. Ask for the product name, the audience, and the key value props, then design and ship the page.",
  },
  {
    id: 'competitor-brief',
    icon: Search,
    label: 'Research competitors',
    description: 'A one-page brief on the three companies that matter most.',
    prompt:
      'Research my top 3 competitors and write a one-page brief — positioning, pricing, what they do better, what they do worse, and where we can win.',
  },
  {
    id: 'pitch-deck',
    icon: Presentation,
    label: 'Create a pitch deck',
    description: 'A polished 5-slide deck for a meeting or update.',
    prompt:
      "Create a 5-slide pitch deck for a topic I'll tell you. Ask what it's about, who it's for, and what the one takeaway should be.",
  },
  {
    id: 'contract-draft',
    icon: Scale,
    label: 'Draft a contract',
    description: 'NDAs, MSAs, ToS — drafted with citations.',
    prompt:
      "Draft a contract for me. Ask what kind (NDA, MSA, ToS, etc.), the parties involved, and any special terms, then produce a clean DOCX with proper citations.",
  },
  {
    id: 'data-analysis',
    icon: BarChart3,
    label: 'Analyze a spreadsheet',
    description: 'Find the patterns, outliers, and surprises in your data.',
    prompt:
      "I'll share a spreadsheet — analyze it, find the patterns and outliers, and write me a short summary with the takeaways I should act on.",
  },
];
