/**
 * Copy for the revamped marketing surface.
 *
 * Plain English on purpose — it stays out of `apps/web/translations/*.json` until the
 * wording is locked, so it can iterate without paying the 8-locale parity gate.
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
        title: 'Platform',
        items: [
          {
            name: 'Cloud agents',
            description: 'Run any agent in a sandbox you control',
            href: '/v2#infrastructure',
          },
          {
            name: 'Self-hosted',
            description: 'Run Kortix on your own infrastructure',
            href: '/v2#self-host',
          },
          {
            name: 'Security',
            description: 'Encryption, isolation, and SOC 2',
            href: '/v2#security',
          },
          { name: 'Enterprise', description: 'SSO, RBAC, and audit trails', href: '/enterprise' },
        ],
      },
      {
        title: 'Capabilities',
        items: [
          {
            name: 'Automations',
            description: 'Kick off agent work from any event',
            href: '/v2#automations',
          },
          {
            name: 'Sandboxes',
            description: 'Isolated cloud environments for every run',
            href: '/v2#sandboxes',
          },
          {
            name: 'Connectors',
            description: 'Slack, GitHub, Linear, Drive, and 3,000+ more',
            href: '/v2#connectors',
          },
          {
            name: 'Marketplace',
            description: 'Agents and skills built by the community',
            href: '/marketplace',
          },
        ],
      },
    ],
    footer: {
      label: 'Kortix CLI',
      description: 'Run your agents from the terminal',
      cta: 'Install',
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
            description: 'Ship fixes, reviews, and migrations',
            href: '/use-cases',
          },
          {
            name: 'Support',
            description: 'Triage and answer from your own docs',
            href: '/use-cases',
          },
          {
            name: 'Operations',
            description: 'Run the recurring work on a schedule',
            href: '/use-cases',
          },
        ],
      },
      {
        title: 'By outcome',
        items: [
          {
            name: 'Company as code',
            description: 'Every agent and permission is a file',
            href: '/v2#stack',
          },
          {
            name: 'Agent workforce',
            description: 'Many agents, one shared main branch',
            href: '/v2#many-agents',
          },
          {
            name: 'Customer stories',
            description: 'How teams run Kortix in production',
            href: '/use-cases',
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
          { name: 'About', description: 'Who we are and why', href: '/about' },
          { name: 'Careers', description: 'Build the company OS with us', href: '/careers' },
          { name: 'Contact', description: 'Talk to the team', href: '/contact' },
        ],
      },
      {
        title: 'Keep up',
        items: [
          { name: 'Blog', description: 'Notes from the build', href: '/blog' },
          { name: 'Changelog', description: 'What shipped, every week', href: '/changelog' },
          {
            name: 'Open source',
            description: 'The repo behind the product',
            href: 'https://github.com/kortix-ai/suna',
          },
        ],
      },
    ],
  },
  { name: 'Pricing', href: '/pricing' },
  { name: 'Docs', href: '/docs' },
];

/* ── 1. hero ─────────────────────────────────────────────────────────────── */

export const HERO = {
  headline: ['Give your company', 'a workforce of agents'],
  subline: 'Run agents across your repos, tools, and inboxes, with full visibility.',
  primaryCta: 'Contact Sales',
  secondaryCta: 'Get Started',
};

/* ── 2. logo wall ────────────────────────────────────────────────────────── */

export const LOGOS = ['Veyris', 'Essentia', 'Northstar', 'Collabrios', 'Conduit', 'Integral'];

/* ── 3. the stack ────────────────────────────────────────────────────────── */

export const STACK = {
  layers: [
    {
      name: 'Large language models',
      description:
        'Run any frontier model and switch between them as they improve. Kortix stays model-agnostic, so every agent uses the best model for the task at hand.',
    },
    {
      name: 'Agent harness',
      description:
        'Claude Code, Codex, OpenCode, or Gemini — the harness is a setting, not a rewrite. Swap it per agent without touching a workflow.',
    },
    {
      name: 'Cloud runtime',
      description:
        'Every run gets a real sandbox with your repo, dependencies, and network. Sessions start in seconds and pause, resume, or hand off at any time.',
    },
    {
      name: 'Context & connectors',
      description:
        'Slack, GitHub, Linear, Drive, Notion, and 3,000+ more. Agents read the same tickets, threads, and docs your team does.',
    },
    {
      name: 'Your company as code',
      description:
        'Every agent, skill, permission, and secret is a file in one repo you own — reviewable, reversible, and diffable like any other change.',
    },
    {
      name: 'Surfaces & automation',
      description:
        'Web, desktop, mobile, Slack, CLI, and API. Kick off work from a schedule, a webhook, or an @mention where the work already happens.',
    },
    {
      name: 'Security & governance',
      description:
        'SSO, RBAC, scoped credentials, and an audit trail for every session — human-started or agent-started.',
    },
    {
      name: 'Kortix',
      description:
        'Every layer above brought together in one platform your team owns, deploys, and scales end-to-end, from model to production. That is Kortix.',
    },
  ],
};

/* ── 4. infrastructure layer ─────────────────────────────────────────────── */

export const INFRA = {
  heading: ['The infrastructure layer', 'for your favorite agents.'],
  subheading:
    'You bring the agents, we provide the platform. Parallelize work, collaborate with your teammates, and automate the rest on Kortix.',
  steps: [
    {
      name: 'Context',
      description:
        'Kortix connects to your source code, tickets, alerts, and documentation to give agents the context they need.',
    },
    {
      name: 'Execution',
      description:
        'Every run happens in an isolated cloud sandbox with your repo, tools, and dependencies already in place.',
    },
    {
      name: 'Output',
      description:
        'Work lands as a branch, a pull request, a document, or a message — wherever your team already reviews it.',
    },
    {
      name: 'Approval',
      description:
        'Nothing merges without a human. Review, iterate, and approve every change before it reaches main.',
    },
  ],
};

/* ── 5. self-host ────────────────────────────────────────────────────────── */

export const SELF_HOST = {
  heading: ['Self-host Kortix in', 'your infrastructure'],
  cta: 'Explore self-hosted',
  description:
    'Deploy Kortix inside your own infrastructure, so your data, repos, connectors, and access policies stay within your environment.',
  checks: [
    'Feels local. Runs in the cloud.',
    'Pause, resume, share, or hand off anytime.',
    'Use the same agents, models, and workflows.',
    'Open source, with no vendor lock-in.',
  ],
  cards: [
    {
      name: 'Regulated industries',
      description: 'Financial services, healthcare, and government organizations.',
    },
    {
      name: 'Security-first teams',
      description: 'Companies that cannot send source code to third-party environments.',
    },
    {
      name: 'Any cloud provider',
      description: 'Organizations operating within their own AWS, Azure, or GCP environments.',
    },
    {
      name: 'Isolated environments',
      description: 'Teams in fully isolated networks with no public internet access.',
    },
  ],
  footerLabel: ['Deploy Kortix in the environment', 'you already trust'],
};

/* ── 6. tag @kortix ──────────────────────────────────────────────────────── */

export const TAG = {
  heading: ['Tag @Kortix where', 'the work is happening'],
  subheading:
    'From Slack, Linear, GitHub, the desktop app, mobile, or the web. Kortix runs agents in the background and pings your team when there is output to review.',
  integrationsLabel: '+3,000 connectors',
  caption: ['Triggers, context, and output from Slack,', 'Linear, GitHub, Sentry, Drive, and more.'],
  cta: 'View all connectors',
};

/* ── 7. agents shouldn't become your platform ────────────────────────────── */

export const NOT_PLATFORM = {
  heading: ["Agents shouldn't", 'become your platform'],
  description:
    "Models, harnesses, and vendors will change. Your workflows shouldn't. Use Claude Code, Codex, OpenCode, or whatever comes next. Kortix gives teams a stable system while the agent layer evolves underneath.",
  bullets: [
    {
      lede: 'Use agents by mention.',
      rest: 'Call on agents directly from Slack, Linear, GitHub, and more using simple @mentions.',
    },
    {
      lede: 'Swap agents with a dropdown.',
      rest: 'No contract changes, no migrations. If a new model drops tomorrow, use it today. Anthropic, OpenAI, AWS Bedrock, and more.',
    },
    {
      lede: 'Your configs work the same way.',
      rest: 'Existing agent configs, repo instructions, and local workflows work the same way in Kortix.',
    },
  ],
  harnesses: ['Claude Code', 'Codex', 'OpenCode', 'Gemini', 'Cursor', 'Amp'],
  models: ['Opus 5', 'Sonnet 5', 'GPT-5.5', 'Gemini 3 Pro', 'Grok 4'],
};

/* ── 8. sandboxes ────────────────────────────────────────────────────────── */

export const SANDBOX = {
  heading: ['Cloud development', 'environments for agents'],
  description:
    'Every session gets a real computer with your repo, tools, dependencies, network access, and context. Not a sandboxed prompt runner.',
  bullets: [
    {
      lede: 'Fast to start, pausable, resumable.',
      rest: 'Sessions spin up in seconds and can be paused, resumed, shared with teammates, or inspected at any time.',
    },
    {
      lede: 'Collaborate across the team.',
      rest: 'Involve your teammates and let them see what is running, inspect sessions, and pick up where someone else left off.',
    },
    {
      lede: 'Any size you need.',
      rest: 'Provision any sandbox size and configuration you want: up to 128GB of RAM and 500GB of disk.',
    },
  ],
  sessions: [
    { title: 'Review pull requests to identify bugs and security issues', who: 'Connor and 3 more people', running: true },
    { title: 'Retrieve organization group ID for future reference', who: 'Benja' },
    { title: 'Extract organization name anatomy', who: 'Darren and Benja' },
    { title: 'Determine charging policy for breach of contract', who: 'Benja' },
    { title: 'List all accessible MCP tools in the menu', who: 'Darren' },
  ],
};

/* ── 9. many agents ──────────────────────────────────────────────────────── */

export const MANY_AGENTS = {
  heading: ["The future isn't one", "agent. It's many."],
  description:
    'Run agents across repos, tickets, teams, and tools in parallel. Kortix keeps the work coordinated, visible, and reviewable.',
  bullets: [
    {
      lede: 'Foreground development.',
      rest: 'Work hands-on in live cloud sessions using Claude Code, Codex, or OpenCode. Resume, share, or hand off anytime.',
    },
    {
      lede: 'Background agents.',
      rest: 'Hand off work from Slack, Linear, GitHub, schedules, or webhooks. Kortix runs it and pings your team when output is ready.',
    },
  ],
};

/* ── 10. security ────────────────────────────────────────────────────────── */

export const SECURITY = {
  heading: ['Work is moving to agents,', 'make it a platform you trust.'],
  subheading: "The blocker isn't capability. It's security, governance, compliance, and trust.",
  cta: 'More about security',
  badges: ['SOC 2 TYPE II', 'SOC 2 TYPE I', 'ISO 27001', 'ISO 42001', 'HIPAA', 'GDPR'],
  points: [
    {
      name: 'Humans approve',
      description: 'Review, iterate, and approve every change from Kortix before anything merges.',
    },
    {
      name: 'One auditable layer',
      description:
        'Every foreground session and background agent run is centrally logged, traceable, and reviewable.',
    },
    {
      name: 'Deploy inside your infrastructure',
      description:
        'Use Kortix Cloud or a self-hosted deployment. Keep code access, data, connectors, and policies under your control.',
    },
  ],
};

/* ── 11. plugs into your stack ───────────────────────────────────────────── */

export const PLUGS = {
  heading: ['Plugs into your stack.', 'Logs everything'],
  description:
    'Kortix connects to the tools your team already works in and centrally logs every session, from foreground to automations, so nothing runs without a trail.',
  cards: [
    {
      name: 'Agent templates',
      description: 'Pre-built agents for your most common workflows, ready to run.',
    },
    {
      name: 'Centralized audit logs',
      description: 'Every session, whether started by a human or an agent, is centrally logged.',
    },
    {
      name: 'Team visibility',
      description: "See what teammates are working on, instead of work hiding on a laptop.",
    },
    {
      name: 'Scoped credentials',
      description: 'Each agent gets exactly the access it needs, and nothing more.',
    },
    {
      name: 'Review before merge',
      description: 'Every change arrives as a reviewable diff your team signs off on.',
    },
  ],
  templates: [
    'Implement Linear tickets end-to-end',
    'Generate test coverage for critical flows',
    'Optimize slow database queries',
    'Audit technical debt and create a remediation plan',
  ],
  events: [
    { name: '4 participants joined session', meta: '16 hours ago' },
    { name: 'Context retrieved', meta: '' },
    { name: '3 files modified', meta: '' },
    { name: '18 tests passed', meta: '' },
    { name: 'Review completed', meta: 'Approved by Sarah' },
  ],
  contextItems: ['Slack thread (12 messages)', 'Linear issue ENG-421', 'Previous PR #184'],
};

/* ── 12. closing cta ─────────────────────────────────────────────────────── */

export const CTA = {
  heading: ['Move your company', 'onto Kortix.'],
  description:
    'Run agents across your repos, tools, and inboxes in secure shared environments. Keep every session visible, reviewable, and ready for your team to steer.',
  primary: 'Try for free',
  secondary: 'Book a demo',
};

/* ── 13. footer ──────────────────────────────────────────────────────────── */

export const FOOTER = [
  {
    title: 'Product',
    links: [
      { name: 'Cloud agents', href: '/v2#infrastructure' },
      { name: 'Automations', href: '/v2#automations' },
      { name: 'Connectors', href: '/v2#connectors' },
      { name: 'Sandboxes', href: '/v2#sandboxes' },
      { name: 'Marketplace', href: '/marketplace' },
    ],
  },
  {
    title: 'Use Cases',
    links: [
      { name: 'Code review', href: '/use-cases' },
      { name: 'Code migration', href: '/use-cases' },
      { name: 'Incident triage', href: '/use-cases' },
      { name: 'All use cases', href: '/use-cases' },
    ],
  },
  {
    title: 'Developers',
    links: [
      { name: 'Docs', href: '/docs' },
      { name: 'Changelog', href: '/changelog' },
      { name: 'GitHub', href: 'https://github.com/kortix-ai/suna' },
    ],
  },
  {
    title: 'Company',
    links: [
      { name: 'About', href: '/about' },
      { name: 'Blog', href: '/blog' },
      { name: 'Careers', href: '/careers' },
      { name: 'Contact', href: '/contact' },
      { name: 'Support', href: '/support' },
    ],
  },
  {
    title: 'Trust',
    links: [
      { name: 'Security', href: '/v2#security' },
      { name: 'Enterprise', href: '/enterprise' },
      { name: 'Self-hosted', href: '/v2#self-host' },
      { name: 'Privacy', href: '/legal?tab=privacy' },
    ],
  },
];
