/**
 * The /services page: AI Restructuring, the forward deployed team. The site
 * has two things to sell: the AI OS (every other marketing page) and this
 * service. `**phrase**` renders in ink.
 *
 * ACCURACY:
 *  - "AI transformation" is banned by name (kortix-brand voice-and-tone.md,
 *    Don't say). The service is "AI Restructuring".
 *  - No engagement length, term, price, guarantee or outcome metric: none is
 *    set. Add one only when the founder sets it.
 *  - No customer names, no customer count, no "fully autonomous" or
 *    "self-driving" (claims.md).
 *  - The two roles (Deployment Strategist, Forward Deployed Engineer) are the
 *    founder's offer from 2026-10-13.
 *
 * English only for now, like the /enterprise sections.
 */

export const hero = {
  title: 'AI Restructuring.',
  titleMuted: 'We rebuild how your company works, around agents.',
  sub: 'Our team writes your AI strategy and then builds it, across your product, your processes and your people. Everything we build runs on the Kortix AI Operating System, in a repo you own.',
} as const;

export const specs = [
  { k: 'Strategy', v: 'An audit of one function or the whole company' },
  { k: 'Product', v: 'Forward Deployed Engineers in your teams' },
  { k: 'Process', v: 'Recurring work handed to agents' },
  { k: 'People', v: 'Training for every team' },
] as const;

export const strategy = {
  title: 'Strategy first.',
  titleMuted: 'A roadmap you can act on, not a slide deck.',
  body: [
    'We start with an audit of **one function or the whole company**. We find the work where agents pay off first, estimate the return, and write the roadmap.',
    'You get **an adoption report with a technical appendix**. Build it with your own team, or hand it to us.',
  ],
  cells: [
    { k: 'Process survey', v: 'Every recurring job, who does it and in which tool.' },
    { k: 'Leadership interviews', v: 'What the company must do better, from the people who decide.' },
    { k: 'Use cases, ranked', v: 'Each one with its effort and its expected return.' },
    { k: 'The roadmap', v: 'What to build first, second and third.' },
  ],
} as const;

export const execution = {
  title: 'Then we build it.',
  titleMuted: 'Product, process and people.',
  sub: 'The people who write the roadmap ship it. Three tracks, run together.',
  items: [
    {
      id: 'product',
      n: '01',
      k: 'Product',
      v: 'Forward Deployed Engineers build agents, skills and internal apps into your product and your tools. They work in your teams, in your codebase.',
    },
    {
      id: 'process',
      n: '02',
      k: 'Process',
      v: 'We set a baseline for each process, connect your systems and hand the recurring work to agents. Your people keep the decisions and the exceptions.',
    },
    {
      id: 'people',
      n: '03',
      k: 'People',
      v: 'Workshops and a curriculum built for your teams, so they run the agents every day and build the next one themselves.',
    },
  ],
} as const;

export const team = {
  title: 'Two people, full time on your company.',
  titleMuted: 'One plans the work. One builds it.',
  body: [
    'Every engagement is led by **a Deployment Strategist and a Forward Deployed Engineer**. They join your company, not a steering committee.',
  ],
  cells: [
    {
      k: 'Deployment Strategist',
      v: 'Sits with your leaders and teams, maps the work and decides what agents take first.',
    },
    {
      k: 'Forward Deployed Engineer',
      v: 'Connects your systems, writes the agents and apps, and keeps them running.',
    },
  ],
} as const;

export const why = {
  title: 'Why companies bring us in.',
  titleMuted: 'The same four problems, every time.',
  rows: [
    { id: 'owner', k: 'Nobody owns AI', v: 'We own it, from the first interview to the agents your teams use every day.' },
    { id: 'skills', k: 'No AI engineers in house', v: 'Our engineers sit in your teams and build with them.' },
    {
      id: 'buy-in',
      k: 'Teams keep the old way of working',
      v: 'We train every team and stay until the new way is the normal way.',
    },
    {
      id: 'split',
      k: 'Strategy from one firm, execution from another',
      v: 'One team does both. The roadmap and the build never drift apart.',
    },
  ],
} as const;

export const offerings = {
  title: 'What we do.',
  titleMuted: 'Six things, one team.',
  items: [
    { id: 'process-survey', k: 'Process survey', v: 'A map of how the work gets done today.' },
    { id: 'executive-survey', k: 'Executive survey', v: 'Where leadership wants the company to go.' },
    { id: 'expert-interviews', k: 'Expert interviews', v: 'The people who do the work, on what slows them down.' },
    { id: 'training', k: 'Training programs', v: 'Hands-on workshops for each team, on its own work.' },
    {
      id: 'tooling',
      k: 'Agents and tooling',
      v: 'Off-the-shelf where it fits. Built on Kortix where it does not.',
    },
    {
      id: 'engineering',
      k: 'Engineering squads',
      v: 'Forward Deployed Engineers who ship in your codebase.',
    },
  ],
} as const;

export const ownership = {
  title: 'You keep everything we build.',
  titleMuted: 'It is your repo, not ours.',
  body: [
    'Every agent, skill, connector and app lives in **one git repo you own**, on the Kortix AI Operating System. Kortix is **open source**.',
    'Run it on **Kortix Cloud, in your VPC, or on your own on-prem network**. Any model provider with your own keys.',
  ],
} as const;
