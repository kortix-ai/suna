/**
 * `/careers` copy. The page is a job board, not an essay: the openings, the
 * bar, and how to apply. Nothing else belongs here — the thesis lives on
 * `/about`.
 *
 * Plain English lives here, not in `apps/web/translations/*.json`, so the copy
 * can iterate before paying the 8-locale parity gate (`pnpm i18n:translations`).
 *
 * Voice rules: the `kortix-brand` skill. The bar is distilled from `CLAUDE.md`.
 *
 * ACCURACY GATE for this page specifically:
 *  - INVENT NOTHING about employment. No salary band, no equity, no benefits,
 *    no headcount, no remote policy. The only two locations are **Belgrade,
 *    Serbia** and **San Francisco**; every opening is open in both, and no
 *    third location may be added.
 *  - The two openings (FDE and GTM, 2026-10-28) are the founder's own list. Every bullet under them
 *    comes from him. Keep them short — a spec belongs in a conversation.
 *  - Applications go through `ApplyModal`, which posts to the same
 *    `/api/demo-request` pipeline as "Book your demo". There is no ATS and no
 *    jobs@ alias — do not invent one. The three direct links (email, X,
 *    LinkedIn) are the ones this page already carried.
 *  - There is NO file upload on that pipeline (JSON in, one blob into
 *    `contact_forms`). Ask for a LINK to a CV or portfolio. Never promise an
 *    attachment.
 *  - Competitor names, exactly: **Claude Cowork** (one word, lowercase `w`) and
 *    **ChatGPT Work** (two words).
 *  - Never name a licence — "open source" and stop. Never claim a certification.
 *  - No culture-page filler. If a sentence restates the one above it, cut it.
 */

/** The only two locations. Every opening is open in both. */
export const LOCATIONS = 'Belgrade · San Francisco' as const;

export const hero = {
  title: 'Open positions.',
  lead: 'Belgrade, Serbia and San Francisco.',
  description: 'An extremely small, talent-dense team. Every opening is open in both cities.',
  roleLabel: 'Role',
  summaryLabel: 'Summary',
  ctaPrimary: 'Apply',
  ctaSecondary: 'Why Kortix exists',
  ctaSecondaryHref: '/about',
} as const;

/** The board. Collapsed shows name, locations and the summary line. */
export const openings = [
  {
    id: 'fde',
    name: 'FDE / Services',
    summary: 'Build customers their first agents, and own the services side end to end.',
    bullets: [
      'Onboard customers, teach them, build their first agents, and create their connections.',
      'Own services end to end, and build the engineering team behind it.',
      'Ran a software, automation or delivery agency at owner level.',
      'Sold and delivered custom software. Can state deal sizes, close rate and delivery margin.',
      'Technical enough to build the automations yourself on day one.',
      'Writes the SOPs that make the motion repeatable.',
      'Runs the full cycle: discovery, scope, build, handoff, expansion.',
      'Can recruit.',
    ],
  },
  {
    id: 'gtm',
    name: 'GTM',
    summary:
      'Make Kortix the instant answer to "what is the open-source Claude Cowork or ChatGPT Work?", then convert every lead it brings in.',
    bullets: [
      'Convert every inbound lead, and build outbound from nothing.',
      'Sell to companies: the platform, and the FDE and services engagement alongside it.',
      'Build the content baseline, and the system that keeps producing it.',
      'Daily platform and feature explainers, high-quality video and motion.',
      'Use-case and marketplace-driven content.',
      'Influencer and UGC motion on X and LinkedIn.',
      'Crank out content the way we crank out commits.',
    ],
  },
] as const;

export const bar = {
  title: 'What we look for.',
  titleMuted: 'Ownership, agency and skill.',
  lead: 'An extremely small, talent-dense team. Everyone can AGI-max now, so the one chokepoint left is judgement. Either you are performing or you are not.',
  items: [
    {
      id: 'prolonged',
      title: 'Prolonged ownership',
      body: 'You owned something for a long stretch. Whether it worked out matters less than the stretch.',
    },
    {
      id: 'room',
      title: 'The room test',
      body: 'I hand you something at a high level, walk out, come back, and find it done well. Ideally better than I would have done it.',
    },
    {
      id: 'end-to-end',
      title: 'End to end',
      body: 'From "we have a problem" to "nobody has to think about this again". If someone still has to track it, you did not own it.',
    },
    {
      id: 'not-done',
      title: 'It is not done if',
      body: 'it is not implemented, the implementation is ugly, it is not documented, nobody can discover it, or you cannot market it.',
    },
    {
      id: 'problem-first',
      title: 'Problem first',
      body: '"Move from X to Y" is a solution you pre-committed to. Slow, flaky, breaks for this one customer — those are problems.',
    },
    {
      id: 'prove',
      title: 'Prove it',
      body: 'Not "the tests pass". Prove it, then confirm it is live in production, which is not the same as merged.',
    },
    {
      id: 'no-net',
      title: 'No PMs, no QA',
      body: 'Ask for help, ask questions, redo things. Never quietly assume someone else will catch the part you skipped.',
    },
  ],
} as const;

export const apply = {
  title: 'Tell me what you have worked on.',
  titleMuted: 'I read every application.',
  body: 'One open question, no form to game. Products, campaigns, companies, things you built for yourself — whatever you want me to know. It comes straight to me. I am Marko.',
  cta: 'Apply',
  directLead: 'Or write to me directly:',
  links: [
    { id: 'email', label: 'marko@kortix.com', href: 'mailto:marko@kortix.com', external: false },
    { id: 'x', label: '@markokraemer', href: 'https://x.com/markokraemer', external: true },
    {
      id: 'linkedin',
      label: 'linkedin.com/in/markokraemer',
      href: 'https://linkedin.com/in/markokraemer',
      external: true,
    },
  ],
} as const;

/** Copy for `ApplyModal`. Short, and one open question carries the weight. */
export const applyForm = {
  title: 'Apply to Kortix',
  description: 'Short. One open question does the work.',
  areaLabel: 'Which opening',
  areaPlaceholder: 'Pick the closest one',
  areaOptions: [
    'FDE / Services',
    'GTM',
    'Not sure — read it and tell me',
  ],
  nameLabel: 'Name',
  namePlaceholder: 'Your name',
  emailLabel: 'Email',
  emailPlaceholder: 'you@wherever.com',
  ownedLabel: 'What have you worked on?',
  ownedPlaceholder:
    'Products, campaigns, companies, things you built for yourself. Whatever you want to tell me.',
  linkLabel: 'Link to a CV, portfolio, GitHub or profile',
  /* No attachment: the lead pipeline takes JSON only. Ask for a link. */
  linkPlaceholder: 'https://',
  submit: 'Send application',
  submitting: 'Sending',
  doneTitle: 'Application received.',
  doneBody: 'It lands in the inbox I read every day. If it is a fit, you hear from me directly.',
  doneCta: 'Done',
  errors: {
    email: 'Enter an email address I can reply to.',
    owned: 'Tell me what you have worked on.',
    area: 'Pick the closest opening.',
  },
} as const;

export function getLocalizedCareersContent(tI18nComplete: UiTranslator) {
  return localizeUiCatalog(
    { LOCATIONS, hero, openings, bar, apply, applyForm },
    tI18nComplete,
    MARKETING_SECONDARY_TRANSLATION_KEYS,
  );
}
import { localizeUiCatalog } from '@kortix/ui/i18n';
import { MARKETING_SECONDARY_TRANSLATION_KEYS } from '@/i18n/marketing-secondary-translation-keys.generated';
import type { UiTranslator } from '@/i18n/translator';
