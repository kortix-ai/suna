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
  sub: 'Our team works inside your company, from strategy to shipped software, then teaches your people to run it. You own everything we build.',
  /** The offer in five lines: the first thing a buyer reads after the title. */
  does: [
    { k: 'Map your company', v: 'every team, role and workflow' },
    { k: 'Unify your data', v: 'every system in one place' },
    { k: 'Automate the work', v: 'agents on the recurring jobs' },
    { k: 'Build custom apps', v: 'internal tools and dashboards on your data' },
    { k: 'Train your team', v: 'to run it and build the next one' },
  ],
  assurances: [`${PRICE.now} a month, flat`, 'Strategy and build, one team', 'Everything in a repo you own'],
} as const;

export const caseCta = 'See what we would build for your company.';

export const intro = {
  title: 'Book an intro call',
  body: 'Meet the team. We look at how your company works and pick the first function together.',
} as const;

export const proof = [
  { k: '20,000+', v: 'GitHub stars' },
  { k: 'Open source', v: 'Read it, fork it, audit it' },
  { k: 'SOC 2 Type I', v: 'Held. Type II in progress' },
  { k: 'Your cloud or ours', v: 'Kortix Cloud, your VPC, on-prem' },
] as const;

/** How an engagement starts. No durations: none is set (ACCURACY). */
export const onboarding = {
  title: 'How we start.',
  titleMuted: 'One function first, then the next.',
  items: [
    { id: 'call', n: '01', k: 'Intro call', v: 'We look at how your company works and pick the first function together.' },
    {
      id: 'plan',
      n: '02',
      k: 'Map and plan',
      v: 'We map that function end to end and write the roadmap: what to automate first, second and third.',
    },
    {
      id: 'ship',
      n: '03',
      k: 'Build and ship',
      v: 'We unify its data, put agents on the recurring work, build the apps it needs and train the team. Then the next function.',
    },
  ],
} as const;

export const strategy = {
  title: 'AI Strategy.',
  titleMuted: 'A roadmap, not a slide deck.',
  body: [
    'We audit **one function or the whole company**. We interview leadership and the people who do the work, set a baseline for each process, and rank every use case by effort and return.',
    'You get **an AI strategy and a roadmap in your own repo**: what to automate first, second and third, and how you will know it worked.',
  ],
  cells: [
    { k: 'Leadership interviews', v: 'Where the company must get better, from the people who decide.' },
    { k: 'Team interviews', v: 'How the work really gets done, from the people who do it.' },
    { k: 'Baselines', v: 'How each process runs today, so you can measure the change.' },
    { k: 'A ranked roadmap', v: 'Every use case by effort and return, in the order we build it.' },
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
      v: 'We sit with every team and map what each person does, how they do it, which tools they use and where the work waits.',
      get: ['A map of every team, role and recurring job', 'Where the time goes and where work stalls', 'Who does what, in which tool'],
    },
    {
      id: 'unify',
      n: '02',
      k: 'Unify your data',
      v: 'We connect every system you run and centralise its data in one place, so every agent and every person works from the same facts.',
      get: ['Your systems connected to one place', 'One company knowledge base your agents read', 'One source of truth for every team'],
    },
    {
      id: 'automate',
      n: '03',
      k: 'Automate the work',
      v: 'Agents take over the recurring work we mapped, on schedules and triggers. Your people keep the decisions and the exceptions.',
      get: ['Agents for each recurring job', 'Approval rules you set', 'People freed for the work that needs judgment'],
    },
    {
      id: 'build',
      n: '04',
      k: 'Build custom apps',
      v: 'We build the internal apps, dashboards and tools your teams need on top of the unified data, on the Kortix AI Operating System.',
      get: ['Internal apps your teams use every day', 'Dashboards on live company data', 'All of it in a git repo you own'],
    },
    {
      id: 'teach',
      n: '05',
      k: 'Train your team',
      v: 'We teach the people you already have to run the agents and apps, and to build the next ones without us.',
      get: ['Hands-on workshops per team', 'Builder training for your engineers', 'Playbooks in your repo'],
    },
  ],
} as const;

export const functions = {
  title: 'Every function.',
  titleMuted: 'Here is the work agents take over.',
  items: [
    { id: 'sales', k: 'Sales', v: 'Lead research, CRM updates, follow-ups, proposals.' },
    { id: 'support', k: 'Customer support', v: 'Triage, first replies, routing, answers from your knowledge base.' },
    { id: 'finance', k: 'Finance', v: 'Invoice matching, reconciliation, reporting, collections follow-up.' },
    { id: 'recruiting', k: 'Recruiting', v: 'Sourcing, screening, scheduling, candidate updates.' },
    { id: 'research', k: 'Research', v: 'Desk research, briefs, market and competitor tracking.' },
    { id: 'reporting', k: 'Reporting', v: 'Weekly numbers, dashboards, board-pack drafts.' },
    { id: 'operations', k: 'Operations', v: 'Handoffs between tools, status updates, data entry.' },
    { id: 'legal', k: 'Legal ops', v: 'Contract intake, first-pass review, clause tracking.' },
    { id: 'marketing', k: 'Marketing', v: 'Content drafts, campaign reporting, list hygiene.' },
    { id: 'engineering', k: 'Engineering', v: 'Ticket triage, small fixes, internal tooling.' },
    { id: 'procurement', k: 'Procurement', v: 'Vendor intake, quote comparison, purchase-order follow-up.' },
    { id: 'back-office', k: 'Back office', v: 'Document processing, records, compliance checklists.' },
  ],
  more: {
    k: 'Anything that runs on repeat',
    v: 'If a person does it every week by the same steps, we map it and hand it to an agent.',
  },
} as const;

export const education = {
  title: 'AI Education.',
  titleMuted: 'We teach your existing team.',
  body: [
    'Agents stick when your people know how to use them. We train **the team you already have**, on **their own work**, not on generic demos.',
    'The goal: your team **runs the agents every day and builds the next ones without us**.',
  ],
  cells: [
    { k: 'Leadership sessions', v: 'What AI changes for your company, and the decisions only leaders can make.' },
    {
      k: 'Team workshops',
      v: 'Hands-on, per team: pick one workflow, decide what agents do and where a person approves, then build it.',
    },
    { k: 'Builder training', v: 'Your engineers and power users learn to write agents, skills and connectors in your repo.' },
    { k: 'Playbooks in your repo', v: 'Your workflows written down as skills that your agents and your people both read.' },
  ],
} as const;

export const compare = {
  title: 'Better than hiring.',
  titleMuted: 'Better than a consultancy.',
  columns: ['Kortix', 'Hire an AI team', 'A consultancy'] as const,
  rows: [
    { id: 'strategy', k: 'Strategy', v: ['A map of your company and a ranked roadmap', 'You write it yourself', 'A slide deck'] },
    { id: 'build', k: 'Build', v: ['The same team builds it', 'Once you have hired them', 'Another firm, another contract'] },
    { id: 'data', k: 'Your data', v: ['Unified in one place', 'Up to you', 'Rarely in scope'] },
    { id: 'apps', k: 'Custom apps', v: ['Built on your unified data', 'Once you hire engineers', 'Another project, another quote'] },
    { id: 'people', k: 'Your people', v: ['Trained on their own work', 'Up to you', 'A workshop, then gone'] },
    { id: 'own', k: 'Who owns the work', v: ['You do, in your own repo', 'You do', 'You get a report'] },
    { id: 'price', k: 'Price', v: ['One flat monthly fee', 'Salaries, recruiting, equity', 'Day rates and change orders'] },
  ],
} as const;

export const benefits = {
  title: 'Membership benefits.',
  titleMuted: 'Why companies join instead of hiring.',
  items: [
    { id: 'team', icon: 'team', k: 'Inside your company', v: 'Our team works in your teams and your tools.' },
    { id: 'flat', icon: 'flat', k: 'One flat fee', v: 'One price every month. No day rates, no change orders.' },
    { id: 'one-team', icon: 'path', k: 'Strategy and build, one team', v: 'The people who map your company build its agents and apps.' },
    { id: 'os', icon: 'os', k: 'Built on the AI OS', v: 'Agents, skills, memory and connectors on the open-source Kortix AI Operating System.' },
    { id: 'own', icon: 'repo', k: 'You own all of it', v: 'Every agent, skill and app lives in one git repo you own.' },
    { id: 'where', icon: 'cloud', k: 'Runs where you run', v: 'Kortix Cloud, your VPC, or your own on-prem network.' },
  ],
} as const;

export const pricing = {
  title: 'One membership.',
  titleMuted: 'Everything included.',
  plan: 'AI Transformation',
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
      a: 'Kortix is open source and holds SOC 2 Type I, with Type II in progress. Secrets are encrypted per project, and you choose where it runs: Kortix Cloud, your VPC or your own on-prem network.',
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
      id: 'engineers',
      q: 'Can our own engineers keep building?',
      a: 'Yes, that is the point. Your team works in the same repo and keeps building after we hand over.',
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
