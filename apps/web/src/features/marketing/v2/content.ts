/**
 * Shared chrome copy for /v2: the nav, the landing hero, the stack layers, and
 * the footer. Per-page section copy lives in `pages-content.ts`.
 *
 * Positioning follows the internal-comms hierarchy: category = Autonomous
 * Company Operating System, tagline = the AI command center for your company,
 * explainer = a cloud computer where AI agents do real work for your company.
 * Canonical product nouns only (project, session, sandbox, change request,
 * agent, skill, connector, secret, channel, trigger, memory, kortix.yaml).
 *
 * Nothing here names a customer, a metric, or a certification the product has
 * not earned.
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
            name: 'Agents',
            description: 'Markdown personas with scoped reach',
            href: '/v2/agents',
          },
          {
            name: 'Sandboxes',
            description: 'Every session on its own machine and branch',
            href: '/v2/sandboxes',
          },
          {
            name: 'Connectors',
            description: 'One scoped token into 3,000+ apps',
            href: '/v2/connectors',
          },
          {
            name: 'Automations',
            description: 'Triggers that start work on a cron or a webhook',
            href: '/v2/automations',
          },
        ],
      },
      {
        title: 'Build with it',
        items: [
          {
            name: 'Agent templates',
            description: 'Working agents for the jobs you repeat',
            href: '/v2/agent-templates',
          },
          { name: 'SDK', description: 'Kortix as a typed client', href: '/v2/sdk' },
          { name: 'MCP', description: 'Server and client, both directions', href: '/v2/mcp' },
          {
            name: 'Download',
            description: 'Web, CLI, desktop, and mobile',
            href: '/v2/download',
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
    name: 'Solutions',
    columns: [
      {
        title: 'Use cases',
        items: [
          {
            name: 'Change review',
            description: 'Every change read and risk-flagged first',
            href: '/v2/use-cases/change-review',
          },
          {
            name: 'Company digest',
            description: 'The weekly summary, from the source',
            href: '/v2/use-cases/company-digest',
          },
          {
            name: 'Support triage',
            description: 'The inbox read, grouped, and answered',
            href: '/v2/use-cases/support-triage',
          },
          {
            name: 'All use cases',
            description: 'Three jobs, handed over end to end',
            href: '/v2/use-cases',
          },
        ],
      },
      {
        title: 'For your company',
        items: [
          {
            name: 'Enterprise',
            description: 'SSO, RBAC, audit logs, and deployment',
            href: '/v2/enterprise',
          },
          {
            name: 'Security',
            description: 'Isolation, scoped credentials, approvals',
            href: '/v2/security',
          },
          {
            name: 'Self-hosted',
            description: 'Your VPC, on-prem, or air-gapped',
            href: '/v2/self-hosted',
          },
          {
            name: 'Where teams start',
            description: 'The work handed over first',
            href: '/v2/customers',
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
          { name: 'Changelog', description: 'Every release, in the open', href: '/v2/changelog' },
          {
            name: 'Open source',
            description: 'The repo behind the product',
            href: 'https://github.com/kortix-ai/suna',
          },
          { name: 'Docs', description: 'The CLI, the SDK, and kortix.yaml', href: '/docs' },
        ],
      },
    ],
  },
  { name: 'Pricing', href: '/v2/pricing' },
  { name: 'Docs', href: '/docs' },
];

/* ── landing hero ────────────────────────────────────────────────────────── */

/**
 * Shaped like the live landing hero: badge eyebrow, two-line display headline,
 * one short tracking-tight subline, then the supporting paragraph.
 */
export const HERO = {
  eyebrow: 'The Autonomous Company Operating System',
  headline: ['The AI command center', 'for a workforce of agents.'],
  subline: 'Your whole company. One repo you own.',
  description:
    'Every agent, skill, connector, and memory is a file — 3,000+ tools connected, one versioned source of truth, scoped so each person and agent has exactly the right access.',
  primaryCta: 'Get started',
  secondaryCta: 'Request demo',
};

/* ── the stack ───────────────────────────────────────────────────────────── */

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
        'Run any frontier model and switch as they improve. Every agent uses the best model for the job, or the subscription you already pay for.',
      chips: ['Claude', 'GPT', 'Gemini', 'Grok', 'Bedrock'],
    },
    {
      name: 'Agent harness',
      description:
        'The orchestration that turns a model into an agent. Claude Code, Codex, OpenCode, or Gemini is a setting, not a rewrite.',
      chips: ['Claude Code', 'Codex', 'OpenCode', 'Gemini'],
    },
    {
      name: 'Sandboxes',
      description:
        'Every session gets its own microVM-isolated Linux machine, preloaded with your repo, your tools, and your dependencies.',
    },
    {
      name: 'Connectors and memory',
      description:
        'One scoped token reaches 3,000+ apps, plus MCP, OpenAPI, GraphQL, and plain HTTP. What the company learns lands in memory.',
      chips: ['Slack', 'GitHub', 'Linear', 'Notion', 'Drive'],
    },
    {
      name: 'Your company as code',
      description:
        'Agents, skills, connectors, secrets, channels, triggers, and memory are files in one repo. Versioned, diffable, greppable.',
    },
    {
      name: 'Channels and triggers',
      description:
        'Sessions start where the work already is, and on a cron or a signed webhook when nobody asks.',
      chips: ['Slack', 'Web', 'CLI', 'API'],
    },
    {
      name: 'Security and governance',
      description:
        'Members, groups, and roles for people and agents alike, with per-resource permissions and an audit trail over all of it.',
    },
    {
      name: 'Kortix',
      description:
        'Every layer above, in one platform your team owns, deploys, and scales end to end — from the model to the merge.',
    },
  ],
};

/* ── footer ──────────────────────────────────────────────────────────────── */

export const FOOTER = [
  {
    title: 'Product',
    links: [
      { name: 'Agents', href: '/v2/agents' },
      { name: 'Sandboxes', href: '/v2/sandboxes' },
      { name: 'Connectors', href: '/v2/connectors' },
      { name: 'Automations', href: '/v2/automations' },
      { name: 'Agent templates', href: '/v2/agent-templates' },
      { name: 'Pricing', href: '/v2/pricing' },
    ],
  },
  {
    title: 'Use cases',
    links: [
      { name: 'Change review', href: '/v2/use-cases/change-review' },
      { name: 'Company digest', href: '/v2/use-cases/company-digest' },
      { name: 'Support triage', href: '/v2/use-cases/support-triage' },
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
      { name: 'Careers', href: '/v2/careers' },
      { name: 'Contact', href: '/v2/contact' },
      { name: 'Where teams start', href: '/v2/customers' },
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
