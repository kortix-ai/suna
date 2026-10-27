/**
 * Copy for the landing sections under the hero.
 *
 * Every claim below is a sentence from `kortix-brand` verbal/claims.md
 * (section 2), shortened by deletion only, or a fact from the project docs
 * (`content/docs/project/index.mdx`, "Repository layout" and "Memory"). The
 * FAQ is not here: it is imported from `faq/content.ts`, whose accuracy gate
 * and translations stay where they are.
 *
 * Do not add, in this file or in the sections it feeds:
 *   - a licence name ("open source" and stop);
 *   - a number other than "20,000+ GitHub stars" (claims.md allows "3,000+
 *     apps" on the agent-computer page only);
 *   - "microVM", "container" or "air-gapped";
 *   - "secrets never enter the machine": only CONNECTOR credentials don't;
 *   - "only a human can merge" or "gates are on": merge is default-deny for
 *     agents and approval gates are off until you set them;
 *   - a SOC 2 line without its Type.
 *
 * New English strings have no translation key yet, so every locale shows the
 * English until `marketing` keys are generated for them.
 */

export const stack = {
  title: 'One repo runs the company.',
  titleMuted: 'You own every file.',
  description:
    'Your agents, skills, company memory and connectors live in one git repo you own. Each session works on its own branch and sends its changes back as a change request.',
  /** The starter repo, as `kortix init` writes it. Real paths, four lines. */
  tree: ['kortix.yaml', 'agents/kortix.md', 'skills/pdf/SKILL.md', 'memory/MEMORY.md'],
  layers: [
    {
      id: 'repo',
      title: 'The repo is the company.',
      description:
        'Agents, skills, memory, connector config and triggers are text in one git repo you own. Diff any change and roll any part of it back.',
    },
    {
      id: 'memory',
      title: 'Memory is files.',
      description:
        'memory/ holds what the project knows about itself: its purpose, conventions and decisions. Agents read the index at the start of a task and edit it like any other file.',
    },
    {
      id: 'agents',
      title: 'Agents and skills are files too.',
      description:
        'An agent is agents/<name>.md plus its block in kortix.yaml, which says what it may use. A skill is one SKILL.md plus the reference files beside it.',
    },
    {
      id: 'connectors',
      title: 'Connect the tools you already run on.',
      description:
        'Connect apps in a click, or bring MCP, OpenAPI, Postman, GraphQL and raw HTTP. Connector credentials are brokered server-side and never enter the machine.',
    },
    {
      id: 'computer',
      title: 'Every session gets its own computer.',
      description:
        'Each session gets its own isolated machine and git branch. Your repo and your tools are already on it.',
    },
    {
      id: 'change-request',
      title: 'Work lands as a change request.',
      description:
        'Session work reaches main through a change request. Merge is default-deny for agents.',
    },
  ],
} as const;

export const security = {
  title: 'Agents get real access.',
  titleMuted: 'You set the limits.',
  description:
    'Every session runs on its own isolated machine, and session work reaches main through a change request.',
  ctaLabel: 'How Kortix is secured',
  ctaHref: '/security',
  controls: [
    {
      id: 'sandbox',
      title: 'Isolated sandboxes',
      description: 'One machine and one branch per session.',
    },
    {
      id: 'sso',
      title: 'Single sign-on',
      description: 'SAML 2.0 single sign-on and SCIM 2.0.',
    },
    {
      id: 'roles',
      title: 'Roles and permissions',
      description:
        'Per-resource permissions for people and agents. Roles, groups, and an audit trail.',
    },
    {
      id: 'secrets',
      title: 'Secrets',
      description:
        'Secrets are encrypted at rest with a key per project. Connector credentials never enter the machine.',
    },
    {
      id: 'audit',
      title: 'Audit trail',
      description:
        'Every action is recorded. Reading, exporting and streaming the audit log depend on the plan.',
    },
    {
      id: 'gates',
      title: 'Approval gates',
      description: 'Allow, ask or block per action. Off until you set them.',
    },
    {
      id: 'hosting',
      title: 'Where it runs',
      description:
        'Run it on Kortix Cloud, in your VPC, or on your own on-prem network. Self-host is free.',
    },
    {
      id: 'compliance',
      title: 'Compliance',
      description:
        'SOC 2 Type I is held. SOC 2 Type II is in progress. GDPR is a posture Kortix runs, not a certificate.',
    },
  ],
} as const;

export const openSourceLine = {
  title: '20,000+ GitHub stars.',
  titleMuted: 'Open source. Read it, fork it, audit it.',
  ctaLabel: 'Read the source',
  ctaHref: 'https://github.com/kortix-ai/suna',
} as const;

export const faqHeading = {
  title: 'The questions people ask.',
  titleMuted: 'Answered plainly.',
} as const;
