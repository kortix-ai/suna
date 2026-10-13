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
  roles: [
    {
      id: 'strategist',
      role: 'Deployment Strategist',
      body: 'Sits with your leaders and teams. Maps every recurring job, decides what agents take first, and redesigns the work around them.',
    },
    {
      id: 'engineer',
      role: 'Forward Deployed Engineer',
      body: 'Builds it. Connects your systems, writes the agents and skills, ships the automations and internal apps, and keeps them running.',
    },
  ],
  includes: [
    'A map of the work: every recurring job, who does it, and in which tool',
    'One company knowledge base your agents read',
    'Your data, unified and connected',
    'Agents, skills and automations for your highest-value work',
    'Internal apps your people use every day',
    'Your team trained to build the next agent themselves',
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
    'A leader who can say yes and wants the company to change',
    'Access to your people, your tools and your data',
    'Teams that will try a new way of working this month',
  ],
  no: [
    'A decision that needs six committees',
    'A pilot whose goal is a report',
    'AI as a side project nobody owns',
  ],
} as const;

export const faq = {
  eyebrow: 'Questions',
  title: 'Before you book.',
  items: [
    {
      id: 'own',
      q: 'What do we own at the end?',
      a: 'Everything we build: the agents, skills, automations, apps and the knowledge base live as code in a git repo you own.',
    },
    {
      id: 'cloud',
      q: 'Do we have to use Kortix Cloud?',
      a: 'No. Kortix runs on Kortix Cloud, in your VPC, or on your own on-prem network. Any model provider with your own keys.',
    },
    {
      id: 'team',
      q: 'Can our own engineers keep building?',
      a: 'Yes, that is the point. Your team works in the same repo with us and keeps building after we leave.',
    },
    {
      id: 'start',
      q: 'How do we start?',
      a: 'Book a call. We talk about how your company works and pick the first job together.',
    },
  ],
} as const;

