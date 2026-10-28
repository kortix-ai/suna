/**
 * `/sovereign` copy: everything that makes Kortix yours.
 *
 * ACCURACY GATE. Every sentence traces to one of these sources (2026-10-28):
 *  - `.agents/skills/kortix-brand/references/verbal/claims.md` section 2 rows:
 *    Source, Harness, Hosting, Models, Managed models, Secrets encrypted,
 *    Connector credentials, One sandbox per session, Audit, SSO, Compliance.
 *  - `apps/web/content/docs/guide.mdx`: "A backend for agents", Drive, Models,
 *    Security ("Run Kortix on your own infrastructure").
 *  - `apps/web/content/docs/developers.mdx`: "Your project's repository",
 *    "The git origin", "Browse without a clone", "Delete", "Self-hosting"
 *    ("What runs where").
 *  - `apps/web/src/features/marketing/self-hosted/content.ts` (parity, updates).
 *
 * Rules held here:
 *  - Never name a license: "open source" and stop.
 *  - Not air-gapped. Sessions and Drive run on Platinum in every topology, and
 *    a self-hosted instance must be reachable so the sandbox can call back.
 *  - Managed models: families only, never versions, never where they run. A
 *    self-hosted Kortix has no managed models.
 *  - SOC 2 Type I only. No price references.
 */

export const hero = {
  title: 'Sovereign and open.',
  titleMuted: 'Everything that makes Kortix yours.',
  sub: 'Kortix is open source. Run it on Kortix Cloud, in your VPC or on your own on-prem network, with any model and your own keys. Your agents, skills and memory are files in a git repository you own.',
  ctaPrimary: { label: 'Self-host Kortix', href: '/self-hosted' },
  ctaSecondary: { label: 'View on GitHub', href: 'https://github.com/kortix-ai/suna' },
} as const;

export const open = {
  title: 'Open source.',
  titleMuted: 'Read it, fork it, audit it.',
  rows: [
    {
      id: 'platform',
      k: 'The whole platform',
      v: 'The web app, the API, the LLM gateway, the CLI and `@kortix/sdk` live in one public repository: `kortix-ai/suna`.',
    },
    {
      id: 'harness',
      k: 'An open-source agent harness',
      v: 'Every new session runs an open-source agent harness.',
    },
    {
      id: 'code',
      k: 'No black box',
      v: 'Everything is code you own. `grep` your whole company.',
    },
  ],
} as const;

export const infra = {
  title: 'Your infrastructure.',
  titleMuted: 'Kortix Cloud, your VPC, or your own on-prem network.',
  sub: 'Self-hosting runs the full Kortix platform on a server you control. The table shows what runs where.',
  docs: { label: 'Read the self-hosting docs', href: '/docs/developers#self-hosting' },
  columns: ['Kortix Cloud', 'Self-hosted'] as const,
  /** developers.mdx "What runs where"; guide.mdx Models (no managed models on self-host). */
  where: [
    { id: 'app', k: 'Web app, API and LLM gateway', cloud: 'Kortix', self: 'Your server' },
    { id: 'db', k: 'Database and file storage', cloud: 'Kortix', self: 'Your server' },
    { id: 'control', k: 'Accounts, secrets, policies and the audit record', cloud: 'Kortix', self: 'Your server' },
    { id: 'sessions', k: 'Sessions', cloud: 'A Platinum sandbox each', self: 'A Platinum sandbox each' },
    { id: 'drive', k: 'Drive', cloud: 'Platinum', self: 'Platinum' },
    { id: 'models', k: 'Models', cloud: 'Kortix-managed or your providers', self: 'Your providers' },
  ],
  rows: [
    {
      id: 'start',
      k: '`kortix self-host start`',
      v: 'One command brings up one Docker Compose stack on your server.',
    },
    {
      id: 'images',
      k: 'The same images',
      v: 'Self-hosted instances run the same images the managed cloud runs.',
    },
    {
      id: 'updates',
      k: 'Updates',
      v: 'Nightly, or pin a version.',
    },
    {
      id: 'reach',
      k: 'Not air-gapped',
      v: 'Sessions run on Platinum sandboxes and call back to your instance, so it must be reachable from the internet. We scope isolated topologies with you.',
    },
  ],
} as const;

export const models = {
  title: 'Any model.',
  titleMuted: 'Your keys, per agent, per session.',
  sub: 'Every model request goes through the Kortix LLM gateway, which applies budgets, access rules and cost reports.',
  items: [
    {
      id: 'keys',
      k: 'Your own keys',
      v: 'Any model provider with your own keys. Your provider bills the requests.',
    },
    {
      id: 'chatgpt',
      k: 'Your ChatGPT plan',
      v: 'Or the ChatGPT plan you already pay for.',
    },
    {
      id: 'managed',
      k: 'Kortix-managed models',
      v: 'Kortix-managed open-weight models (DeepSeek, GLM), served with zero data retention.',
    },
    {
      id: 'switch',
      k: 'Switch any time',
      v: 'Set a project default, a model per agent, or a model for one session.',
    },
  ],
} as const;

export const files = {
  title: 'Your company is files.',
  titleMuted: 'In a git repository you own.',
  /** developers.mdx "What a new project contains", trimmed. */
  tree: [
    { path: 'my-project/', note: '' },
    { path: '├── kortix.yaml', note: 'agents, skills, tools, connectors, triggers' },
    { path: '├── agents/', note: 'the prompt of each agent' },
    { path: '├── skills/', note: 'one folder per skill, with a SKILL.md' },
    { path: '└── memory/MEMORY.md', note: 'the project memory' },
  ],
  rows: [
    {
      id: 'repo',
      k: 'Kortix-managed or your GitHub',
      v: 'Kortix hosts the repo for you, or you connect your own on GitHub.',
    },
    {
      id: 'clone',
      k: 'Any git client',
      v: 'The project’s git origin speaks git over HTTPS, so any git client can clone it. `kortix files download` saves the repository as a zip.',
    },
    {
      id: 'memory',
      k: 'Memory is Markdown',
      v: 'What the company knows lives in Drive, as Markdown files in Memory folders.',
    },
    {
      id: 'secrets',
      k: 'Secret values stay out of the repo',
      v: '`kortix.yaml` names the secrets a project needs. The values live encrypted in Kortix.',
    },
    {
      id: 'delete',
      k: 'Your GitHub repository stays put',
      v: 'Deleting a project deletes its managed repository. A repository you connected yourself is left untouched.',
    },
  ],
} as const;

export const data = {
  title: 'Your data and your keys.',
  titleMuted: 'Built to survive a security review.',
  security: { label: 'Read the security page', href: '/security' },
  items: [
    { id: 'secrets', k: 'Secrets, encrypted', v: 'Secrets are encrypted at rest with a key per project.' },
    {
      id: 'connectors',
      k: 'Connector credentials',
      v: 'Connector credentials are brokered server-side and never enter the machine.',
    },
    {
      id: 'sandbox',
      k: 'One sandbox per session',
      v: 'Each session has its own isolated machine and branch.',
    },
    {
      id: 'audit',
      k: 'Audit log',
      v: 'Every action is recorded. Reading, exporting and streaming the audit log depend on the plan.',
    },
    {
      id: 'sso',
      k: 'Single sign-on',
      v: 'SAML 2.0 single sign-on and SCIM 2.0, on Enterprise.',
    },
    { id: 'soc2', k: 'SOC 2', v: 'SOC 2 Type I verified.' },
  ],
} as const;

export const lockIn = {
  title: 'No lock-in.',
  titleMuted: 'Your data, your models, your infrastructure.',
  specs: [
    { k: 'Code', v: 'Open source' },
    { k: 'Infrastructure', v: 'Kortix Cloud, your VPC or on-prem' },
    { k: 'Models', v: 'Any provider, your own keys' },
    { k: 'Company', v: 'A git repository you can clone' },
  ],
} as const;
