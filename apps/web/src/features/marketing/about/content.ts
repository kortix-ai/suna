/**
 * `/about` copy — the founder's thesis, in his framing, cut to the bone.
 *
 * Plain English lives here, not in `apps/web/translations/*.json`, so the copy
 * can iterate before paying the 8-locale parity gate (`pnpm i18n:translations`).
 *
 * Voice rules: the `kortix-brand` skill. Long form: `MANIFESTO.md`.
 *
 * ACCURACY GATE for this page specifically:
 *  - This is a vision page, so forward-looking language is wanted. It must
 *    never read as shipped capability. TRAINING, RL and EVALS ARE NOT SHIPPED —
 *    every mention is written as direction, never as something a reader can do
 *    today. Anything in the present tense is true today.
 *  - `platform.items` carries NO status field and the page renders no status
 *    chip: the tense does the work. A row whose capability does not ship is
 *    written in the future ("the layer we are building next", "then …"), never
 *    in the present. Adding a row for something unshipped means writing it that
 *    way — do not reintroduce a status marker, and do not let a present-tense
 *    sentence describe a capability that does not exist.
 *  - Competitor names, exactly: **Claude Cowork** (one word, lowercase `w`) and
 *    **ChatGPT Work** (two words). There is no "Claude Work" and no
 *    "ChatGPT Cowork". Claim nothing about their limits or concurrency.
 *  - Never name a licence — "open source" and stop. Never claim a certification.
 *  - NEVER claim blanket "microVM isolation": true for Platinum, not for
 *    Daytona, the legacy fallback. Write "its own isolated machine".
 *  - NEVER write that a secret is "never visible to the model". A granted
 *    runtime secret is a real env value in the session. CONNECTOR credentials
 *    are the ones brokered server-side that never enter the machine.
 *  - Never claim egress is controlled at the network. Nothing implements it.
 *  - OpenCode is the agent harness. Name no other.
 *  - The GitHub star count is the only sanctioned number, read live from
 *    `/api/github-stars`. No funding, headcount, customers or other metrics.
 *  - Keep it short. Every sentence that restates the one above it comes out.
 */

export const hero = {
  // Founder vision (kortix-brand D19, D22): /about is the one page that talks
  // about SuperIntelligence, AGI and companies run by AI, always as direction
  // ("we are building", "will"), never as a shipped capability.
  title: 'We are building the Operating System for SuperIntelligence.',
  titleMuted: 'For companies run by AI, owned end to end.',
  lead: 'The infrastructure, the agent harness, the architecture and the operating system, from A to Z, so a company can run on AI at scale, get better as it operates, and stay entirely its own.',
  ctaPrimary: 'We are hiring',
  ctaPrimaryHref: '/careers',
  ctaSecondary: 'Read the code',
  ctaSecondaryHref: 'https://github.com/kortix-ai/suna',
  imageAlt: 'The Kortix team',
  starsCaption: 'stars on kortix-ai/suna',
} as const;

/**
 * The thesis in three beliefs. Future tense for what is not here yet; "AGI"
 * and "SuperIntelligence" are allowed on this page only (D19, D22).
 */
export const beliefs = {
  title: 'The thesis.',
  titleMuted: 'Where companies are going.',
} as const;

export const statements = [
  {
    id: 'run',
    title: 'Companies will run on AI.',
    body: 'The next great companies will be run by agents that work around the clock and own whole outcomes, from one customer relationship to a full function. People set the direction and the rules.',
  },
  {
    id: 'improve',
    title: 'They will improve themselves.',
    body: 'Agents that learn from the work, test improvements and share what works make a company better every day it operates. The organization becomes a system that compounds.',
  },
  {
    id: 'own',
    title: 'And they have to be owned.',
    body: 'Claude Cowork, ChatGPT Work and the rest are heading the same way, and you will never own those. A company run by AI has to own its AI: the agents, the data, the memory and the infrastructure.',
  },
] as const;

/**
 * Every layer of the stack. Present tense is true today; the last row is the
 * future, in the future tense. No status column: the tense does the work.
 */
export const platform = {
  title: 'Every layer, A to Z.',
  titleMuted: 'So you can run it at scale.',
  sub: 'We build the whole stack a company run by AI needs, and it is open source.',
  items: [
    {
      id: 'os',
      verb: 'Operating system',
      body: 'Agents, skills, connectors, triggers and memory are files in one git repo that is the company.',
    },
    {
      id: 'harness',
      verb: 'Harness',
      body: 'Every session runs an open-source agent harness on its own isolated machine. Thousands run in parallel on one config.',
    },
    {
      id: 'infrastructure',
      verb: 'Infrastructure',
      body: 'Kortix Cloud, your VPC or your own on-prem network, with any model and your own keys.',
    },
    {
      id: 'governance',
      verb: 'Governance',
      body: 'Per-resource permissions for people and agents. Secrets encrypted at rest; connector credentials brokered server-side, never entering the machine.',
    },
    {
      id: 'loop',
      verb: 'The loop',
      body: 'Agents run outcomes 24/7, land work through a change request a person approves, and propose changes to their own skills.',
    },
    {
      id: 'learn',
      verb: 'Training and evals',
      body: 'What we are building next: your own models, trained on the work your agents already did, scored by evals and reinforcement learning on your own sessions.',
    },
  ],
} as const;

/** Where it goes: self-improving companies, and the mission (positioning.md). */
export const future = {
  title: 'Self-improving companies.',
  titleMuted: 'Run by AI, owned by the people who build them.',
  body: [
    'A founder starting today can build around the customer from day one: the **AI-native bank, insurer or marketplace**, where one agent owns each relationship and the whole company learns from every interaction.',
    'An incumbent can get there one function at a time. Either way it needs the same thing underneath: **an operating system it owns, that runs at scale and improves as it runs.** That is what we are building.',
  ],
  mission:
    'Our mission: take a company from human to AGI, and let it keep every byte of itself on the way there.',
} as const;

/* "AGI platform" is a retired category name (kortix-brand D1), so the close
   is the hiring call instead of the old thesis line. */
export const closing = {
  title: 'Help us build it.',
  titleMuted: 'We are hiring in Belgrade and San Francisco.',
  ctaPrimary: 'See open positions',
  ctaPrimaryHref: '/careers',
  ctaSecondary: 'Read the code',
  ctaSecondaryHref: 'https://github.com/kortix-ai/suna',
} as const;

export function getLocalizedAboutContent(tI18nComplete: UiTranslator) {
  return localizeUiCatalog(
    { hero, beliefs, statements, platform, future, closing },
    tI18nComplete,
    MARKETING_SECONDARY_TRANSLATION_KEYS,
  );
}
import { MARKETING_SECONDARY_TRANSLATION_KEYS } from '@/i18n/marketing-secondary-translation-keys.generated';
import type { UiTranslator } from '@/i18n/translator';
import { localizeUiCatalog } from '@kortix/ui/i18n';
