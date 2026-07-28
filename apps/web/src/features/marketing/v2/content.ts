/**
 * Copy for the revamped marketing surface.
 *
 * Positioning follows the internal-comms hierarchy: category = Autonomous Company
 * Operating System, tagline = the AI command center for your company, explainer =
 * a cloud computer where AI agents run your company. Canonical product nouns only
 * (project, session, sandbox, change request, agent, skill, connector, secret,
 * channel, trigger, memory, kortix.yaml).
 *
 * Plain English on purpose — it stays out of `apps/web/translations/*.json` until
 * the wording is locked, so it can iterate before the 8-locale parity gate.
 */

export type MenuItem = { name: string; description: string; href: string };
export type MenuColumn = { title: string; items: MenuItem[] };
export type MenuFooter = { label: string; description: string; cta: string; href: string };

export type NavEntry =
  | { name: string; href: string }
  | { name: string; columns: MenuColumn[]; footer?: MenuFooter };

/* ── nav ─────────────────────────────────────────────────────────────────── */

export const NAV: NavEntry[] = [
  {
    name: 'Product',
    columns: [
      {
        title: 'The platform',
        items: [
          {
            name: 'Projects',
            description: 'A git repo that is your company',
            href: '/v2#company-as-code',
          },
          {
            name: 'Sessions & sandboxes',
            description: 'Every run on its own machine and branch',
            href: '/v2/sandboxes',
          },
          {
            name: 'Change requests',
            description: 'How work lands, reviewed, on main',
            href: '/v2/security',
          },
          {
            name: 'Security & governance',
            description: 'Isolation, roles, secrets, audit trail',
            href: '/v2/security',
          },
        ],
      },
      {
        title: 'The building blocks',
        items: [
          {
            name: 'Agents',
            description: 'Markdown personas with scoped reach',
            href: '/v2/agents',
          },
          {
            name: 'Skills',
            description: 'How your company does a job, reusable',
            href: '/v2/agent-templates',
          },
          {
            name: 'Connectors',
            description: 'One scoped token into 3,000+ apps',
            href: '/v2/connectors',
          },
          {
            name: 'Channels & triggers',
            description: 'Start sessions from Slack, cron, or a webhook',
            href: '/v2/automations',
          },
        ],
      },
    ],
    footer: {
      label: 'Kortix CLI',
      description: 'kortix init, kortix ship — your company from the terminal',
      cta: 'Read the docs',
      href: '/docs',
    },
  },
  {
    name: 'Use Cases',
    columns: [
      {
        title: 'By team',
        items: [
          {
            name: 'Engineering',
            description: 'Background agents that open change requests',
            href: '/v2/use-cases',
          },
          {
            name: 'Go-to-market',
            description: 'Briefs, renewals, and pipeline from your own data',
            href: '/v2/use-cases',
          },
          {
            name: 'Operations',
            description: 'The recurring work, on a trigger',
            href: '/v2/use-cases',
          },
        ],
      },
      {
        title: 'By outcome',
        items: [
          {
            name: 'Your company as code',
            description: 'Agents, skills, and memory in one repo you own',
            href: '/v2/agents',
          },
          {
            name: 'A workforce, not an assistant',
            description: 'Thousands of sessions, one main branch',
            href: '/v2/sandboxes',
          },
          {
            name: 'Customer stories',
            description: 'How teams run Kortix in production',
            href: '/v2/use-cases',
          },
        ],
      },
    ],
  },
  {
    name: 'Company',
    columns: [
      {
        title: 'Kortix',
        items: [
          { name: 'About', description: 'Who we are and why', href: '/v2/about' },
          { name: 'Careers', description: 'Build the company OS with us', href: '/v2/careers' },
          { name: 'Contact', description: 'Talk to the team', href: '/v2/contact' },
        ],
      },
      {
        title: 'Keep up',
        items: [
          { name: 'Customers', description: 'Teams running Kortix in production', href: '/v2/customers' },
          { name: 'Changelog', description: 'What shipped, every week', href: '/v2/changelog' },
          {
            name: 'Open source',
            description: 'The repo behind the product',
            href: 'https://github.com/kortix-ai/suna',
          },
        ],
      },
    ],
  },
  { name: 'Pricing', href: '/v2/pricing' },
  { name: 'Docs', href: '/docs' },
];

/* ── 1. hero ─────────────────────────────────────────────────────────────── */

export const HERO = {
  eyebrow: 'The Autonomous Company Operating System',
  headline: ['The AI command center', 'for your company.'],
  subline:
    'A cloud computer where a workforce of AI agents runs your company — and everything is code you own.',
  primaryCta: 'Get started',
  secondaryCta: 'Request demo',
  logoWallLabel: 'Running in production at',
};

export const LOGOS = ['Veyris', 'Essentia', 'Northstar', 'Collabrios', 'Conduit', 'Integral'];

/* ── 2. the stack ────────────────────────────────────────────────────────── */

export type StackLayer = {
  name: string;
  description: string;
  chips?: string[];
};

export const STACK: { heading: string[]; subheading: string; layers: StackLayer[] } = {
  heading: ['One computer,', 'eight layers deep.'],
  subheading:
    'Most tools hand you a chat box on top of a model. Kortix owns the whole stack underneath it — and hands you the keys.',
  layers: [
    {
      name: 'Models',
      description:
        'Run any frontier model and switch as they improve. Kortix stays model-agnostic, so every agent uses the best model for the job — or the subscription you already pay for.',
      chips: ['Claude', 'GPT', 'Gemini', 'Grok', 'Bedrock'],
    },
    {
      name: 'Agent harness',
      description:
        'The orchestration that turns a model into an agent: planning, tool use, and multi-step runs. Claude Code, Codex, OpenCode, or Gemini — the harness is a setting, not a rewrite.',
      chips: ['Claude Code', 'Codex', 'OpenCode', 'Gemini'],
    },
    {
      name: 'Sandboxes',
      description:
        'Every session gets its own microVM-isolated Linux machine, preloaded with your repo, tools, and dependencies. Disposable by design, and nothing leaks between runs.',
    },
    {
      name: 'Connectors & memory',
      description:
        'One scoped token reaches 3,000+ apps, plus MCP, OpenAPI, GraphQL, and plain HTTP. What the company learns lands in memory, so the next session starts where the last one stopped.',
      chips: ['Slack', 'GitHub', 'Linear', 'Notion', 'Drive'],
    },
    {
      name: 'Your company as code',
      description:
        'Agents, skills, connectors, secrets, channels, triggers, and memory are files in one repo. Versioned, diffable, greppable, and owned outright.',
    },
    {
      name: 'Channels & triggers',
      description:
        'Sessions start where the work already is — Slack, Teams, WhatsApp, email, the web, the CLI, or the API — and on a cron or a signed webhook when nobody asks.',
      chips: ['Slack', 'Teams', 'WhatsApp', 'Email', 'CLI'],
    },
    {
      name: 'Security & governance',
      description:
        'Members, groups, and roles for humans and agents alike. Per-resource permissions, a secrets manager the model never sees, human approval gates, and an audit trail over all of it.',
    },
    {
      name: 'Kortix',
      description:
        'Every layer above, in one platform your team owns, deploys, and scales end-to-end — from the model to the merge. That is Kortix.',
    },
  ],
};

/* ── 3. your company as code ─────────────────────────────────────────────── */

export const AS_CODE = {
  eyebrow: 'Company as code',
  heading: ['Your whole company,', 'as files you own.'],
  description:
    'Open the repo and the company is right there. Every agent is a markdown persona, every skill is know-how your team wrote down, every connector and secret is a declared, scoped line of config. Change it with a pull request. Roll it back with a revert.',
  bullets: [
    {
      lede: 'Diff a decision.',
      rest: 'A change to how the company works reviews exactly like a change to its code.',
    },
    {
      lede: 'grep your whole company.',
      rest: 'One checkout holds every agent, skill, connector, and thing the company has learned.',
    },
    {
      lede: 'Leave whenever you want.',
      rest: 'Clone it, fork it, or run it somewhere else. There is no version of this you cannot take with you.',
    },
  ],
  tree: [
    { name: 'kortix.yaml', kind: 'file', accent: true },
    { name: 'agents/', kind: 'dir' },
    { name: 'go-to-market.md', kind: 'file', depth: 1 },
    { name: 'support-triage.md', kind: 'file', depth: 1 },
    { name: 'skills/', kind: 'dir' },
    { name: 'renewal-brief.md', kind: 'file', depth: 1 },
    { name: 'connectors/', kind: 'dir' },
    { name: 'secrets/', kind: 'dir' },
    { name: 'memory/', kind: 'dir' },
  ] as { name: string; kind: 'file' | 'dir'; depth?: number; accent?: boolean }[],
  file: {
    name: 'kortix.yaml',
    lines: [
      'sandbox:',
      '  image: kortix/base:latest',
      '  cpu: 4',
      '',
      'connectors:',
      '  - slack',
      '  - github',
      '  - linear',
      '',
      'channels:',
      '  - slack: "#company-ops"',
      '',
      'triggers:',
      '  - cron: "0 8 * * 1-5"',
      '    agent: go-to-market',
      '',
      'secrets:',
      '  - STRIPE_API_KEY',
    ],
  },
};

/* ── 4. how work lands ───────────────────────────────────────────────────── */

export const FLOW = {
  eyebrow: 'How work lands',
  heading: ['From a sentence', 'to a reviewed merge.'],
  subheading:
    'No prompt-engineering course, no copy-pasting between a chat window and your real tools. Ask in plain language and the work comes back as something your team can review.',
  steps: [
    {
      name: 'Ask',
      description:
        'Anyone on the team describes the outcome, in plain language, from Slack, the web, the CLI, or their phone.',
    },
    {
      name: 'Session',
      description:
        'Kortix boots a sandbox on its own branch, loads the agent, its skills, your connectors, and the company memory.',
    },
    {
      name: 'Change request',
      description:
        'The run ends in a reviewable diff — a document, a dashboard, a reply, or code. Never a wall of chat.',
    },
    {
      name: 'Merge to main',
      description:
        'A human approves, it merges, and the company gets a little better. What was learned stays in memory.',
    },
  ],
};

/* ── 5. channels ─────────────────────────────────────────────────────────── */

export const CHANNELS = {
  eyebrow: 'Channels',
  heading: ['Start work where', 'your team already is.'],
  subheading:
    'From Slack, Teams, WhatsApp, email, the desktop app, or the web. Kortix runs agents in the background and pings your team when there is output to review.',
  integrationsLabel: '+3,000 connectors',
  caption: [
    'Triggers, context, and output from Slack, Teams,',
    'GitHub, Linear, Notion, Drive, Stripe, and more.',
  ],
  cta: 'View all connectors',
  surfaces: [
    { name: 'Slack', note: 'Tag @Kortix in any channel' },
    { name: 'Microsoft Teams', note: 'Same agents, same permissions' },
    { name: 'WhatsApp & SMS', note: 'For the people who never open a dashboard' },
    { name: 'Email', note: 'Forward a thread, get the work back' },
    { name: 'Web & desktop', note: 'The full command center' },
    { name: 'CLI & API', note: 'kortix sessions new, or the SDK' },
  ],
  slack: {
    channel: '#company-ops',
    ask: '@Kortix what changed in the business since Monday?',
    answerLead: "Here's what changed since Monday:",
    answer: [
      '14 change requests merged · 3 need your review',
      'Stripe revenue +$3,482',
      '2 enterprise leads replied',
      'Renewal drafted for Acme — waiting on sign-off',
    ],
    tail: 'Want the full report?',
  },
};

/* ── 6. workforce ────────────────────────────────────────────────────────── */

export const WORKFORCE = {
  eyebrow: 'A workforce, not an assistant',
  heading: ['Thousands of agents.', 'One main branch.'],
  description:
    'An assistant does one thing at a time and forgets it happened. A workforce runs in parallel, in isolation, against one shared config — and every finished run pushes the company forward.',
  bullets: [
    {
      lede: 'Every session is isolated.',
      rest: 'Its own microVM, its own branch. One agent cannot break another, and nothing bleeds between runs.',
    },
    {
      lede: 'They all share one config.',
      rest: 'Update a skill once and every agent in the company picks it up on the next session.',
    },
    {
      lede: 'Work compounds.',
      rest: 'Each merged change request improves the repo the next session starts from. The company gets better, not just busier.',
    },
  ],
  sessions: [
    { title: 'Draft the renewal for Acme', agent: 'go-to-market', state: 'running' },
    { title: 'Triage 42 new support threads', agent: 'support-triage', state: 'running' },
    { title: 'Reconcile the Stripe payouts for July', agent: 'finance-ops', state: 'review' },
    { title: 'Fix the flaky onboarding e2e test', agent: 'platform', state: 'merged' },
    { title: 'Weekly revenue digest for #company-ops', agent: 'go-to-market', state: 'merged' },
  ] as { title: string; agent: string; state: 'running' | 'review' | 'merged' }[],
};

/* ── 7. the library ──────────────────────────────────────────────────────── */

export const LIBRARY = {
  eyebrow: 'Agents, skills, connectors',
  heading: ['Hire an agent the same', 'way you install a package.'],
  subheading:
    'Start from the marketplace or write your own. Everything installs into your repo as files, so you can read it, edit it, and review what changed.',
  cards: [
    {
      title: 'Agents',
      body: 'A markdown persona with a scoped reach into tools. Installable, forkable, and able to rewrite itself through a change request.',
      items: ['go-to-market', 'support-triage', 'finance-ops', 'platform'],
    },
    {
      title: 'Skills',
      body: 'Reusable know-how for how your company does a job. Written once, it rides into every session that needs it.',
      items: ['renewal-brief', 'incident-postmortem', 'weekly-digest', 'pricing-review'],
    },
    {
      title: 'Connectors',
      body: 'One-click reach into 3,000+ apps, plus MCP, OpenAPI, GraphQL, and HTTP — all through one scoped token.',
      items: ['Slack', 'GitHub', 'Linear', 'Notion', 'Drive', 'Stripe'],
    },
  ],
};

/* ── 8. sandboxes ────────────────────────────────────────────────────────── */

export const SANDBOX = {
  eyebrow: 'Sandboxes',
  heading: ['Every session gets', 'a real computer.'],
  description:
    'Not a sandboxed prompt runner. A microVM-isolated Linux machine with your repo, your dependencies, network access, and the context the job needs.',
  bullets: [
    {
      lede: 'Fast to start, pausable, resumable.',
      rest: 'Sessions boot in seconds and can be paused, resumed, shared with a teammate, or inspected at any point.',
    },
    {
      lede: 'Any size you need.',
      rest: 'Provision the CPU, memory, and disk the work actually needs, and declare it in kortix.yaml so every run is reproducible.',
    },
    {
      lede: 'Disposable by design.',
      rest: 'The machine is torn down when the session ends. What survives is the change request and what the company learned.',
    },
  ],
  terminal: [
    '$ kortix sessions new --prompt "draft the renewal for Acme"',
    '✓ sandbox booted · 4 vCPU · 8 GB · microVM',
    '✓ connectors mounted · slack, github, stripe',
    '✓ skills loaded · renewal-brief',
    '→ branch session/renewal-acme',
    '',
    '  reading  crm · last 3 calls with Acme',
    '  reading  memory/accounts/acme.md',
    '  writing  sales/renewals/acme.md',
    '',
    '✓ change request opened · needs 1 approval',
  ],
};

/* ── 9. security ─────────────────────────────────────────────────────────── */

export const SECURITY = {
  eyebrow: 'Security & governance',
  heading: ['Built to survive', 'a security review.'],
  subheading:
    "The models are ready. Isolation, permissions, and ownership are the part that isn't — so that is the part Kortix built.",
  cta: 'Read about security',
  badges: ['SOC 2 TYPE II', 'SOC 2 TYPE I', 'ISO 27001', 'ISO 42001', 'HIPAA', 'GDPR'],
  points: [
    {
      name: 'Humans approve',
      description:
        'Every change request needs a person before it merges. Approval gates are part of the model, not a setting someone forgot.',
    },
    {
      name: 'Secrets the model never sees',
      description:
        'Encrypted, scoped credentials are injected into the sandbox at runtime. They never enter a prompt and never reach the model.',
    },
    {
      name: 'Members, groups, roles',
      description:
        'Humans and agents are both principals, with per-resource permissions and an audit trail across every session.',
    },
  ],
};

/* ── 10. open & yours ────────────────────────────────────────────────────── */

export const OPEN = {
  eyebrow: 'Open, and yours',
  heading: ['Run it on our cloud,', 'or on your own metal.'],
  description:
    'Kortix is open source. Deploy it inside your own VPC, on-prem, or fully air-gapped, and keep the data, the config, and the model choice on your side of the line.',
  checks: [
    'Feels as simple as chat, with code underneath.',
    'Same agents, skills, and connectors either way.',
    'Your data, your config, your model choice.',
    'Clone the repo and walk away whenever you want.',
  ],
  cards: [
    {
      name: 'Regulated industries',
      description: 'Financial services, healthcare, and government organizations.',
    },
    {
      name: 'Security-first teams',
      description: 'Companies that cannot send their data to a third-party environment.',
    },
    {
      name: 'Any cloud provider',
      description: 'Organizations operating inside their own AWS, Azure, or GCP accounts.',
    },
    {
      name: 'Air-gapped networks',
      description: 'Teams in fully isolated environments with no public internet access.',
    },
  ],
  clouds: ['AWS', 'Google Cloud', 'Azure', 'On premise'],
  footerLabel: ['Deploy Kortix in the environment', 'you already trust'],
};

/* ── 11. closing cta ─────────────────────────────────────────────────────── */

export const CTA = {
  heading: ['Give your company', 'a workforce of agents.'],
  description:
    'Start with one project, one agent, and one change request. Keep every byte of the company you build on the way there.',
  note: 'Free to self-host · Managed cloud from $20 · SSO, RBAC, on-prem · No lock-in',
  primary: 'Get started',
  secondary: 'Request demo',
};

/* ── 12. footer ──────────────────────────────────────────────────────────── */

export const FOOTER = [
  {
    title: 'Product',
    links: [
      { name: 'Agents', href: '/v2/agents' },
      { name: 'Sandboxes', href: '/v2/sandboxes' },
      { name: 'Connectors', href: '/v2/connectors' },
      { name: 'Automations', href: '/v2/automations' },
      { name: 'Agent templates', href: '/v2/agent-templates' },
    ],
  },
  {
    title: 'Use Cases',
    links: [
      { name: 'Engineering', href: '/v2/use-cases' },
      { name: 'Go-to-market', href: '/v2/use-cases' },
      { name: 'Operations', href: '/v2/use-cases' },
      { name: 'All use cases', href: '/v2/use-cases' },
    ],
  },
  {
    title: 'Developers',
    links: [
      { name: 'Docs', href: '/docs' },
      { name: 'SDK', href: '/v2/sdk' },
      { name: 'MCP', href: '/v2/mcp' },
      { name: 'Download', href: '/v2/download' },
      { name: 'Changelog', href: '/v2/changelog' },
      { name: 'GitHub', href: 'https://github.com/kortix-ai/suna' },
    ],
  },
  {
    title: 'Company',
    links: [
      { name: 'About', href: '/v2/about' },
      { name: 'Customers', href: '/v2/customers' },
      { name: 'Careers', href: '/v2/careers' },
      { name: 'Contact', href: '/v2/contact' },
      { name: 'Support', href: '/support' },
    ],
  },
  {
    title: 'Trust',
    links: [
      { name: 'Security', href: '/v2/security' },
      { name: 'Enterprise', href: '/v2/enterprise' },
      { name: 'Self-hosted', href: '/v2/self-hosted' },
      { name: 'Privacy', href: '/legal?tab=privacy' },
    ],
  },
];
