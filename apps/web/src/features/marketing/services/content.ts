import { localizeUiCatalog } from '@/i18n/localize-ui-catalog';
import { SITE_TRANSLATION_KEYS } from '@/i18n/site-translation-keys.generated';
import type { UiTranslator } from '@/i18n/translator';

/**
 * `/services` copy — the forward deployed team.
 *
 * Plain English, no i18n keys yet: the copy is a draft for founder review.
 *
 * ── DECISIONS (founder, 2026-10-13) ──────────────────────────────────────
 *  1. The offer and its price are public: $20k per month for two people, one
 *     Deployment Strategist and one Forward Deployed Engineer. This is the one
 *     price on the site outside `/pricing`; it is an offer, not a product cost.
 *  2. The goal is autonomous operations: a company that runs 80% on agents
 *     and 20% on people. It is written as the GOAL of the engagement, never as
 *     a property of the product today. The product claim stays "a person
 *     approves" (claims.md, merge and approval rows).
 *  3. We work with low-bureaucracy, high-access companies, and say so.
 *
 * ── ACCURACY ─────────────────────────────────────────────────────────────
 *  - No engagement length, minimum term, guarantee or outcome metric: none is
 *    set. Add one only when the founder sets it.
 *  - Everything is built on Kortix and lands in a repo the customer owns.
 */

export const hero = {
  eyebrow: 'Services',
  title: 'We make your company AI-native.',
  sub: 'Two of our people join your company. They map how the work gets done, unify your data, and put agents to work on the Kortix AI Operating System. The goal is a company that runs 80% on agents and 20% on people.',
  ctaPrimary: 'Book a call',
  ctaPrimaryHref: '/contact',
  ctaSecondary: 'Customer stories',
  ctaSecondaryHref: '/customers',
} as const;

export const offer = {
  eyebrow: 'The offer',
  title: 'Two people, full time on your company.',
  price: '$20k',
  per: 'per month',
  note: 'Built on Kortix. Everything we build lives in a repo you own.',
  cta: 'Book a call',
  fullTime: { label: 'Full time' },
  roles: [
    {
      id: 'strategist',
      title: 'Deployment Strategist',
      body: 'Sits with your leaders and teams. Maps every recurring job, decides what agents take first, and redesigns the work around them.',
    },
    {
      id: 'engineer',
      title: 'Forward Deployed Engineer',
      body: 'Builds it. Connects your systems, writes the agents and skills, ships the automations and internal apps, and keeps them running.',
    },
  ],
  includes: [
    { id: 'includes-1', label: 'A map of the work: every recurring job, who does it, and in which tool' },
    { id: 'includes-2', label: 'One company knowledge base your agents read' },
    { id: 'includes-3', label: 'Your data, unified and connected' },
    { id: 'includes-4', label: 'Agents, skills and automations for your highest-value work' },
    { id: 'includes-5', label: 'Internal apps your people use every day' },
    { id: 'includes-6', label: 'Your team trained to build the next agent themselves' },
  ],
} as const;

export const how = {
  eyebrow: 'How it works',
  title: 'Restructure the company around agents.',
  sub: 'Not a pilot that ends in a slide deck. We change how the work is done, one job at a time, and the share of work agents carry goes up every month.',
  steps: [
    {
      n: '01',
      title: 'Map',
      body: 'We interview your teams and map every recurring job: who does it, which tools it touches, what a good result looks like.',
    },
    {
      n: '02',
      title: 'Unify',
      body: 'We connect your systems and build one company knowledge base, so every agent works from the same facts.',
    },
    {
      n: '03',
      title: 'Build',
      body: 'We build agents, skills, automations and internal apps for the jobs that matter most, and put them in a repo you own.',
    },
    {
      n: '04',
      title: 'Operate',
      body: 'Agents run the work. Your people review, approve and handle the exceptions. Then we take the next job.',
    },
  ],
} as const;

export const goal = {
  eyebrow: 'The goal',
  title: 'Autonomous operations.',
  sub: 'A company where agents do 80% of the work and people do the 20% that needs judgment: the decisions, the relationships, the exceptions.',
  agents: { share: 80, label: 'Agents', body: 'Research, drafting, reporting, data entry, follow-up, reconciliation' },
  people: { share: 20, label: 'People', body: 'Decisions, approvals, relationships, exceptions' },
} as const;

export const fit = {
  eyebrow: 'Who it is for',
  title: 'Low bureaucracy. High access.',
  sub: 'This works when we can move fast inside your company.',
  yes: [
    { id: 'yes-1', label: 'A leader who can say yes and wants the company to change' },
    { id: 'yes-2', label: 'Access to your people, your tools and your data' },
    { id: 'yes-3', label: 'Teams that will try a new way of working this month' },
  ],
  no: [
    { id: 'no-1', label: 'A decision that needs six committees' },
    { id: 'no-2', label: 'A pilot whose goal is a report' },
    { id: 'no-3', label: 'AI as a side project nobody owns' },
  ],
} as const;

export const faq = {
  eyebrow: 'Questions',
  title: 'Before you book.',
  items: [
    {
      id: 'own',
      title: 'What do we own at the end?',
      body: 'Everything we build: the agents, skills, automations, apps and the knowledge base live as code in a git repo you own.',
    },
    {
      id: 'cloud',
      title: 'Do we have to use Kortix Cloud?',
      body: 'No. Kortix runs on Kortix Cloud, in your VPC, or on your own on-prem network. Any model provider with your own keys.',
    },
    {
      id: 'team',
      title: 'Can our own engineers keep building?',
      body: 'Yes, that is the point. Your team works in the same repo with us and keeps building after we leave.',
    },
    {
      id: 'start',
      title: 'How do we start?',
      body: 'Book a call. We talk about how your company works and pick the first job together.',
    },
  ],
} as const;


export function getLocalizedServicesContent(tI18nComplete: UiTranslator) {
  return localizeUiCatalog(
    { hero, offer, how, goal, fit, faq },
    tI18nComplete,
    SITE_TRANSLATION_KEYS,
  );
}
