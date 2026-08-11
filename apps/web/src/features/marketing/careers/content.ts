/**
 * `/careers` copy. The page is a job board, not an essay: the openings, the
 * bar, and how to apply. Nothing else belongs here — the thesis lives on
 * `/about`.
 *
 * Plain English lives here, not in `apps/web/translations/*.json`, so the copy
 * can iterate before paying the 8-locale parity gate (`pnpm i18n:translations`).
 *
 * Voice rules: the `comms` skill. The bar is distilled from `CLAUDE.md`.
 *
 * ACCURACY GATE for this page specifically:
 *  - INVENT NOTHING about employment. No salary band, no equity, no benefits,
 *    no headcount, no remote policy. The only two locations are **Belgrade,
 *    Serbia** and **San Francisco**; every opening is open in both, and no
 *    third location may be added.
 *  - The five openings are the founder's own list. Every bullet under them
 *    comes from him. Keep them short — a spec belongs in a conversation.
 *  - Applications go through `ApplyModal`, which posts to the same
 *    `/api/demo-request` pipeline as "Book your demo". There is no ATS and no
 *    jobs@ alias — do not invent one. The three direct links (email, X,
 *    LinkedIn) are the ones this page already carried.
 *  - There is NO file upload on that pipeline (JSON in, one blob into
 *    `contact_forms`). Ask for a LINK to a CV or portfolio. Never promise an
 *    attachment.
 *  - Naming opencode / Codex / Claude Code / Pi under Product / Eng describes
 *    ecosystem fluency wanted in a CANDIDATE. It must never read as a claim
 *    that dosco supports those harnesses. OpenCode is the dosco harness, and
 *    the same opening says so.
 *  - Competitor names, exactly: **Claude Cowork** (one word, lowercase `w`) and
 *    **ChatGPT Work** (two words).
 *  - Never name a licence — "open source" and stop. Never claim a certification.
 *  - No culture-page filler. If a sentence restates the one above it, cut it.
 */

/** The only two locations. Every opening is open in both. */
export const LOCATIONS = 'Belgrade · San Francisco' as const;

export const hero = {
  eyebrow: 'Careers',
  title: 'Open positions.',
  lead: 'Belgrade, Serbia and San Francisco.',
  ctaPrimary: 'Apply',
  ctaSecondary: 'Why dosco exists',
  ctaSecondaryHref: '/about',
} as const;

/** The board. Collapsed shows name, locations and the summary line. */
export const openings = [
  {
    id: 'marketing',
    name: 'Marketing / Content',
    summary:
      'Make dosco the instant answer to "what is the Claude Cowork or ChatGPT Work?"',
    bullets: [
      'Build the content baseline, and the system that keeps producing it.',
      'Daily platform and feature explainers.',
      'High-quality video and motion.',
      'Use-case and marketplace-driven content.',
      'Influencer and UGC motion on X and LinkedIn.',
      'Crank out content the way we crank out commits.',
    ],
  },
  {
    id: 'sales',
    name: 'Sales',
    summary: 'Convert every inbound lead and build the outbound motion from zero.',
    bullets: [
      'Convert every inbound lead.',
      'Build outbound from nothing.',
      'Sell to companies.',
      'Sell the FDE and services engagement alongside the platform.',
    ],
  },
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
    id: 'product-eng',
    name: 'Product / Eng',
    summary: 'Own the platform end to end — the agent runtime, the product around it, and the taste that holds both together.',
    bullets: [
      'Built 0 to 1 and 1 to n at a startup.',
      'Has run their own product or company. The stretch matters more than the outcome.',
      'Excellent product taste, and UX and UI taste specifically.',
      'Strong systems-thinking judgement.',
      'Real understanding of agent architecture: harness, loops, context handling, tool boundaries, sandboxing, evals.',
      'Has built agents, and lives on coding agents — opencode, Codex, Claude Code, Pi, whichever you reach for.',
      'On the frontier of AI by habit, not by assignment.',
      'Titles are flat. Everyone on the technical side is Member of Technical Staff.',
      'Can recruit.',
    ],
    /** Guards the coding-agent bullet: fluency in a candidate, never a claim
     *  about what dosco runs. */
    note: 'dosco runs on the OpenCode harness. That bullet is about your fluency in the ecosystem, not about what the platform supports.',
  },
  {
    id: 'rnd',
    name: 'Product / R&D',
    summary: 'Push what dosco agent means: fully autonomous cognitive beings as digital coworkers.',
    bullets: [
      'Where Product / Eng hardens the platform, R&D pushes what it becomes.',
      'Comfortable working a long way ahead of what ships.',
    ],
  },
] as const;

export const bar = {
  eyebrow: 'The filter',
  title: 'What we look for.',
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
  eyebrow: 'Apply',
  title: 'Tell me what you have worked on.',
  body: 'One open question, no form to game. Products, campaigns, companies, things you built for yourself — whatever you want me to know. It comes straight to me. I am Marko.',
  cta: 'Apply',
  directLead: 'Or write to me directly:',
  links: [
    { id: 'email', label: 'marko@dosco.live', href: 'mailto:marko@dosco.live', external: false },
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
  title: 'Apply to dosco',
  description: 'Short. One open question does the work.',
  areaLabel: 'Which opening',
  areaPlaceholder: 'Pick the closest one',
  areaOptions: [
    'Marketing / Content',
    'Sales',
    'FDE / Services',
    'Product / Eng',
    'Product / R&D',
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
