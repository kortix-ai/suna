/**
 * The /services sales page: AI Transformation, done for you by one Forward
 * Deployed Engineer, sold as one flat monthly membership. The idea: we map
 * your org (what people do, how they work), unify your data, automate the
 * work and build your custom software. A standalone page with its own shell;
 * the AI OS site and this page link through `SiteSwitcher`.
 *
 * COMMERCIAL TERMS (founder, 2026-10-27, kortix-brand decisions.md D15):
 *  - One Forward Deployed Engineer, full time.
 *  - List price $20,000 a month. Launch price $15,000 a month: $5,000 off,
 *    for life, for a limited time. The Stripe price is the $15,000 one, so a
 *    subscription keeps it for as long as it runs.
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

export const PRICE = { now: '$15,000', was: '$20,000', per: '/month', off: '$5,000' } as const;

export const GUARANTEE = 'Not loving it in the first 2 weeks? Get 50% back, no questions asked.';

export const hero = {
  offer: `Limited time: ${PRICE.off} off every month, for life`,
  title: 'AI Transformation, done for you.',
  titleMuted: 'We map how your company works. Then we automate it.',
  sub: 'A Forward Deployed Engineer joins your company full time. They map what every team does and how it works, unify your data in one place, automate the work with agents, and build the custom software your teams need. You own everything they build.',
  assurances: ['One flat monthly fee', 'Price locked for life', 'Everything in a repo you own'],
} as const;

export const intro = {
  title: 'Book an intro call',
  body: 'Meet your engineer. We look at how your company works and pick the first function together.',
} as const;

export const proof = [
  { k: '20,000+', v: 'GitHub stars' },
  { k: 'Open source', v: 'Read it, fork it, audit it' },
  { k: 'SOC 2 Type I', v: 'Held. Type II in progress' },
  { k: 'Your cloud or ours', v: 'Kortix Cloud, your VPC, on-prem' },
] as const;

export const stages = {
  title: 'What happens.',
  titleMuted: 'Four stages, one engineer.',
  items: [
    {
      id: 'map',
      n: '01',
      k: 'Map your org',
      v: 'We sit with every team and map what each person does, how they do it, which tools they use and where the work waits.',
      get: ['A map of every team, role and recurring job', 'Where the time goes and where work stalls', 'A ranked list of what to automate first'],
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
      k: 'Build custom software',
      v: 'We build the internal apps, dashboards and tools your teams need on top of the unified data, on the Kortix AI Operating System.',
      get: ['Internal apps your teams use every day', 'Dashboards on live company data', 'All of it in a git repo you own'],
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

export const compare = {
  title: 'Better than hiring.',
  titleMuted: 'Better than a consultancy.',
  columns: ['Kortix', 'Hire an AI team', 'A consultancy'] as const,
  rows: [
    { id: 'strategy', k: 'Strategy', v: ['A map of your org and a ranked roadmap', 'You write it yourself', 'A slide deck'] },
    { id: 'build', k: 'Build', v: ['The same engineer builds it', 'Once you have hired them', 'Another firm, another contract'] },
    { id: 'data', k: 'Your data', v: ['Unified in one place', 'Up to you', 'Rarely in scope'] },
    { id: 'own', k: 'What you keep', v: ['Every agent and app, in your repo', 'What they build', 'The report'] },
    { id: 'price', k: 'Price', v: ['One flat monthly fee', 'Salaries, recruiting, equity', 'Day rates and change orders'] },
  ],
} as const;

export const benefits = {
  title: 'Membership benefits.',
  titleMuted: 'Why companies join instead of hiring.',
  items: [
    { id: 'team', icon: 'team', k: 'One engineer, full time', v: 'A Forward Deployed Engineer on your company, in your tools.' },
    { id: 'flat', icon: 'flat', k: 'One flat fee', v: 'One price every month. No day rates, no change orders.' },
    { id: 'one-person', icon: 'path', k: 'Maps it and builds it', v: 'The engineer who maps your company builds the automation.' },
    { id: 'os', icon: 'os', k: 'Built on the AI OS', v: 'Agents, skills, memory and connectors on the open-source Kortix AI Operating System.' },
    { id: 'own', icon: 'repo', k: 'You own all of it', v: 'Every agent, skill and app lives in one git repo you own.' },
    { id: 'where', icon: 'cloud', k: 'Runs where you run', v: 'Kortix Cloud, your VPC, or your own on-prem network.' },
  ],
} as const;

export const pricing = {
  title: 'One membership.',
  titleMuted: 'Everything included.',
  plan: 'AI Transformation',
  badge: 'Limited time',
  lock: `${PRICE.off} off every month, for life. Join while the offer runs and your price never goes up.`,
  includes: [
    'A Forward Deployed Engineer, full time',
    'A map of your org and how it works',
    'Your data unified in one place',
    'Agents for your recurring work',
    'Custom software and internal apps',
    'Training for every team',
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
      id: 'lifetime',
      q: 'What does the lifetime discount mean?',
      a: `Join while the offer runs and you pay ${PRICE.now} a month instead of ${PRICE.was}. Your price stays at ${PRICE.now} for as long as your membership runs.`,
    },
    {
      id: 'engineer',
      q: 'What does the Forward Deployed Engineer do?',
      a: 'They join your company full time. They map how every team works, connect your systems and unify your data, build the agents that take over the recurring work, build the custom software your teams need, and keep it all running.',
    },
    {
      id: 'data',
      q: 'What does "unify your data" mean?',
      a: 'We connect the systems you already run and centralise their data in one company knowledge base. Every agent and every person then works from the same facts.',
    },
    {
      id: 'own',
      q: 'What do we keep?',
      a: 'Everything. The agents, skills, connectors and apps live in one git repo you own, on the open-source Kortix AI Operating System.',
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
  title: 'Map it. Unify it. Automate it.',
  titleMuted: 'Start this month.',
} as const;
