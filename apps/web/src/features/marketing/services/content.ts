/**
 * The /services sales page: AI Transformation, done for you, sold as one
 * flat monthly membership. The idea: we map
 * your company (what people do, how they work), unify your data, automate the
 * work and build your custom apps. A standalone page with its own shell;
 * the AI OS site and this page link through `SiteSwitcher`.
 *
 * COMMERCIAL TERMS (founder, 2026-10-27, kortix-brand decisions.md D15):
 *  - The team is "we" / "our team". The roles (Deployment Strategists,
 *    Forward Deployed Engineers) appear once, in the "Who does the work?"
 *    answer: no headcount, no "full time", no per-stage owners (founder,
 *    2026-10-27: "remove all that overindexing on FDE/strategist").
 *  - A flat $20,000 a month. No discount, no "limited time", no strike-through
 *    price: the founder dropped the $5,000 launch discount as too fishy.
 *  - Guarantee, kept low-key (one line, never a card or a headline): "Not
 *    loving it in the first 2 weeks? Get 50% back, no questions asked."
 *  - "AI Transformation" is the service name here only (D15). Everywhere
 *    else the voice-and-tone ban stands.
 *
 * ACCURACY:
 *  - No engagement length, minimum term, cancellation term, start date,
 *    outcome metric or "spots left": none is set.
 *  - Whether model and compute usage is included is not set: do not answer it.
 *  - The per-function lists are examples of work agents take over, not
 *    results: never attach a number to them.
 *  - Approval: "approval rules you set" (claims.md: gates are off until set).
 *  - No customer names or counts. Proof = the claims.md rows only.
 *
 * English only for now, like the /enterprise sections.
 */

export const PRICE = { now: '$20,000', per: '/month' } as const;

export const GUARANTEE = 'Not loving it in the first 2 weeks? Get 50% back, no questions asked.';

export const hero = {
  title: 'AI Transformation, done for you.',
  titleMuted: 'We map your company, unify your data and build your apps.',
  sub: 'Our team works inside your company, from strategy to shipped software, on Kortix. One flat monthly fee. You own every line.',
  /** The offer as five tiles, right under the call to action. */
  does: [
    { id: 'map', icon: 'map', k: 'Map your company', v: 'Every team, role and workflow.' },
    { id: 'unify', icon: 'data', k: 'Unify your data', v: 'Every system in one place.' },
    { id: 'automate', icon: 'loop', k: 'Automate the work', v: 'Agents on the recurring jobs.' },
    { id: 'build', icon: 'app', k: 'Build custom apps', v: 'Internal tools on your data.' },
    { id: 'train', icon: 'train', k: 'Train your team', v: 'To run it and build the next one.' },
  ],
  /** One quiet line under the buttons. */
  terms: `${PRICE.now} a month, flat · Strategy and build, one team · Everything in a repo you own`,
  /** The logo row: products built on Kortix (case-studies/content.ts naming rules). */
  logosLabel: 'Built on Kortix',
  logos: [
    {
      src: '/media/case-studies/cityu.svg',
      alt: 'City University of Hong Kong',
      width: 262,
      height: 147,
    },
    { src: '/media/case-studies/writer.svg', alt: 'WRITER', width: 110, height: 35 },
    { src: '/media/case-studies/wring.svg', alt: 'Wring', width: 74, height: 28 },
  ],
  logosLink: 'See the work',
} as const;

/** We build on our own product. Claims: claims.md rows Source, Connectors, Hosting. */
export const platform = {
  title: 'Built on Kortix.',
  titleMuted: 'The open-source AI Operating System we make.',
  body: [
    'Everything we build runs on **Kortix, our own AI Operating System**. Your agents, skills, company memory, connectors and apps live in **one git repo you own**.',
    'When we step back, nothing leaves with us: **your team keeps running it on Kortix**, in our cloud, your VPC or your own on-prem network.',
  ],
  cells: [
    { k: 'Agents and skills', v: 'Every agent and every workflow is a file in your repo.' },
    { k: 'Company memory', v: 'What we map becomes context your agents read.' },
    { k: 'Connectors', v: '3,000+ apps, plus MCP, OpenAPI and raw HTTP.' },
    { k: 'Open source', v: 'Read it, fork it, audit it. No black box.' },
  ],
  link: 'See the AI OS',
} as const;

export const caseCta = 'See what we would build for your company.';

export const intro = {
  title: 'Rather meet first?',
  body: 'Book an intro call with the team. We look at how your company works and pick the first function together.',
} as const;

/** How an engagement starts. No durations: none is set (ACCURACY). */
export const onboarding = {
  title: 'How it works.',
  titleMuted: 'Join, map, ship. Then the next function.',
  items: [
    {
      id: 'join',
      n: '01',
      k: 'Join',
      v: 'One flat monthly membership. Book an intro call first if you want to meet the team.',
    },
    {
      id: 'map',
      n: '02',
      k: 'We map your company',
      v: 'We interview your leaders and the people who do the work, then write a ranked roadmap: what to automate first, second and third.',
    },
    {
      id: 'ship',
      n: '03',
      k: 'We ship, function by function',
      v: 'We unify the data, put agents on the work, build the apps and train the team. Then we move to the next function.',
    },
  ],
} as const;

export const stages = {
  title: 'What we do.',
  titleMuted: 'Map, unify, automate, build, teach.',
  items: [
    {
      id: 'map',
      n: '01',
      k: 'Map your company',
      v: 'We interview your leaders and sit with every team: what each person does, how, in which tools, and where the work waits. Then we rank every use case by effort and return.',
      get: [
        'A map of every team, role and recurring job',
        'A baseline for each process, so you can measure the change',
        'A ranked roadmap in your own repo',
      ],
    },
    {
      id: 'unify',
      n: '02',
      k: 'Unify your data',
      v: 'We connect every system you run and centralise its data in one place, so every agent and every person works from the same facts.',
      get: [
        'Your systems connected to one place',
        'One company knowledge base your agents read',
        'One source of truth for every team',
      ],
    },
    {
      id: 'automate',
      n: '03',
      k: 'Automate the work',
      v: 'Agents take over the recurring work we mapped, on schedules and triggers. Your people keep the decisions and the exceptions.',
      get: [
        'Agents for each recurring job',
        'Approval rules you set',
        'People freed for the work that needs judgment',
      ],
    },
    {
      id: 'build',
      n: '04',
      k: 'Build custom apps',
      v: 'We build the internal apps, dashboards and tools your teams need on top of the unified data, on the Kortix AI Operating System.',
      get: [
        'Internal apps your teams use every day',
        'Dashboards on live company data',
        'All of it in a git repo you own',
      ],
    },
    {
      id: 'teach',
      n: '05',
      k: 'Train your team',
      v: 'We teach the people you already have, on their own work: leaders on what changes, teams on running the agents, your engineers on building the next ones without us.',
      get: [
        'Leadership sessions and team workshops',
        'Builder training for your engineers',
        'Playbooks your agents and people both read',
      ],
    },
  ],
} as const;

export const functions = {
  title: 'Every function.',
  titleMuted: 'Here is the work agents take over.',
  items: [
    { id: 'sales', k: 'Sales', v: 'Lead research, CRM updates, follow-ups, proposals.' },
    {
      id: 'support',
      k: 'Customer support',
      v: 'Triage, first replies, routing, answers from your knowledge base.',
    },
    {
      id: 'finance',
      k: 'Finance',
      v: 'Invoice matching, reconciliation, reporting, collections follow-up.',
    },
    { id: 'recruiting', k: 'Recruiting', v: 'Sourcing, screening, scheduling, candidate updates.' },
    { id: 'research', k: 'Research', v: 'Desk research, briefs, market and competitor tracking.' },
    { id: 'reporting', k: 'Reporting', v: 'Weekly numbers, dashboards, board-pack drafts.' },
    { id: 'operations', k: 'Operations', v: 'Handoffs between tools, status updates, data entry.' },
    { id: 'legal', k: 'Legal ops', v: 'Contract intake, first-pass review, clause tracking.' },
    { id: 'marketing', k: 'Marketing', v: 'Content drafts, campaign reporting, list hygiene.' },
    { id: 'engineering', k: 'Engineering', v: 'Ticket triage, small fixes, internal tooling.' },
    {
      id: 'procurement',
      k: 'Procurement',
      v: 'Vendor intake, quote comparison, purchase-order follow-up.',
    },
    {
      id: 'back-office',
      k: 'Back office',
      v: 'Document processing, records, compliance checklists.',
    },
  ],
  more: {
    k: 'Anything that runs on repeat',
    v: 'If a person does it every week by the same steps, we map it and hand it to an agent.',
  },
} as const;

export const compare = {
  title: 'Better than hiring.',
  titleMuted: 'Better than a consultancy.',
  columns: ['Kortix', 'Hire an AI team', 'A consultancy'] as const,
  rows: [
    {
      id: 'strategy',
      k: 'Strategy',
      v: ['A map of your company and a ranked roadmap', 'You write it yourself', 'A slide deck'],
    },
    {
      id: 'build',
      k: 'Build',
      v: ['The same team builds it', 'Once you have hired them', 'Another firm, another contract'],
    },
    { id: 'data', k: 'Your data', v: ['Unified in one place', 'Up to you', 'Rarely in scope'] },
    {
      id: 'apps',
      k: 'Custom apps',
      v: [
        'Built on your unified data',
        'Once you hire engineers',
        'Another project, another quote',
      ],
    },
    {
      id: 'people',
      k: 'Your people',
      v: ['Trained on their own work', 'Up to you', 'A workshop, then gone'],
    },
    {
      id: 'own',
      k: 'Who owns the work',
      v: ['You do, in your own repo', 'You do', 'You get a report'],
    },
    {
      id: 'price',
      k: 'Price',
      v: ['One flat monthly fee', 'Salaries, recruiting, equity', 'Day rates and change orders'],
    },
  ],
} as const;

export const benefits = {
  title: 'Membership benefits.',
  titleMuted: 'Why companies join instead of hiring.',
  items: [
    {
      id: 'team',
      icon: 'team',
      k: 'Inside your company',
      v: 'Our team works in your teams and your tools.',
    },
    {
      id: 'flat',
      icon: 'flat',
      k: 'One flat fee',
      v: 'One price every month. No day rates, no change orders.',
    },
    {
      id: 'one-team',
      icon: 'path',
      k: 'Strategy to shipped software',
      v: 'The people who map your company build its agents and apps.',
    },
    {
      id: 'function',
      icon: 'os',
      k: 'Function by function',
      v: 'We finish one function, then move to the next.',
    },
    {
      id: 'own',
      icon: 'repo',
      k: 'You own all of it',
      v: 'Every agent, skill and app lives in one git repo you own.',
    },
    {
      id: 'trained',
      icon: 'cloud',
      k: 'Your team, trained',
      v: 'Your people run it and build the next agents without us.',
    },
  ],
} as const;

export const pricing = {
  title: 'One membership.',
  titleMuted: 'Everything included.',
  plan: 'AI Transformation',
  includedTitle: 'Everything included',
  lock: 'One flat monthly fee. No day rates, no change orders.',
  includes: [
    'An AI strategy and a ranked roadmap',
    'A map of your company and how it works',
    'Your data unified in one place',
    'Agents for your recurring work',
    'Custom apps and internal tools',
    'Training for your existing team',
    'Everything in a git repo you own',
    'Kortix Cloud, your VPC, or on-prem',
  ],
  secure: 'Secure checkout by Stripe',
} as const;

export const faq = {
  title: 'Questions.',
  titleMuted: 'Answered before you ask.',
  items: [
    {
      id: 'price',
      q: 'What does it cost?',
      a: `${PRICE.now} a month, flat. No day rates, no change orders.`,
    },
    {
      id: 'team',
      q: 'Who does the work?',
      a: 'Our own team: strategists who map how your company works, and Forward Deployed Engineers who build it. They work inside your company, in your tools.',
    },
    {
      id: 'need',
      q: 'What do you need from us?',
      a: 'A leader who can say yes, access to the tools your teams use, and time with the people who do the work. We do the rest.',
    },
    {
      id: 'security',
      q: 'Is our data safe?',
      a: 'Kortix is open source and SOC 2 Type I verified. Secrets are encrypted per project, and you choose where it runs: Kortix Cloud, your VPC or your own on-prem network.',
    },
    {
      id: 'data',
      q: 'What does "unify your data" mean?',
      a: 'We connect the systems you already run and centralise their data in one company knowledge base. Every agent and every person then works from the same facts.',
    },
    {
      id: 'education',
      q: 'Do you train our team?',
      a: 'Yes. Education is part of every membership: leadership sessions, hands-on workshops for each team, and builder training for your engineers. The goal is a team that builds the next agent without us.',
    },
    {
      id: 'platform',
      q: 'What do you build it on?',
      a: 'On Kortix, the open-source AI Operating System we make. Every agent, skill, connector and app lives in a git repo you own, so your team can run and extend it without us.',
    },
    {
      id: 'own',
      q: 'Who owns what you build?',
      a: 'You do. Every agent, skill, connector and app lives in a git repo you own, on the open-source Kortix AI Operating System. Every session and file of context stays yours.',
    },
    {
      id: 'host',
      q: 'Do we have to use Kortix Cloud?',
      a: 'No. Run it on Kortix Cloud, in your VPC, or on your own on-prem network. Any model provider with your own keys.',
    },
    {
      id: 'fit',
      q: 'Who is this for?',
      a: 'Companies with a leader who can say yes, and teams who will try a new way of working this month. If a decision needs six committees, we are not a fit yet.',
    },
    { id: 'guarantee', q: 'What if it is not for us?', a: GUARANTEE },
    {
      id: 'talk',
      q: 'Can we talk before we pay?',
      a: 'Yes. Book an intro call. We look at how your company works and pick the first function together.',
    },
  ],
} as const;

export const closing = {
  title: 'Map it. Build it. Run it.',
  titleMuted: 'Start with one function this month.',
} as const;
