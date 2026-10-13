/**
 * `/product` copy — the AI Operating System on one page.
 *
 * This page replaces nine: Agent Computer, Agents & Skills, Company as Code,
 * Connectors, Channels, Automations, Security, Self-hosted and Enterprise.
 * Their URLs redirect to the four sections below (`next.config.ts`). Their
 * content modules stay: the decks and the security page diagrams import them.
 *
 * Plain English, no i18n keys yet: the copy is a draft for founder review.
 *
 * ── ACCURACY ─────────────────────────────────────────────────────────────
 * Every capability sentence takes the words of a row in
 * `.agents/skills/kortix-brand/references/verbal/claims.md`:
 *  - One isolated sandbox per session; "its own isolated machine", never
 *    "microVM" or "container".
 *  - Connector credentials (not every secret) never enter the machine.
 *  - Approval gates are off until you set them. Merge is default-deny for
 *    agents.
 *  - Triggers are cron and webhook. Channels are Slack and Microsoft Teams.
 *  - SAML 2.0 and SCIM 2.0. SOC 2 Type I is held, Type II is in progress.
 *  - No outbound-network allow-list claim: not shipped.
 */

export const hero = {
  eyebrow: 'Product',
  title: 'The AI Operating System for AI-native companies.',
  sub: 'Agents that do real work for every team. Each one runs on its own cloud computer, works in the tools you already use, and lives as code in one repo you own. Any model, your keys, our cloud or yours.',
  ctaPrimary: 'Get started',
  ctaPrimaryHref: '/auth',
  ctaSecondary: 'Book a demo',
  ctaSecondaryHref: '/contact',
} as const;

/** The four parts. The ids are the anchors the nav menu links to. */
export const parts = [
  {
    id: 'agents',
    eyebrow: '01 · Agents',
    title: 'Agents that do the work, not the chat.',
    sub: 'An agent is a file in your repo: its instructions, its skills and what it may touch. Every session gets its own cloud computer, so the agent can install, run and build what a person at a computer can.',
    points: [
      {
        id: 'computer',
        k: 'Its own computer',
        v: 'One isolated sandbox per session. Each session has its own isolated machine and branch.',
      },
      {
        id: 'skills',
        k: 'Skills',
        v: 'How your company does a job, written down once and used by every agent that needs it.',
      },
      {
        id: 'memory',
        k: 'Memory',
        v: 'What the company learns lives in the repo, next to the agents that read it.',
      },
      {
        id: 'parallel',
        k: 'At scale',
        v: 'Thousands of agents in parallel on one config, each on its own cloud computer.',
      },
    ],
  },
  {
    id: 'connect',
    eyebrow: '02 · Connect everything',
    title: 'Your tools, your channels, one place.',
    sub: '3,000+ apps in a click, plus MCP, OpenAPI, Postman, GraphQL and raw HTTP. People reach the same agents from the web app, Slack and Microsoft Teams.',
    points: [
      {
        id: 'apps',
        k: 'Connectors',
        v: '3,000+ apps in a click, plus MCP, OpenAPI, Postman, GraphQL and raw HTTP.',
      },
      {
        id: 'creds',
        k: 'Credentials',
        v: 'Connector credentials are brokered server-side and never enter the machine.',
      },
      {
        id: 'channels',
        k: 'Slack and Teams',
        v: 'Add Kortix to Slack or Microsoft Teams, invite the bot, mention it with a task.',
      },
      {
        id: 'shared',
        k: 'Shared',
        v: 'Share an agent, a connection or a skill with one person, a team or the whole company.',
      },
    ],
  },
  {
    id: 'automate',
    eyebrow: '03 · Runs on its own',
    title: 'Work that starts without anyone asking.',
    sub: 'A schedule or a webhook starts a session with nobody at the keyboard. You decide which actions stop and wait for a person.',
    points: [
      {
        id: 'triggers',
        k: 'Triggers',
        v: 'Cron schedules and signed webhooks. On demand, human-assisted, automated.',
      },
      {
        id: 'gates',
        k: 'Approval',
        v: 'Allow, Ask or Block on every connector action, down to the arguments of each call. Approval gates you set. Off until you set them.',
      },
      {
        id: 'cr',
        k: 'Change requests',
        v: 'Session work reaches main through a change request. Merge is default-deny for agents.',
      },
      {
        id: 'apps',
        k: 'Internal apps',
        v: 'Deploy internal tools and dashboards from your project, with Kortix sign-in built in.',
      },
    ],
  },
  {
    id: 'control',
    eyebrow: '04 · Secure and yours',
    title: 'Everything IT needs to say yes.',
    sub: 'Open source. Read it, fork it, audit it. Run it on Kortix Cloud, in your VPC, or on your own on-prem network, with any model provider and your own keys.',
    points: [
      {
        id: 'permissions',
        k: 'Permissions',
        v: 'Per-resource permissions for people and agents. Roles, groups, and an audit trail.',
      },
      { id: 'sso', k: 'Identity', v: 'SAML 2.0 single sign-on and SCIM 2.0.' },
      {
        id: 'audit',
        k: 'Audit',
        v: 'Every action is recorded. Reading, exporting and streaming the audit log depend on the plan.',
      },
      {
        id: 'secrets',
        k: 'Secrets',
        v: 'Secrets are encrypted at rest with a key per project.',
      },
      {
        id: 'models',
        k: 'Models',
        v: 'Any model provider with your own keys. Or the ChatGPT plan you already pay for.',
      },
      {
        id: 'hosting',
        k: 'Hosting',
        v: 'Run it on Kortix Cloud, in your VPC, or on your own on-prem network. Self-host is free.',
      },
      {
        id: 'compliance',
        k: 'Compliance',
        v: 'SOC 2 Type I is held. SOC 2 Type II is in progress.',
      },
    ],
  },
] as const;

export const build = {
  eyebrow: 'For developers',
  title: 'Build on it from code.',
  sub: 'The same platform from the terminal and from your own product. The CLI drives projects and sessions; the SDK puts a whole session behind one hook in your app.',
  items: [
    { id: 'cli', k: 'CLI', v: 'kortix' },
    { id: 'sdk', k: 'SDK', v: '@kortix/sdk' },
    { id: 'api', k: 'API', v: 'REST and streaming' },
  ],
  cta: 'Read the docs',
  ctaHref: '/docs',
} as const;

