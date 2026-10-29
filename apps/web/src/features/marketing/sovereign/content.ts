import { MARKETING_RELEASE_TRANSLATION_KEYS } from '@/i18n/marketing-release-translation-keys.generated';
import { localizeUiCatalog } from '@kortix/ui/i18n';
/**
 * `/sovereign` copy, laid out like the home page: a hero with one walkthrough,
 * four pillars, one tab per topic, the no-lock-in band, the FAQ. Localized.
 *
 * Every line was checked on 2026-10-28 against the source named above its
 * block. Standing rules (kortix-brand `claims.md`):
 *  - Never name a license: "open source" and stop.
 *  - Never "air-gapped". Sessions and Drive run on Platinum in every
 *    topology, and a self-hosted instance must be reachable from the internet.
 *  - Model families only, never versions. Managed models are open-weight
 *    (DeepSeek, GLM), served with zero data retention, and never on a
 *    self-hosted instance. Say nothing about where managed inference runs.
 *  - No egress filtering claim: Kortix does not filter outbound traffic.
 *  - No price references. No harness name ("an open-source agent harness").
 *  - Sample data uses the fictional Arcadia.
 */

/* Hero. Sources: claims.md rows Source, Hosting, Models, Harness;
   developers.mdx "Self-hosting" (Install by hand, the `start` output is
   apps/cli/src/commands/self-host.ts:546-548), "Your project's repository",
   "The git origin", "Clone a project", "What a new project contains";
   guide.mdx "Models"; apps/api/src/projects/routes/custom-providers.ts
   (any OpenAI-compatible base URL); self-hosted/content.ts parity (the same
   images). */
export const hero = {
  title: 'Sovereign and open.',
  titleMuted: 'Open source, on your infrastructure, with any model.',
  sub: 'Read every line of Kortix. Run it on Kortix Cloud, in your VPC or on your own on-prem network. Bring any model with your own keys, and keep your company in a git repository you own.',
  github: { label: 'View on GitHub', href: 'https://github.com/kortix-ai/suna' },
  selfHost: { label: 'Self-host Kortix', href: '/self-hosted' },
  caption: 'Kortix Cloud or your own server.',
  captionMuted: 'The same images either way.',
} as const;

export type Step = {
  readonly id: 'code' | 'server' | 'models' | 'files';
  readonly label: string;
  readonly line: string;
};

export const steps: readonly Step[] = [
  {
    id: 'code',
    label: 'Read the code',
    line: 'The web app, the API, the LLM gateway, the CLI and the SDK live in one public repository.',
  },
  {
    id: 'server',
    label: 'Run it yourself',
    line: 'One command brings up the full stack on a server you control.',
  },
  {
    id: 'models',
    label: 'Pick any model',
    line: 'Any provider with your own keys, the ChatGPT plan you already pay for, or your own endpoint.',
  },
  {
    id: 'files',
    label: 'Keep the files',
    line: 'Your agents, skills and memory are files in a git repository. Clone it any time.',
  },
];

/** The public repository's top-level apps (`ls apps packages`). */
export const repoTree = [
  { path: 'apps/web', note: 'the web app' },
  { path: 'apps/api', note: 'the API' },
  { path: 'apps/llm-gateway', note: 'the LLM gateway' },
  { path: 'apps/cli', note: 'the kortix CLI' },
  { path: 'packages/sdk', note: '@kortix/sdk' },
] as const;

/** Install by hand, then the real `start` output. */
export const startLines = [
  '$ curl -fsSL https://kortix.com/install | bash',
  '$ kortix self-host init --domain kortix.example.com',
  '$ kortix self-host start',
  '✓ Self-hosted Kortix is starting',
  '  Dashboard: https://kortix.example.com',
] as const;

/** Model sources. Families only; a self-hosted instance has no managed models. */
export const modelSources = [
  {
    id: 'keys',
    k: 'Your own keys',
    v: 'GPT, Claude, Gemini, Mistral, DeepSeek and more',
    tag: 'Any provider',
  },
  { id: 'chatgpt', k: 'ChatGPT plan', v: 'The plan you already pay for', tag: 'Subscription' },
  { id: 'custom', k: 'Your endpoint', v: 'Any OpenAI-compatible base URL', tag: 'Custom' },
  {
    id: 'managed',
    k: 'Kortix-managed',
    v: 'Open-weight DeepSeek and GLM, zero data retention',
    tag: 'Kortix Cloud',
  },
] as const;

/** `kortix projects clone`, then the starter's top level. */
export const cloneLines = [
  '$ kortix projects clone <project_id> arcadia',
  '$ ls arcadia',
  'kortix.yaml  agents/  skills/  memory/  README.md',
] as const;

/* Pillars. Sources: claims.md rows Source, Harness, Hosting, Models,
   Secrets encrypted; developers.mdx "Self-hosting", "Updates and versions",
   "The git origin"; guide.mdx "Models". */
export const pillars = {
  title: 'Four things stay yours.',
  titleMuted: 'The code, the servers, the models and the files.',
  items: [
    {
      id: 'code',
      name: 'Open source',
      line: 'Read it, fork it, audit it.',
      facts: [
        'The whole platform in one public repository',
        'An open-source agent harness',
        'No black box to trust',
      ],
    },
    {
      id: 'infra',
      name: 'Your infrastructure',
      line: 'Kortix Cloud, your VPC or on-prem.',
      facts: [
        'One Docker Compose stack',
        'The same images Kortix Cloud runs',
        'Updates daily, or pin a version',
      ],
    },
    {
      id: 'models',
      name: 'Any model',
      line: 'Your providers, your keys.',
      facts: [
        'Any provider with your own keys',
        'Your ChatGPT plan',
        'A model per agent or per session',
      ],
    },
    {
      id: 'files',
      name: 'Your files',
      line: 'A git repository you own.',
      facts: [
        'Agents, skills and memory as files',
        'Clone it with any git client',
        'Secret values stay out of git',
      ],
    },
  ],
} as const;

/* Topics, one tab each.
   where: developers.mdx "Self-hosting" intro and "What runs where" (Off the
     box: sandboxes, Drive volumes); guide.mdx "Run Kortix on your own
     infrastructure"; guide.mdx Models (no managed models on self-host).
   install: developers.mdx "Install by hand", "Evaluate with a Cloudflare
     tunnel", "Reachability modes" (Caddy TLS in domain mode), "Check the
     instance" (doctor).
   updates: developers.mdx "Updates and versions".
   models: guide.mdx "Models" (gateway sentence, "Which model a session
     uses"); claims.md Models and Managed models rows; custom-providers.ts.
   files: developers.mdx "Your project's repository", "The git origin",
     "Clone a project", "Browse without a clone", "Delete".
   secrets: developers.mdx "env keys", agent `secrets` grant, the kortix.yaml
     warning callout; claims.md rows Secrets encrypted, Connector credentials. */
export const topics = {
  title: 'How it works.',
  titleMuted: 'What runs where, and what you control.',
  tabs: [
    {
      id: 'where',
      title: 'What runs where',
      description: 'Your server, or Kortix Cloud.',
      body: [
        'Self-hosting puts the web app, the API, the LLM gateway and the database on your server.',
        'Sessions and Drive still run on Platinum sandboxes. They call back to your instance, so it must be reachable from the internet.',
      ],
    },
    {
      id: 'install',
      title: 'Self-host with one CLI',
      description: 'One Docker Compose stack.',
      body: [
        'The kortix CLI installs, configures, updates and checks the stack.',
        'Point a domain at your server for production, with TLS. Or try it on your own machine through a Cloudflare tunnel.',
      ],
    },
    {
      id: 'updates',
      title: 'Updates on your terms',
      description: 'Daily, or pin a version.',
      body: [
        'The updater checks once a day, migrates the database, then swaps the services.',
        'If a migration fails, nothing is swapped and the previous version keeps serving. A pinned version holds through every daily run.',
      ],
    },
    {
      id: 'models',
      title: 'Any model, set where you need it',
      description: 'Your keys, your plan, your endpoint.',
      body: [
        'Every model request goes through the Kortix LLM gateway, which applies budgets, access rules and cost reports.',
        'Set a project default, a model per agent, or a model for one session.',
      ],
    },
    {
      id: 'files',
      title: 'Your company is a repository',
      description: 'Clone it, download it, keep it.',
      body: [
        'Every project is a git repository: Kortix-managed, or yours on GitHub.',
        'Any git client clones it over HTTPS. Deleting a project leaves a GitHub repository you connected untouched.',
      ],
    },
    {
      id: 'secrets',
      title: 'Secret values stay out of git',
      description: 'Names in the repo, values encrypted.',
      body: [
        'kortix.yaml names the secrets a project needs. The values live in Kortix, encrypted at rest with a key per project.',
        'Connector credentials are brokered server-side and never enter the machine.',
      ],
    },
  ],
} as const;

export type TopicId = (typeof topics.tabs)[number]['id'];

/** developers.mdx "What runs where" and "Off the box". */
export const whereRows = [
  { k: 'Web app, API, LLM gateway', cloud: 'Kortix', self: 'Your server' },
  { k: 'Database and file storage', cloud: 'Kortix', self: 'Your server' },
  { k: 'Accounts, secrets, audit log', cloud: 'Kortix', self: 'Your server' },
  { k: 'Sessions', cloud: 'Platinum', self: 'Platinum' },
  { k: 'Drive', cloud: 'Platinum', self: 'Platinum' },
  { k: 'Models', cloud: 'Managed or yours', self: 'Yours' },
] as const;

export const installLines = [
  '# production: your domain, with TLS',
  '$ kortix self-host init --domain kortix.example.com',
  '$ kortix self-host start',
  '',
  '# evaluate on your own machine',
  '$ kortix self-host init --tunnel cloudflare',
  '$ kortix self-host start',
  '',
  '# check every part of the instance',
  '$ kortix self-host doctor',
] as const;

export const updateTracks = [
  { k: 'stable', tag: 'default', v: 'A release Kortix promotes after it runs in production.' },
  { k: 'latest', tag: '', v: 'Every Kortix release.' },
  { k: '--tag <version>', tag: '', v: 'One exact version. A pin wins over the channel.' },
] as const;

/** guide.mdx "Which model a session uses", in order. */
export const modelOrder = [
  'The session, channel or automation',
  'The agent',
  'The project default',
  'The account default',
  'The platform default',
] as const;

export const filesLines = [
  '# with the kortix CLI',
  '$ kortix projects clone <project_id> arcadia',
  '',
  '# with any git client',
  '$ git clone https://api.kortix.com/v1/git/<project_id>.git',
  '',
  '# as a zip',
  '$ kortix files download -o arcadia.zip',
] as const;

export const secretsYaml = {
  title: 'kortix.yaml',
  lines: [
    '# names only, never values',
    'env:',
    '  required:',
    '    - HELPDESK_API_KEY',
    'agents:',
    '  support:',
    '    secrets: [HELPDESK_API_KEY]',
  ],
} as const;

/* No lock-in band. Sources: claims.md rows Source, Hosting, Models;
   developers.mdx "The git origin"; claims.md "air-gapped" rule (isolated
   topologies are scoped with the customer). */
export const lockIn = {
  title: 'No lock-in.',
  titleMuted: 'Your code, your servers, your models, your files.',
  cells: [
    { k: 'Code', v: 'Open source. Read it, fork it, audit it.' },
    { k: 'Infrastructure', v: 'Kortix Cloud, your VPC or your own on-prem network.' },
    { k: 'Models', v: 'Any model provider, with your own keys.' },
    { k: 'Company', v: 'A git repository any git client can clone.' },
  ],
  isolated: 'Need an isolated topology?',
  isolatedNote: 'We scope it with you.',
} as const;

/* FAQ. Sources per answer: claims.md Source and Harness rows; developers.mdx
   "What runs where"; claims.md "air-gapped" rule and developers.mdx (images
   from Docker Hub, the sandbox calls back); guide.mdx "Models" and
   developers.mdx "First sign-in and setup" step 5; developers.mdx "The git
   origin", "Browse without a clone", "Delete"; developers.mdx "Configure"
   (Enterprise turns on SSO, SCIM, role-based access control and audit);
   developers.mdx "Updates and versions". */
export const faqItems = [
  {
    id: 'open-source',
    question: 'Is Kortix open source?',
    answer:
      'Yes. The web app, the API, the LLM gateway, the CLI and @kortix/sdk live in one public repository, kortix-ai/suna. Every new session runs an open-source agent harness.',
  },
  {
    id: 'self-host-where',
    question: 'What runs on my server when I self-host?',
    answer:
      'The web app, the API, the LLM gateway, the database, file storage and the updater, as one Docker Compose stack. Sessions and Drive run on Platinum sandboxes, which call back to your instance.',
  },
  {
    id: 'air-gapped',
    question: 'Can Kortix run air-gapped?',
    answer:
      'No. The stack pulls its images from Docker Hub, and sessions run on Platinum sandboxes that must reach your instance from the internet. For an isolated topology, talk to us: we scope it with you.',
  },
  {
    id: 'models',
    question: 'Which models can I use?',
    answer:
      'Any model provider with your own keys, the ChatGPT plan you already pay for, or any OpenAI-compatible endpoint. On Kortix Cloud you can also use Kortix-managed open-weight models (DeepSeek, GLM), served with zero data retention.',
  },
  {
    id: 'managed-self-host',
    question: 'Are Kortix-managed models available when I self-host?',
    answer:
      'No. A self-hosted Kortix has no managed models. Each project connects its own providers, and a project can connect Platinum as its provider with a Platinum API key.',
  },
  {
    id: 'leave',
    question: 'Can I take my company with me?',
    answer:
      'Yes. Your agents, skills and memory are files in a git repository. Clone it with any git client, or download it as a zip with kortix files download. Deleting a project never deletes a GitHub repository you connected.',
  },
  {
    id: 'enterprise',
    question: 'Do Enterprise features work on a self-hosted instance?',
    answer:
      'Yes, with Enterprise. It turns on single sign-on, SCIM, role-based access control and audit for every account on the instance.',
  },
  {
    id: 'updates',
    question: 'How do updates work when I self-host?',
    answer:
      'The updater runs once a day at a time you set. Track stable, which Kortix promotes after it runs in production, or latest, or pin one exact version. A failed migration swaps nothing.',
  },
] as const;

export function localizeMarketingContent(tMarketing: import('@/i18n/translator').UiTranslator) {
  return localizeUiCatalog(
    {
      hero,
      steps,
      repoTree,
      startLines,
      modelSources,
      cloneLines,
      pillars,
      topics,
      whereRows,
      installLines,
      updateTracks,
      modelOrder,
      filesLines,
      secretsYaml,
      lockIn,
      faqItems,
    },
    tMarketing,
    MARKETING_RELEASE_TRANSLATION_KEYS,
  );
}
