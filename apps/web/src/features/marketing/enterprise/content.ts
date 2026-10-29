import { MARKETING_RELEASE_TRANSLATION_KEYS } from '@/i18n/marketing-release-translation-keys.generated';
import { localizeUiCatalog } from '@kortix/ui/i18n';
/**
 * `/enterprise` copy: the buyer page for a company that runs Kortix across
 * the organization, laid out like the home page: a hero with one walkthrough
 * of the company view, four pillars, one tab per buyer topic, the trust band,
 * the FAQ. Localized. The controls IT reviews (SSO, SCIM, roles,
 * approvals, audit) have their own page, /compliance; isolation and secrets
 * live on /security.
 *
 * Every line was checked on 2026-10-28 against the source named above its
 * block. When code and a doc disagree, the code wins. Standing rules
 * (kortix-brand `claims.md`, positioning.md "Companies" pitch):
 *  - Enterprise is a feature layer on Free or Credits, not a plan that
 *    replaces them (billing skill, references/plans-and-access.md).
 *  - Drive is per project: the Company folder is shared by every member of
 *    the project, not across projects. It is experimental.
 *  - Approval rules are off until you set them. No egress claim, never
 *    "air-gapped". SOC 2 Type I only. SAML 2.0 only.
 *  - No price references (no amounts on budgets either), no unmeasured
 *    metrics, no license names, no customer names, no harness name, no
 *    /services link (flag-gated). Sample data is the fictional Arcadia;
 *    people are initials or "Member N".
 */

/* Hero. Sources: guide.mdx intro ("open-source AI Operating System"),
   "A backend for agents" (triggers run agents 24/7), "A workspace for
   people" (web, desktop, mobile, Slack, Microsoft Teams); claims.md Hosting
   and Models rows. */
export const hero = {
  title: 'One AI Operating System for the whole company.',
  titleMuted: 'Every team’s agents and memory, in one place you own.',
  sub: 'Roll Kortix out team by team. Agents run around the clock on schedules and webhooks, on Kortix Cloud or your own infrastructure, with any model.',
  caption: 'One account for every team.',
  captionMuted: 'Members are unlimited.',
} as const;

export type StepId = 'one' | 'many' | 'always' | 'governed';

export type Step = { readonly id: StepId; readonly label: string; readonly line: string };

/* Steps. Sources:
   one, many: guide.mdx "Agents" (an agent: a job, a model, permissions),
     "Teams → Set it up" (Agents: All agents or Only these…), "Drive"
     (Company folder, Memory read by every project member).
   always: guide.mdx "Automations" (schedule, webhook; each run is a new
     session on its own cloud computer; webhooks from code hosts).
   governed: guide.mdx "Allow, Ask, Block", "How agents' work reaches the
     company repository", "Audit log", "Single sign-on and directory sync". */
export const steps: readonly Step[] = [
  {
    id: 'one',
    label: 'One team',
    line: 'Start with one team and one agent. It works in the tools that team already uses.',
  },
  {
    id: 'many',
    label: 'Every team',
    line: 'Add an agent for each team. Every team’s agents read the same company memory in Drive.',
  },
  {
    id: 'always',
    label: 'Around the clock',
    line: 'Schedules and webhooks start agents with nobody at the keyboard. Each run gets its own cloud computer.',
  },
  {
    id: 'governed',
    label: 'Governed',
    line: 'You decide which actions wait for a person. Every action lands in the audit log.',
  },
];

export type TeamState = {
  readonly line: string;
  readonly chip: string;
  readonly tone: 'ok' | 'wait' | 'no';
};

/** Arcadia's teams, one agent each, and what the card shows at each step. Fictional. */
export const teams: readonly {
  readonly team: string;
  readonly agent: string;
  readonly states: Record<Exclude<StepId, 'one'>, TeamState> & { readonly one: TeamState | null };
}[] = [
  {
    team: 'Support',
    agent: 'support-triage',
    states: {
      one: { line: 'Drafts a reply to each new ticket', chip: 'Live', tone: 'ok' },
      many: { line: 'Drafts a reply to each new ticket', chip: 'Live', tone: 'ok' },
      always: { line: 'Webhook · each new ticket', chip: 'Running', tone: 'ok' },
      governed: { line: 'Refunds wait for a person', chip: 'Ask', tone: 'wait' },
    },
  },
  {
    team: 'Sales',
    agent: 'account-research',
    states: {
      one: null,
      many: { line: 'Researches accounts before calls', chip: 'Live', tone: 'ok' },
      always: { line: 'Schedule · weekdays 07:00', chip: 'Done', tone: 'ok' },
      governed: { line: 'Emails wait for a person', chip: 'Ask', tone: 'wait' },
    },
  },
  {
    team: 'Finance',
    agent: 'month-end',
    states: {
      one: null,
      many: { line: 'Reconciles the month’s invoices', chip: 'Live', tone: 'ok' },
      always: { line: 'Schedule · 1st of the month', chip: 'Scheduled', tone: 'ok' },
      governed: { line: 'Payments are blocked', chip: 'Block', tone: 'no' },
    },
  },
  {
    team: 'Engineering',
    agent: 'code-review',
    states: {
      one: null,
      many: { line: 'Reviews every pull request', chip: 'Live', tone: 'ok' },
      always: { line: 'Webhook · each pull request', chip: 'Running', tone: 'ok' },
      governed: { line: 'Its changes need a person to merge', chip: 'Review', tone: 'wait' },
    },
  },
];

/** guide.mdx "Drive → Memory": the Company folder's Memory, read by every project member. */
export const driveLine = {
  k: 'Drive · Company / Memory',
  v: 'Read by every team’s agents',
} as const;
export const governedLine = 'Every action in the audit log · SAML SSO and SCIM for everyone';

/* Pillars. Sources: guide.mdx intro, "A workspace for people", "Drive",
   "Models" (gateway, budgets), "Security"; claims.md Hosting, Source,
   Models rows; sovereign/content.ts (the same images). */
export const pillars = {
  title: 'Why companies standardize on Kortix.',
  titleMuted: 'One platform, on your terms.',
  items: [
    {
      id: 'platform',
      name: 'One platform for every team',
      line: 'Every team’s agents in one place.',
      facts: [
        'An agent for each team’s work',
        'Shared Drive and memory',
        'Web, desktop, mobile, Slack and Teams',
      ],
    },
    {
      id: 'infra',
      name: 'Runs where you need it',
      line: 'Kortix Cloud, your VPC or on-prem.',
      facts: [
        'Open source',
        'The same images in every deployment',
        'Your company is a git repository',
      ],
    },
    {
      id: 'models',
      name: 'Any model',
      line: 'Your keys, your plan, your limits.',
      facts: [
        'Any provider with your own keys',
        'A model per agent',
        'Budgets per day, week or month',
      ],
    },
    {
      id: 'governed',
      name: 'Governed from day one',
      line: 'Sign-in, roles, approvals, audit.',
      facts: ['SAML 2.0 SSO and SCIM 2.0', 'Approval rules you set', 'Every action recorded'],
    },
  ],
} as const;

/* Topics, one tab each.
   rollout: guide.mdx "Agents", "Teams" (grant a project, Agents: All agents
     or Only these…, groups; members unlimited), "Drive" (Company folder,
     Memory, experimental).
   infra: claims.md Hosting row; sovereign/content.ts (one Docker Compose
     stack, the same images); developers.mdx "The git origin" (clone);
     guide.mdx "Run Kortix on your own infrastructure" (sessions on Platinum).
   models: guide.mdx "Models" (managed, own keys, ChatGPT; per project, agent,
     session; gateway budgets, access rules, cost reports; Costs: per day,
     week or month, Block or Warn only; 80% and 100% emails; Routing: up to
     8 fallback models).
   governance: guide.mdx "Security" (SSO, SCIM, Audit log), "Allow, Ask,
     Block"; claims.md Approval gates row.
   build: guide.mdx "A backend for agents" (REST API, CLI, @kortix/sdk,
     @kortix/ui), "Apps" (an agent builds and deploys an App);
     developers.mdx Quickstart (kortix init, kortix ship).
   work: pricing-plans.ts Enterprise features (SLA, DPA, dedicated support);
     billing plans-and-access.md (Demo state; contract collection: invoice,
     checkout by card, manual); packages/ui access-shared.ts (an owner or
     admin can turn on the Enterprise demo). */
export const topics = {
  title: 'How it works.',
  titleMuted: 'From the first team to the whole company.',
  tabs: [
    {
      id: 'rollout',
      title: 'Roll out team by team',
      description: 'Start with one team. Add the next.',
      body: [
        'Each agent has a job, its skills and the connectors it may use. Grant each team its project and the agents it may run.',
        'Drive gives people and agents shared folders. The company’s memory lives there as Markdown files every project member can read.',
      ],
    },
    {
      id: 'infra',
      title: 'Your infrastructure',
      description: 'Kortix Cloud, your VPC or on-prem.',
      body: [
        'Run Kortix on Kortix Cloud, in your VPC, or on your own on-prem network. Self-hosting is one Docker Compose stack.',
        'Your agents, skills and memory are files in a git repository you own. Clone it any time.',
      ],
    },
    {
      id: 'models',
      title: 'Models and spend control',
      description: 'Any model, with limits you set.',
      body: [
        'Use Kortix-managed models, your own provider keys, or a ChatGPT subscription. Pick a model per project, per agent or per session.',
        'Every request goes through the Kortix LLM gateway. Set budgets, and block new requests or warn at the limit.',
      ],
    },
    {
      id: 'governance',
      title: 'Governance in one place',
      description: 'Sign-in, roles, approvals and audit.',
      body: [
        'People sign in through your identity provider, and your directory keeps groups in sync. Approval rules hold the actions you choose for a person.',
        'Every action lands in an audit log you can export or stream.',
      ],
    },
    {
      id: 'build',
      title: 'Build on it',
      description: 'API, CLI, SDK and UI kit.',
      body: [
        'The REST API, the CLI, @kortix/sdk and @kortix/ui reach every project and session. Build your own apps on the same backend.',
        'Agents build and deploy Apps too: websites, internal tools and backends your project hosts.',
      ],
    },
    {
      id: 'work',
      title: 'Working with us',
      description: 'A demo, a contract, a team behind it.',
      body: [
        'Try it first: an owner or admin can turn on the Enterprise demo in your own account.',
        'An Enterprise contract adds an SLA, a DPA and dedicated support.',
      ],
    },
  ],
} as const;

export type TopicId = (typeof topics.tabs)[number]['id'];

/** guide.mdx "Drive → Folders" and "Memory". Fictional file names. */
export const driveTree = [
  { path: 'Company/Memory/', note: 'every project member' },
  { path: 'Company/Memory/customers.md', note: '' },
  { path: 'Company/Memory/conventions.md', note: '' },
  { path: 'Support/', note: 'shared with the Support group' },
  { path: 'My files/', note: 'only you' },
] as const;

/** claims.md Hosting row; security-page/model.ts trust cells. */
export const deployments = [
  { k: 'Kortix Cloud', v: 'We run the platform and the cloud computers.' },
  { k: 'Self-hosted', v: 'The app, the API and the database on your server.' },
  { k: 'Your VPC or on-prem', v: 'A single-tenant deployment, scoped with us.' },
] as const;

/** guide.mdx "Models → Set a budget", "Fallback models". No amounts. */
export const spendRows = [
  { k: 'Budget per day, week or month', v: 'Per project' },
  { k: 'At the limit', v: 'Block, or warn only' },
  { k: 'Alerts', v: 'Email at 80% and 100%' },
  { k: 'Fallback models', v: 'Up to 8, tried in order' },
] as const;

export const governanceRows = [
  { k: 'Sign-in', v: 'SAML 2.0 single sign-on, two-factor' },
  { k: 'Directory', v: 'SCIM 2.0 members and groups' },
  { k: 'Access', v: 'Account and project roles, groups, custom roles' },
  { k: 'Approvals', v: 'Allow, Ask or Block per action' },
  { k: 'Audit', v: 'Export as CSV or JSONL, or stream it' },
] as const;

/** developers.mdx Quickstart. */
export const buildLines = {
  title: 'Terminal',
  lines: [
    '# your company as code',
    '$ kortix init arcadia',
    '$ kortix ship',
    '',
    '# start agent work from a script',
    '$ kortix sessions new',
  ],
} as const;

/** How an Enterprise account starts. plans-and-access.md (Demo, contracts). */
export const workSteps = [
  { k: 'Talk to us', v: 'A call with our team about your rollout.' },
  { k: 'Try it', v: 'Turn on the Enterprise demo in your own account.' },
  { k: 'Sign', v: 'A contract, paid by invoice or by card.' },
  { k: 'Roll out', v: 'Connect your identity provider, then add teams.' },
] as const;

/* Trust band. Sources: claims.md Hosting, Source, Compliance rows. */
export const trust = {
  title: 'Ready for your security review.',
  titleMuted: 'Run it where your policy says, and read every line.',
  cells: [
    { k: 'Kortix Cloud', v: 'We run the platform and the cloud computers.' },
    { k: 'Self-hosted', v: 'The app, the API and the database on your server.' },
    { k: 'Your VPC or on-prem', v: 'A single-tenant deployment, scoped with us.' },
    { k: 'Open source', v: 'Read it, fork it, audit it.' },
  ],
  seal: 'SOC 2 Type I verified',
  sealNote: 'GDPR operated. The compliance and security pages have the detail.',
} as const;

/* FAQ. Sources per answer:
   rollout: guide.mdx "Teams" (team account, grants, groups, members
     unlimited).
   where: claims.md Hosting row and air-gapped rule; developers.mdx "What
     runs where" (sessions on Platinum).
   models: claims.md Models and Managed models rows; custom-providers.ts.
   spend: guide.mdx "Models → Set a budget".
   own: developers.mdx "The git origin", "Delete"; sovereign/content.ts FAQ.
   what: guide.mdx "Billing → Enterprise"; pricing-plans.ts; plans-and-access.md
     principles 1–2.
   try: plans-and-access.md Demo row; packages/ui access-shared.ts.
   support: pricing-plans.ts; plans-and-access.md License contracts.
   sso: claims.md SSO row; guide.mdx "Single sign-on and directory sync".
   approvals: claims.md Approval gates row. */
export const faqItems = [
  {
    id: 'enterprise-rollout',
    question: 'How do we roll Kortix out across the company?',
    answer:
      'Create a team account, start with one team’s project and agents, then grant the next team its project and the agents it may run. Groups grant access to many people at once. Members are unlimited.',
  },
  {
    id: 'enterprise-where',
    question: 'Where can Kortix run?',
    answer:
      'On Kortix Cloud, in your VPC, or on your own on-prem network. Sessions run on Platinum cloud computers in every topology. For an isolated topology, talk to us: we scope it with you.',
  },
  {
    id: 'enterprise-models',
    question: 'Which models can we use?',
    answer:
      'Any model provider with your own keys, the ChatGPT plan you already pay for, or any OpenAI-compatible endpoint. On Kortix Cloud you can also use Kortix-managed open-weight models (DeepSeek, GLM), served with zero data retention.',
  },
  {
    id: 'enterprise-spend',
    question: 'How do we keep model spend under control?',
    answer:
      'Set a budget per day, week or month on each project. At the limit, Kortix blocks new requests or only warns, as you choose. Owners, admins and project managers get an email at 80% and at 100%.',
  },
  {
    id: 'enterprise-own',
    question: 'Who owns our agents and data?',
    answer:
      'You do. Your agents, skills and memory are files in a git repository you can clone with any git client. Deleting a project never deletes a GitHub repository you connected.',
  },
  {
    id: 'enterprise-what',
    question: 'What does Enterprise add?',
    answer:
      'Single sign-on, directory sync, groups and custom roles, reading, exporting and streaming the audit log, and your own branding. It turns these on for an account on Free or Credits. A contract also removes the project limit.',
  },
  {
    id: 'enterprise-try',
    question: 'Can we try it before we sign?',
    answer:
      'Yes. An owner or admin can turn on the Enterprise demo in Account settings. It turns on SSO, SCIM, roles, audit and branding in your own account, and lets our team know.',
  },
  {
    id: 'enterprise-support',
    question: 'What comes with an Enterprise contract?',
    answer:
      'An SLA, a DPA and dedicated support. You pay by invoice or by card. If a contract ends, single sign-on and directory sync stay on for 14 days, so nobody is locked out.',
  },
  {
    id: 'enterprise-sso',
    question: 'Does Kortix work with our identity provider?',
    answer:
      'Sign-in uses SAML 2.0, and directory sync uses SCIM 2.0. The compliance page has the detail.',
  },
  {
    id: 'enterprise-approvals',
    question: 'Do agents ask for approval by default?',
    answer:
      'No. Approval rules are off until you set them. Mark an action Ask, and those calls wait for a person.',
  },
] as const;

export function localizeMarketingContent(tMarketing: import('@/i18n/translator').UiTranslator) {
  return localizeUiCatalog(
    {
      hero,
      steps,
      teams,
      driveLine,
      governedLine,
      pillars,
      topics,
      driveTree,
      deployments,
      spendRows,
      governanceRows,
      buildLines,
      workSteps,
      trust,
      faqItems,
    },
    tMarketing,
    MARKETING_RELEASE_TRANSLATION_KEYS,
  );
}
