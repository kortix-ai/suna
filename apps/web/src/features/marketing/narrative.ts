/**
 * narrative.ts — copy for the landing page motion.
 *
 * Source of truth for positioning lives in POSITIONING.md (same folder).
 *
 * Motion (conversion + narrative blend):
 *   Hero(+trust) → Problem → Real output → Every tool → Skillify →
 *   Capabilities(memory · always-on · workspace) → Comparison →
 *   Use cases → Own it → Security → FAQ → Closing
 *
 * All copy is plain English constants so the whole motion edits in one place.
 */

export const HERO = {
  badge: 'Open-source AI workforce platform',
  titleLead: 'Give everyone their own',
  titleAccent: 'AI coworker.',
  description:
    'Every employee gets an AI coworker that connects to your tools and ships real work. Open-source, self-hostable, and sharper every time someone shares a skill.',
  primaryCta: 'Get started',
  secondaryCta: 'Talk to sales',
  /** the three core benefits, communicated up front */
  benefits: [
    { title: 'Ships real work', body: 'PDFs, dashboards, web apps, code — not just answers.' },
    { title: 'Every tool, one message', body: '3,000+ integrations, used together in a single run.' },
    { title: 'Yours to own', body: 'Open-source, self-hostable, leveled up by your team.' },
  ],
} as const;

/** Thin trust strip under the hero. Honest signals only. */
export const TRUST = {
  lead: 'No credit card. Free to self-host.',
  chips: ['Open-source', 'Self-hostable', 'SOC 2 in progress', 'Any model, your keys', 'SSO + RBAC'],
} as const;

export const PROBLEM = {
  eyebrow: 'The real bottleneck',
  title: ['The models are good enough.', "The harness isn't."],
  paragraphs: [
    'Your team has the ambition and the models. What they don’t have is a setup that just works — configuring agents, wiring tools, juggling API keys. So AI lands in the hands of the few who enjoy fiddling with config, and everyone else watches from the sidelines.',
    'Kortix removes the setup entirely. Sign in once and every employee gets a fully-configured AI coworker — your tools, your models and your company’s best workflows already wired in. The capability is all there. The friction is gone.',
  ],
  /** before → after friction chips */
  friction: ['Terminal windows', 'npm install -g …', 'MCP config JSON', 'Per-person API keys'],
  resolution: 'Sign in once. Everything works.',
} as const;

/** Scroll-synced walkthrough (reuses the sticky-showcase mechanic). Company journey. */
export type WalkStep = {
  id: 'connect' | 'delegate' | 'ship' | 'share';
  label: string;
  title: string;
  description: string;
  bullets: string[];
};

export const WALKTHROUGH = {
  eyebrow: 'How it works',
  title: 'From “can someone…” to done',
  description:
    'No prompt-engineering. No setup. Anyone describes what they need — Kortix does the work, and shares how it did it.',
  steps: [
    {
      id: 'connect',
      label: '01 · Connect',
      title: 'Connect once. The whole org’s wired.',
      description:
        'Sign in to Kortix, then connect your tools in a click — 3,000+ apps. An admin connects an app once and it’s shared securely across the org. No per-person setup, no copy-pasted keys.',
      bullets: [
        'Apps connect in one click — OAuth handled for you',
        'Connect once, shared securely across the org',
      ],
    },
    {
      id: 'delegate',
      label: '02 · Delegate',
      title: 'Just ask, in plain language',
      description:
        'In Slack, the web workspace, or on a schedule — describe the outcome, not the steps. Talk to it like a colleague.',
      bullets: ['No prompts to master', 'Works across Slack, web, mobile & API'],
    },
    {
      id: 'ship',
      label: '03 · It ships',
      title: 'Real work comes back done',
      description:
        'Each coworker has its own cloud computer. It pulls from your tools, does the work, and delivers the finished artifact.',
      bullets: ['PDFs, dashboards, web apps, code', 'Delivered, not described'],
    },
    {
      id: 'share',
      label: '04 · It’s shared',
      title: 'One win becomes everyone’s',
      description:
        'Save how it did the work as a skill — versioned, composable — and the whole company inherits the superpower.',
      bullets: ['Package any workflow as a skill', 'The floor rises with every share'],
    },
  ] satisfies WalkStep[],
} as const;

/** Viktor-style "real output" proof — Kortix ships, it doesn't just answer. */
export const REAL_OUTPUT = {
  eyebrow: 'Real output',
  title: 'Real work, not just answers',
  description:
    'Kortix doesn’t brainstorm — it ships. Board-ready PDFs, dashboards your team actually uses, web apps you’d swear a developer built, code and pull requests. Each coworker gets its own cloud computer and delivers, instead of describing.',
  tiles: [
    { label: 'Reports & PDFs', sub: 'Board decks, briefs, analyses' },
    { label: 'Live dashboards', sub: 'Real metrics from your tools' },
    { label: 'Web apps', sub: 'Deployed, with auth + database' },
    { label: 'Code & PRs', sub: 'Real commits, real reviews' },
  ],
} as const;

/** Connected-by-default section, fronted by the integration marquee. */
export const EVERY_TOOL = {
  eyebrow: 'Connected by default',
  title: 'One message, every tool',
  description:
    'Connect your stack once — 3,000+ tools — and Kortix uses them the way you do: pull from Stripe, enrich from your CRM, update Notion, open a PR in GitHub, all in a single run. No tab-switching, no CSV exports.',
  footnote: 'Apps · MCP · OpenAPI · GraphQL · raw HTTP — one interface',
} as const;

/** The differentiator. Gets its own full section. */
export const SKILLIFY = {
  eyebrow: 'Skillify your company',
  title: ['One person’s workflow.', 'Everyone’s superpower.'],
  description:
    'Skills are simple markdown files that teach an agent exactly how to do a task. Package how your best people work — analyzing calls, triaging tickets, building battlecards — and every coworker, in every department, inherits it instantly.',
  bullets: [
    'Composable & dependency-based — skills build on skills, like packages',
    'Git-backed, versioned and reviewed like code',
    'A built-in guide surfaces the right skills for your role and tools',
    'One person adds it → the whole company levels up overnight',
  ],
} as const;

export type Capability = {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
  bullets: string[];
  /** which visual to render */
  visual: 'connect' | 'skills' | 'memory' | 'automations' | 'workspace';
};

export const CAPABILITIES: Capability[] = [
  {
    id: 'memory',
    eyebrow: 'Persistent memory',
    title: 'Never re-explain your company',
    description:
      'On first sign-in, Kortix builds a memory from everything you’ve connected — the people you work with, your active projects, the relevant Slack channels, Notion docs and Linear tickets.',
    bullets: [
      'Every session starts with the context you’d expect — less searching, sharper answers',
      'A synthesis pipeline mines your sessions and connected tools every 24 hours',
      'It adapts to your world without you re-explaining it each session',
    ],
    visual: 'memory',
  },
  {
    id: 'automations',
    eyebrow: 'Always on',
    title: 'It works while you don’t',
    description:
      'Turn your agents into a server. Schedule automations daily, weekly or on any cron and post results straight to Slack. Spin up Slack-native assistants that answer in-channel with your full setup.',
    bullets: [
      'A daily 8am spend-anomaly summary, set up in a few minutes',
      'Slack-native assistants with your integrations, memory and skills built in',
      'Headless mode: kick off a long task, walk away, approve from your phone',
    ],
    visual: 'automations',
  },
  {
    id: 'workspace',
    eyebrow: 'A real workspace',
    title: 'A workspace, not a chat window',
    description:
      'Most AI gives you a single thread. Kortix gives you a full workspace — tile chats side by side, open docs, data and code in split panes, and keep context visible while you work. It works like a code editor.',
    bullets: [
      'Renders markdown, HTML, CSV, images and code inline as tabs',
      'When an agent creates or edits a file, it opens automatically',
      'Your layout — panes and tabs — persists exactly as you left it',
    ],
    visual: 'workspace',
  },
];

/** "You've tried AI tools. The work's still there." */
export const COMPARISON = {
  eyebrow: 'Why Kortix',
  title: ['You’ve tried the AI tools.', 'The work is still there.'],
  description:
    'ChatGPT, Claude, Zapier, an AI in Slack — you’re already using AI. You’re also still doing the work. Kortix does it.',
  otherLabel: 'Other AI tools',
  kortixLabel: 'Kortix',
  rows: [
    { job: 'Audit your ad spend', others: 'Tells you how to do it', kortix: 'Audits it — hands you the PDF' },
    { job: 'Meeting follow-ups', others: 'Summarizes the call', kortix: 'Sends the follow-ups, updates the CRM' },
    { job: 'Workflow automation', others: 'Runs rules you write', kortix: 'Figures out what to automate — and does it' },
    { job: 'Internal tools', others: 'Writes code you finish', kortix: 'Builds it, ships it, hands you the link' },
    { job: 'Company knowledge', others: 'Forgets every session', kortix: 'Remembers — and shares it as a skill' },
    { job: 'Who owns it', others: 'Rented, closed, locked in', kortix: 'Open-source, yours to self-host' },
  ],
} as const;

export type Persona = {
  id: string;
  label: string;
  blurb: string;
  features: { title: string; body: string }[];
};

export const USE_CASES = {
  eyebrow: 'Use cases',
  title: 'What Kortix owns for your team',
  description:
    'One workforce that does the analyst work, the marketing work, and the ops work you keep putting off.',
  personas: [
    {
      id: 'founders',
      label: 'Founders & CEOs',
      blurb: 'The analyst, the assistant and the ops hire you haven’t made yet.',
      features: [
        {
          title: 'Live business pulse',
          body: 'Pulls MRR, churn, CAC, ad spend and pipeline from Stripe, PostHog and your CRM — a deck in your inbox every morning.',
        },
        {
          title: 'Investor updates on autopilot',
          body: 'Assembles revenue, burn, pipeline and headcount into a polished board deck. Monthly. You just hit send.',
        },
        {
          title: 'Internal tools in minutes',
          body: 'Builds dashboards and approval workflows as deployed web apps — no engineering tickets, no sprint planning.',
        },
      ],
    },
    {
      id: 'marketing',
      label: 'Marketing & Growth',
      blurb: 'Manages the ad accounts, writes the content, builds the pipeline — and reports on all of it.',
      features: [
        {
          title: 'Full-funnel ad intelligence',
          body: 'Pulls spend, CAC and ROAS across Meta and Google Ads, flags underperformers and drafts new copy from what’s winning.',
        },
        {
          title: 'Content engine',
          body: 'Writes SEO posts, launch copy, emails and social drafts — publishes to your CMS or GitHub, on any schedule.',
        },
        {
          title: 'Pipeline builder',
          body: 'Sources ICP leads, enriches them, pushes to your CRM and activates outbound sequences. Hands-free.',
        },
      ],
    },
    {
      id: 'engineering',
      label: 'Engineering',
      blurb: 'Writes code, opens PRs, triages bugs and builds internal tools — so your team works on what matters.',
      features: [
        {
          title: 'Intelligent bug triage',
          body: 'Monitors support channels, groups duplicates, cross-references the codebase and opens scoped tickets with repro steps.',
        },
        {
          title: 'Code contributions',
          body: 'Clones the repo, writes fixes on a branch, opens pull requests with full context and drafts release notes.',
        },
        {
          title: 'Full-stack internal tools',
          body: 'Builds and deploys dashboards and admin panels with database, auth and hosting — zero backlog added.',
        },
      ],
    },
    {
      id: 'ops',
      label: 'Ops & Finance',
      blurb: 'Kills the spreadsheet wrangling, vendor chasing and report building that eats your team alive.',
      features: [
        {
          title: 'Board pack assembly',
          body: 'Pulls from Stripe, your CRM and Sheets into a polished investor update — revenue, burn, pipeline, KPIs. Monthly, zero manual assembly.',
        },
        {
          title: 'Document & invoice processing',
          body: 'Reads invoices and contracts, matches line items against agreements, flags anomalies and queues them for review.',
        },
        {
          title: 'Cross-team automation',
          body: 'Tracks missing inputs, nudges owners in Slack, syncs data between tools on schedule and closes the loop.',
        },
      ],
    },
  ] satisfies Persona[],
} as const;

export const MOAT = {
  eyebrow: 'Own the whole stack',
  title: 'Owning your AI infrastructure is a competitive advantage',
  description:
    'Using AI well is now a core business need. The obvious question is why not just buy it. Three reasons to own it instead.',
  reasons: [
    {
      title: 'Internal productivity is a moat',
      body: 'The companies that make every employee effective with AI move faster and compound advantages competitors can’t match. That makes your AI infrastructure part of your moat — and you don’t hand your moat to a vendor.',
    },
    {
      title: 'Open source, by design',
      body: 'Kortix is open source and yours to run. Self-host in one command, on your own infra, with your own models. Nothing phones home. You own the data, the agents, the skills and the repo itself.',
    },
    {
      title: 'Ship at your own speed',
      body: 'When you own the tool you see exactly where people get stuck — and ship the fix the same day, not on a vendor’s roadmap. No lock-in: switch hosts whenever you want.',
    },
  ],
} as const;

export const FAQ = {
  eyebrow: 'FAQ',
  title: 'Questions, answered',
  items: [
    {
      q: 'What is Kortix, exactly?',
      a: 'The open-source platform for your company’s AI workforce. Every employee gets AI coworkers — each with its own cloud computer — that connect to your tools and ship real work. Not a chatbot: a workforce you own.',
    },
    {
      q: 'How is it different from ChatGPT or an AI in Slack?',
      a: 'Those answer questions. Kortix does the work end to end — pulling from your tools and delivering real output — then turns how you work into shareable skills the whole company inherits.',
    },
    {
      q: 'Can we self-host it?',
      a: 'Yes. Kortix is open source. Self-host in one command, on your own infra, with your own models. Nothing phones home.',
    },
    {
      q: 'What can it connect to?',
      a: '3,000+ apps out of the box, plus any MCP, HTTP, OpenAPI or GraphQL connector. Connected once, shared securely across the org.',
    },
    {
      q: 'Which models can we use?',
      a: 'Any. Bring your own keys or subscriptions — Claude, GPT, Gemini, open models, even your own. One gateway, full cost tracking.',
    },
    {
      q: 'Is it secure?',
      a: 'Every session runs in an isolated sandbox; secrets are injected at boot and never exposed to agents; every tool call is logged. SSO + RBAC. SOC 2 in progress.',
    },
  ],
} as const;

export const CLOSING = {
  eyebrow: 'What we believe',
  title: ['We don’t lower the ceiling.', 'We raise the floor.'],
  description:
    'The people who get the most value aren’t the ones who sat through training — they’re the ones who installed a skill on day one and got a result. Give everyone their own AI coworker, and watch the floor rise for your whole company at once.',
  primaryCta: 'Get started',
  secondaryCta: 'Talk to sales',
  footnote: 'Open source · Free to self-host · Managed cloud from $20/mo',
} as const;

/** Kept for the standalone principles section (not in the current motion). */
export const PRINCIPLES = {
  eyebrow: 'The principles',
  title: 'Everyone can be an AI power user',
  description:
    'The default move for non-technical users is to simplify: put it on rails, offer fewer options, lower the ceiling. We do the opposite. Three principles hold the whole product together.',
  cards: [
    {
      n: '01',
      title: 'Don’t limit anyone’s upside',
      body: 'Power users thrive on multi-window workflows, deep integrations, scheduled automations, persistent memory and reusable skills. We don’t strip that away — we make it invisible while keeping every bit of the capability.',
    },
    {
      n: '02',
      title: 'One breakthrough becomes everyone’s baseline',
      body: 'The biggest failure mode isn’t that people can’t figure things out — it’s that they figure it out alone. Kortix compounds individual wins into organizational capability: shared skills, propagated best practice, a floor that rises with every discovery.',
    },
    {
      n: '03',
      title: 'The product is the enablement',
      body: 'Becoming great with AI is a skill you build by doing. No workshop beats a targeted nudge in the moment — the right skill surfaced at the right time, showing what “good” looks like while you’re already in the work.',
    },
  ],
} as const;
