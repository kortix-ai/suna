/**
 * Copy for the AI OS marketing system: the home page and `/ai-os`.
 *
 * Plain English lives here first, like `landing/content.ts`. Wire i18n keys
 * once the copy is locked.
 *
 * Category = "AI Operating System" (D10). Every claim traces to a row in the
 * `kortix-brand` claims file. No customer names, no metrics except the star
 * count and "3,000+ apps", no certification beyond "SOC 2 Type I is held".
 */

export const announcement = {
  label: 'The leading open-source alternative to Claude Cowork and ChatGPT Work',
  cta: 'Read the launch',
  href: '/launch',
} as const;

export const osHero = {
  title: 'The open-source AI Operating System',
  sub: 'Your agents, their skills, your company memory and every connector in one git repo you own. Any model, self-hosted or cloud.',
  primary: { label: 'Get started free', href: '/auth' },
  secondary: { label: 'Book a demo' },
} as const;

export const logoWall = {
  title: 'Any model. 3,000+ apps. One operating system.',
} as const;

/** Cards come from the role registry: each shows that role page's own hero
 *  line and its own sample artifact, so no claim is retyped here. */
export const workCarousel = {
  title: 'Real work, finished. Not a chat window.',
} as const;

export const statement =
  'Kortix brings your agents, your people and every tool into one repo you own, and puts each agent to work on its own cloud computer.';

/** The layer's parts, in the order the lattice types them. Each is a product
 *  noun from the glossary. */
export const osLayer = {
  mark: 'AI OS',
  title: 'One operating system for agents, people and the work between them.',
  cta: { label: 'Explore the AI OS', href: '/ai-os' },
  tags: ['Agents', 'Skills', 'Memory', 'Connectors', 'Secrets', 'Triggers', 'Channels', 'Sessions', 'Change requests', 'CLI'],
  cards: [
    {
      title: 'A cloud computer for every session.',
      body: 'One isolated sandbox per session. Each session has its own isolated machine and branch.',
      cta: 'See the computer',
      href: '/agent-computer',
      art: 'beams',
    },
    {
      title: 'Your company, as code you own.',
      body: 'Agents, skills, memory and connectors are files in one git repo. Versioned, reviewable, portable.',
      cta: 'Explore company as code',
      href: '/company-as-code',
      art: 'neuro',
    },
  ],
} as const;

/** Real screenshots from `public/media/film` (synthetic Northwind data). */
export const productTabs = {
  title: 'Everything a company runs on, in one place.',
  tabs: [
    {
      id: 'agents',
      label: 'Agents',
      title: 'A workforce, not one assistant.',
      body: 'Each agent is a file: what it knows, what it can reach and when it runs. Thousands of agents in parallel on one config, each on its own cloud computer.',
      href: '/agents-and-skills',
      image: '/media/film/agents.webp',
    },
    {
      id: 'connectors',
      label: 'Connectors',
      title: '3,000+ apps in a click.',
      body: 'Plus MCP, OpenAPI, Postman, GraphQL and raw HTTP. Connector credentials are brokered server-side and never enter the machine.',
      href: '/connectors',
      image: '/media/film/agent-connectors.webp',
    },
    {
      id: 'rules',
      label: 'Tool rules',
      title: 'Allow, Ask or Block, per tool.',
      body: 'Set rules down to the arguments of each call. An Ask holds the call until a person approves it, then the agent resumes.',
      href: '/connectors',
      image: '/media/film/tool-rules.webp',
    },
    {
      id: 'approvals',
      label: 'Approvals',
      title: 'Nothing merges itself.',
      body: 'Session work reaches main through a change request. Merge is default-deny for agents.',
      href: '/company-as-code',
      image: '/media/film/approval.webp',
    },
    {
      id: 'secrets',
      label: 'Secrets',
      title: 'Secrets with an audience.',
      body: 'Secrets are encrypted at rest with a key per project. You choose who can use each one: everyone in the project, only you, or specific people and groups.',
      href: '/security',
      image: '/media/film/agent-secrets.webp',
    },
    {
      id: 'audit',
      label: 'Audit',
      title: 'Every action is recorded.',
      body: 'Per-resource permissions for people and agents. Roles, groups, and an audit trail.',
      href: '/enterprise',
      image: '/media/film/audit.webp',
    },
  ],
} as const;

export const developers = {
  eyebrow: 'For developers',
  title: 'A managed cloud for your coding agents.',
  body: 'One kortix.yaml, one repo for the state that sticks. Every change request gets a preview you can open, and your local agent can start cloud sessions and go wide.',
  cta: { label: 'Read the docs', href: '/docs' },
  secondary: { label: 'Star on GitHub', href: 'https://github.com/kortix-ai/suna' },
  lines: ['$ kortix init', '$ kortix ship'],
} as const;

/** Mirrors the "built for the enterprise" rows. Each line is a claims row,
 *  shortened by deletion only. */
export const enterpriseRows = {
  title: 'Built to survive a security review.',
  sub: 'Isolation, permissions, audit and approval gates, on infrastructure you choose.',
  rows: [
    { title: 'Flexible deployment', body: 'Run it on Kortix Cloud, in your VPC, or on your own on-prem network. Self-host is free.' },
    { title: 'Isolation', body: 'One isolated sandbox per session. Connector credentials never enter the machine.' },
    { title: 'Identity and access', body: 'SAML 2.0 single sign-on and SCIM 2.0. Per-resource permissions for people and agents.' },
    { title: 'Compliance', body: 'SOC 2 Type I is held. SOC 2 Type II is in progress. GDPR is a posture we run, not a certificate.' },
  ],
  cta: { label: 'Visit the security page', href: '/security' },
} as const;

/** Plan rows read `PRICING_PLANS` directly, so no price is retyped here. */
export const plans = {
  title: 'Start free. Pay per seat when the team joins.',
  more: { label: 'Compare plans', href: '/pricing' },
} as const;

export const team = {
  title: 'The team building the AI OS.',
  body: 'A small team in Belgrade and San Francisco, building in the open.',
  cards: [
    { title: 'About us', href: '/about' },
    { title: 'Careers', href: '/careers' },
  ],
} as const;

export const closing = {
  title: 'Run your company on the AI OS.',
  primary: { label: 'Get started free', href: '/auth' },
  secondary: { label: 'Book a demo' },
} as const;

/* ─────────────────────────────── /ai-os ─────────────────────────────── */

export const aiOsHero = {
  mark: 'AI OS',
  title: 'One operating system for your agents, your people and your tools.',
  sub: 'Agents, skills, memory, connectors and computers in one git repo you own. Open source, any model, self-hosted or cloud.',
  primary: { label: 'Get started free', href: '/auth' },
  secondary: { label: 'Book a demo' },
} as const;

/** The stack, top to bottom. Each body is a claims row, shortened by deletion. */
export const aiOsLayers = {
  title: 'Every layer a company runs on, in one repo.',
  layers: [
    {
      id: 'governance',
      name: 'Permissions and change requests',
      body: 'Per-resource permissions for people and agents. Session work reaches main through a change request. Merge is default-deny for agents.',
    },
    {
      id: 'channels',
      name: 'Channels and triggers',
      body: 'Slack and Microsoft Teams are live. Triggers run on a cron schedule or a signed webhook. Work runs on demand, human-assisted or automated.',
    },
    {
      id: 'agents',
      name: 'Agents and skills',
      body: 'An agent is a markdown file plus its block in kortix.yaml. A skill is the markdown that encodes how your company does one job.',
    },
    {
      id: 'memory',
      name: 'Memory',
      body: 'Memory is markdown files next to your code, cloned into every session, readable by a person and editable by an agent.',
    },
    {
      id: 'connectors',
      name: 'Connectors and secrets',
      body: '3,000+ apps in a click. Connector credentials never enter the machine. Secrets are encrypted at rest with a key per project.',
    },
    {
      id: 'models',
      name: 'Models',
      body: 'Any model provider with your own keys. Or the ChatGPT plan you already pay for.',
    },
    {
      id: 'computers',
      name: 'Computers',
      body: 'One isolated sandbox per session. Each session has its own isolated machine and branch.',
    },
  ],
} as const;

export const aiOsProducts = {
  title: 'Run the whole company on one platform.',
  cards: [
    { title: 'Agents & Skills', body: 'A workforce that compounds what it learns.', href: '/agents-and-skills', image: '/media/os/neuro-dark.webp' },
    { title: 'Agent Computer', body: 'An isolated cloud computer for every session.', href: '/agent-computer', image: 'beams' },
    { title: 'Connectors', body: '3,000+ apps through one scoped token.', href: '/connectors', image: '/media/connectors/connector-catalogue.webp' },
  ],
} as const;

/** One idea per row: what a single, open layer gives you that separate tools
 *  cannot. Each body is a claims row or a message-house pillar. */
export const aiOsAdvantages = {
  title: 'Why one open layer beats a stack of AI tools.',
  sub: 'Separate AI tools each keep their own copy of your context, your permissions and your keys. One operating system keeps one.',
  items: [
    { title: 'Any model', body: 'Any model provider with your own keys. Nothing you build is tied to one lab.' },
    { title: 'Set up once', body: 'Connectors, secrets and permissions are declared once in the repo, and every agent uses them.' },
    { title: 'Shared memory', body: 'Specialist agents run in parallel and compound one shared memory.' },
    { title: 'One place to govern', body: 'Per-resource permissions for people and agents. Roles, groups, and an audit trail.' },
    { title: 'It improves itself', body: 'An agent can edit its own configuration on its session branch and propose the change. A person approves it.' },
    { title: 'Open and yours', body: 'Open source. Read it, fork it, audit it. Self-host is free.' },
  ],
} as const;
